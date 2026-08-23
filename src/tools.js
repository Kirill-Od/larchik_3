import { z } from 'zod';
import { probeCapabilities, registerAnalyticsTools } from './analytics.js';
import { runQuery } from './db.js';
import { toToolResult } from './errors.js';
import { describeTable, enrichSqlError, listTables } from './introspect.js';

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

const asJson = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

/**
 * One place where a thrown error becomes a tool result, so every tool reports failure in the
 * same shape and nothing reaches the agent unsanitized.
 */
const handled = run => (...args) => {
    try {
        return asJson(run(...args));
    } catch (err) {
        return toToolResult(err);
    }
};

export function registerTools(server, { db }) {
    server.registerTool(
        'list_tables',
        {
            title: 'List tables',
            description: [
                'List every table and view in the database with its row count and column summary.',
                '',
                'WHEN TO USE: call this first, before anything else, on any new question. It is a',
                'cheap orientation call, not a data call — follow it with describe_table for the',
                'tables that look relevant, then run_sql_query once you know the columns.',
                'RETURNS: {tables: [{name, type, row_count, columns}]}, where `columns` is a',
                'one-line "name TYPE, name TYPE, …" summary. `row_count` is null when the count',
                'could not be computed cheaply or the object could not be read, and a `note` on',
                'that row says which. Views are never counted, so their row_count is always null —',
                'this call stays cheap no matter how a view is defined.',
                'LIMITS: takes no parameters and returns no row data; it tells you what exists, not',
                'what is in it. SQLite internal tables (sqlite_sequence and friends) are omitted.',
                'The database is read-only.'
            ].join('\n'),
            inputSchema: {},
            annotations: READ_ONLY_ANNOTATIONS
        },
        handled(() => ({ tables: listTables(db) }))
    );

    server.registerTool(
        'describe_table',
        {
            title: 'Describe table',
            description: [
                'Inspect one table or view: its columns, foreign keys, constraints and sample rows.',
                '',
                'WHEN TO USE: after list_tables, for every table that looks relevant to the',
                'question. Use it to confirm a column exists before writing SQL against it — that',
                'is cheaper than a failed query. If the column you expected is not listed, the data',
                'does not contain it: say so plainly rather than guessing or substituting a',
                'different column.',
                'RETURNS: {name, type, row_count, columns, foreign_keys, check_constraints,',
                'indexes, sql, sample_rows}. `columns` carries type, not_null, primary_key and',
                'default. `foreign_keys` is how you find the join path between tables without trial',
                'and error. `check_constraints` is where a column\'s allowed values are written',
                'down. `sample_rows` shows three real rows, usually the fastest way to see what the',
                'values look like — their format, their units, whether a column is populated at all.',
                'THEY ARE THE FIRST THREE ROWS IN STORAGE ORDER, NOT A REPRESENTATIVE SAMPLE: never',
                'read coverage off them. Three 2026 rows do not mean the table has no 2025 rows. For',
                'a range, run MIN/MAX over the column, or use revenue_by_period, whose',
                '`available_range` reports the real span.',
                'A `note` appears whenever something needs explaining — how the sample was taken, a',
                'view\'s missing sample rows, a source that could not be read, a truncated cell.',
                'LIMITS: describes one object per call; pass a name exactly as list_tables gave it.',
                'Views have no foreign keys, CHECK constraints or indexes of their own and are not',
                'sampled. Sample cells are abbreviated. The database is read-only.'
            ].join('\n'),
            inputSchema: {
                table_name: z
                    .string()
                    .describe('Exact name of the table or view, as returned by list_tables.')
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        handled(({ table_name }) => describeTable(db, table_name))
    );

    server.registerTool(
        'run_sql_query',
        {
            title: 'Run SQL query',
            description: [
                'Run one read-only SQL SELECT against the database and get its rows back.',
                '',
                'WHEN TO USE: any question the other tools do not answer directly — joins,',
                'aggregates, filters, grouping, window functions. Full SQLite SELECT syntax is',
                'available. Confirm your columns with describe_table first; a query against a',
                'column that does not exist costs a whole turn.',
                'WHAT TO PASS: exactly one SELECT, WITH…SELECT or VALUES statement. Do not add your',
                'own LIMIT for paging — pass the `limit` and `offset` parameters instead, which',
                'page without changing your SQL.',
                'RETURNS: {columns, rows, row_count, limit, offset, has_more, notes}. `rows` is an',
                'array of objects keyed by column name. When `has_more` is true, `notes` gives you',
                'the exact next call to make.',
                'DATE COMPARISONS NEED A FULL DATE. order_date and created_at are declared DATETIME, which gives them NUMERIC affinity, so a bare-year literal is coerced to an integer and every stored text date compares as greater: `WHERE order_date < \'2026\'` matches nothing at all, silently. Write `WHERE order_date < \'2026-01-01\'`, or wrap the column — `date(order_date)`, `strftime(\'%Y\', order_date)`.',
                'LIMITS: at most 1000 rows per call (100 by default) — prefer an aggregate over paging through thousands of rows.',
                'Cells longer than 4096 characters are truncated with a marker.',
                'A whole response is capped at about 256 KB, so a very wide SELECT * may return fewer rows than you asked for; `notes` says so and gives the next offset.',
                'The database is read-only: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, PRAGMA, ATTACH and multi-statement input are all refused, and the refusal tells you the read-only equivalent to run instead.',
                'A query that keeps streaming rows is stopped after a few seconds, but this cut-off only applies once rows start arriving.',
                'A plan that computes its whole result first can still run for a long time: a bare COUNT(*) or SUM over a large join is the worst case, returning nothing at all until it is completely done, and ORDER BY, GROUP BY, DISTINCT and UNION behave the same way.',
                'Filter the tables before joining rather than relying on the cut-off.'
            ].join('\n'),
            inputSchema: {
                sql: z
                    .string()
                    .describe('One read-only SQL statement: SELECT, WITH…SELECT or VALUES.'),
                limit: z
                    .number()
                    .int()
                    .optional()
                    .describe('Maximum rows to return, from 1 to 1000. Defaults to 100.'),
                offset: z
                    .number()
                    .int()
                    .optional()
                    .describe('Rows to skip before collecting, 0 or more. Defaults to 0.')
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        ({ sql, limit, offset }) => {
            try {
                return asJson(runQuery(db, sql, { limit, offset }));
            } catch (err) {
                // Enrichment needs the statement that failed, so it happens here rather than
                // inside runQuery: "no such column" becomes a list of the columns that exist.
                return toToolResult(enrichSqlError(err, db, sql));
            }
        }
    );

    // The specialized tools hardcode shop.db's columns, so they are offered only where
    // those columns exist (F3); elsewhere the agent falls back to run_sql_query.
    if (probeCapabilities(db).hasShopSchema) {
        registerAnalyticsTools(server, { db });
    }
}
