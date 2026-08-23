import { coerceRows } from './db.js';
import { AppError, InvalidArgument, SqlError, sanitize } from './errors.js';

const quoteIdent = name => `"${name.replaceAll('"', '""')}"`;

// list_tables is advertised as a cheap orientation call, so no single object may cost
// more than this many rows of work.
const COUNT_CAP = 100_000;

/**
 * Counts rows for tables only, and never scans more than COUNT_CAP of them. Returns null
 * when the table is larger than the cap or cannot be read at all — a failure must degrade
 * to its own row rather than take down the whole listing.
 *
 * Views are deliberately not counted. LIMIT only bounds the work when the query plan can
 * stream, and a view is free to defeat that: measured on a 1000-row table, a triple cross
 * join costs 2 ms, but the same join with ORDER BY costs 19 s and with GROUP BY 170 s,
 * because the sort or the grouping must consume the whole result before any row can be
 * emitted. Worse, the aggregating shapes then return a count *under* the cap, so they look
 * perfectly healthy after a three-minute stall. Since better-sqlite3 is synchronous, that
 * blocks the whole server, and this is the call the agent is told to make first on every
 * question. A count that is only sometimes cheap is the wrong trade here.
 */
function countRows(db, ident, type) {
    if (type !== 'table') {
        return { row_count: null, note: `row count not computed: ${type}s are not counted` };
    }
    try {
        const { n } = db
            .prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${ident} LIMIT ${COUNT_CAP + 1})`)
            .get();
        return n > COUNT_CAP
            ? { row_count: null, note: `row count not computed: more than ${COUNT_CAP} rows` }
            : { row_count: n };
    } catch (err) {
        return { row_count: null, note: `row count unavailable: ${sanitize(err.message)}` };
    }
}

function describeColumns(db, ident) {
    try {
        return db
            .prepare(`PRAGMA table_info(${ident})`)
            .all()
            .map(c => `${c.name} ${c.type}`)
            .join(', ');
    } catch {
        return '';
    }
}

/**
 * The user tables and views, read from sqlite_master at call time so this works on any
 * SQLite file. Both tools go through here, so they can never disagree about what exists.
 */
function listObjects(db) {
    return db
        .prepare(
            // ESCAPE, because LIKE's bare `_` matches any character — 'sqlite_%' alone
            // would also hide a user table named sqliteXtra.
            `SELECT name, type, sql FROM sqlite_master
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY type, name`
        )
        .all();
}

/** Every user table and view with its row count and a one-line column summary. */
export function listTables(db) {
    return listObjects(db).map(({ name, type }) => {
        const ident = quoteIdent(name);
        return {
            name,
            type,
            ...countRows(db, ident, type),
            columns: describeColumns(db, ident)
        };
    });
}

/**
 * Blanks out string literals, quoted identifiers and comments, replacing each with spaces
 * of the same length so byte offsets still line up with the original. Scanning the masked
 * copy means a CHECK inside a literal is not mistaken for a constraint, and parentheses
 * inside literals cannot unbalance the match.
 *
 * This is DDL *description*, not a security boundary — the SQL guard in task 3 needs its
 * own adversarially-correct lexer and must not be built on this.
 */
function maskLiterals(sql) {
    const out = sql.split('');
    const blank = (from, to) => {
        for (let k = from; k <= Math.min(to, sql.length - 1); k++) out[k] = ' ';
    };

    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) { j += 2; continue; }
                    break;
                }
                j++;
            }
            blank(i, j);
            i = j + 1;
        } else if (ch === '[') {
            const close = sql.indexOf(']', i);
            const end = close < 0 ? sql.length - 1 : close;
            blank(i, end);
            i = end + 1;
        } else if (ch === '-' && sql[i + 1] === '-') {
            const nl = sql.indexOf('\n', i);
            const end = nl < 0 ? sql.length - 1 : nl - 1;
            blank(i, end);
            i = end + 1;
        } else if (ch === '/' && sql[i + 1] === '*') {
            const close = sql.indexOf('*/', i + 2);
            const end = close < 0 ? sql.length - 1 : close + 1;
            blank(i, end);
            i = end + 1;
        } else {
            i++;
        }
    }
    return out.join('');
}

/**
 * The CHECK expressions in a CREATE TABLE statement. SQLite exposes no pragma for these,
 * and they are the only place values like the five order statuses are written down, so
 * they have to come out of the stored DDL.
 */
function extractCheckConstraints(sql) {
    if (!sql) return [];

    const masked = maskLiterals(sql);
    const checks = [];
    const pattern = /\bCHECK\s*\(/gi;

    let match;
    while ((match = pattern.exec(masked)) !== null) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let i = open; i < masked.length; i++) {
            if (masked[i] === '(') depth++;
            else if (masked[i] === ')' && --depth === 0) { end = i; break; }
        }
        if (end < 0) break;

        checks.push(sql.slice(open + 1, end).trim());
        pattern.lastIndex = end;
    }
    return checks;
}

const SAMPLE_ROW_COUNT = 3;

// Three sample rows ride along with a schema description, so they get a much tighter cell
// budget than a query result does. Same coercer, different cap — see coerceRows.
const SAMPLE_CELL_CHARS = 200;

function foreignKeys(db, ident) {
    return db
        .prepare(`PRAGMA foreign_key_list(${ident})`)
        .all()
        .map(fk => ({
            column: fk.from,
            references: `${fk.table}(${fk.to})`,
            on_delete: fk.on_delete,
            on_update: fk.on_update
        }));
}

function indexes(db, ident) {
    return db
        .prepare(`PRAGMA index_list(${ident})`)
        .all()
        .map(index => ({
            name: index.name,
            unique: Boolean(index.unique),
            origin: index.origin,
            columns: db
                .prepare(`PRAGMA index_info(${quoteIdent(index.name)})`)
                .all()
                .map(c => c.name)
        }));
}

/**
 * Runs one metadata source, degrading to `fallback` and a note if it throws. list_tables
 * already refuses to let one bad object zero out the listing; describe_table owes the same
 * to an object list_tables advertised. A broken view still has columns, a definition and
 * index facts worth returning — 80% of a description beats an error naming a table the
 * agent has never heard of.
 */
function safely(notes, label, read, fallback) {
    try {
        return read();
    } catch (err) {
        notes.push(`${label} unavailable: ${sanitize(err.message)}`);
        return fallback;
    }
}

function columnsOf(db, ident) {
    return db
        .prepare(`PRAGMA table_info(${ident})`)
        .all()
        .map(c => ({
            name: c.name,
            type: c.type,
            not_null: Boolean(c.notnull),
            primary_key: Boolean(c.pk),
            default: c.dflt_value
        }));
}

function sampleRowsOf(db, ident, notes) {
    const raw = db.prepare(`SELECT * FROM ${ident} LIMIT ${SAMPLE_ROW_COUNT}`).all();
    const { rows, truncatedCells } = coerceRows(raw, SAMPLE_CELL_CHARS);
    // A cell value can forge the truncation marker; the count cannot be forged, so it is
    // the authoritative half and belongs in `note` rather than being discarded.
    if (truncatedCells > 0) {
        notes.push(
            `${truncatedCells} sample cell(s) longer than ${SAMPLE_CELL_CHARS} characters ` +
                'were truncated'
        );
    }
    return rows;
}

/** Thrown when the caller names an object that is not in the database. */
export class UnknownTableError extends InvalidArgument {}

/**
 * Everything an agent needs to write correct SQL against one object without guessing:
 * the real columns, how they relate to other tables, what values a column is allowed to
 * hold, and three actual rows. The sample rows are the point — they are what let a model
 * conclude "there is no geography data here" or "these orders are all from 2026" instead
 * of inventing an answer.
 */
export function describeTable(db, name) {
    const objects = listObjects(db);
    const object = objects.find(o => o.name === name);
    if (!object) {
        throw new UnknownTableError(
            `no such table: ${name}. This database contains: ${objects.map(o => o.name).join(', ')}.`
        );
    }

    const ident = quoteIdent(name);
    const isTable = object.type === 'table';
    const notes = [];

    const { row_count, note: rowCountNote } = countRows(db, ident, object.type);
    if (rowCountNote) notes.push(rowCountNote);

    if (!isTable) {
        notes.push(
            `a ${object.type} has no foreign keys, CHECK constraints or indexes of its own; ` +
                '`sql` below is its definition'
        );
        // Views are not sampled. LIMIT bounds output rows, not the work that produces
        // them: measured over a 1000-row table, LIMIT 3 against a triple-join view costs
        // 6 s with an aggregate, 20 s with ORDER BY and 74 s with GROUP BY, because the
        // grouping or sort must complete before the first row exists. better-sqlite3
        // exposes no interrupt or progress handler (checked: the Database prototype has
        // neither), so a running statement cannot be cancelled in-process, and iterate()
        // does not help because the stall happens before row one. The server is
        // synchronous, so one such call blocks every other request including ping. This is
        // the same trade gate 1 accepted for row counting, against the same measurement.
        notes.push(
            'sample rows not taken: sampling a view can be arbitrarily slow and cannot be ' +
                'interrupted, so it is never attempted; read `sql` to see what it selects'
        );
    }

    return {
        name,
        type: object.type,
        row_count,
        columns: safely(notes, 'columns', () => columnsOf(db, ident), []),
        foreign_keys: isTable ? safely(notes, 'foreign keys', () => foreignKeys(db, ident), []) : [],
        check_constraints: isTable ? extractCheckConstraints(object.sql) : [],
        indexes: isTable ? safely(notes, 'indexes', () => indexes(db, ident), []) : [],
        sql: object.sql,
        sample_rows: isTable ? safely(notes, 'sample rows', () => sampleRowsOf(db, ident, notes), []) : [],
        ...(notes.length > 0 ? { note: notes.join('; ') } : {})
    };
}

const escapeForRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether the statement names this object, so the enrichment lists the relevant columns. */
function mentions(sql, name) {
    return new RegExp(`(^|[^\\w])${escapeForRegExp(name)}($|[^\\w])`, 'i').test(sql);
}

/**
 * Turns SQLite's diagnosis into a self-correcting one. "no such column: country" is already
 * good, but on its own it leaves the agent free to try another guess; appending the columns
 * that DO exist, plus an explicit instruction not to substitute, is what converts the
 * missing-geography case from a hallucinated answer into an honest one.
 *
 * Returns the error unchanged if the schema cannot be read — an enrichment failure must
 * never replace a real diagnosis with a worse one.
 */
export function enrichSqlError(err, db, sql) {
    if (err?.code !== 'SQL_ERROR') return err;

    try {
        const objects = listObjects(db);

        if (/no such column:/i.test(err.message)) {
            const named = objects.filter(object => mentions(sql, object.name));
            const targets = named.length > 0 ? named : objects;
            const summary = targets
                .map(object => {
                    const columns = columnsOf(db, quoteIdent(object.name)).map(c => c.name);
                    return `${object.name} has columns: ${columns.join(', ')}`;
                })
                .join('; ');

            return new SqlError(
                `${err.message}. ${summary}. If the column you need is not listed, the data ` +
                    'does not contain it — say so rather than substituting another column'
            );
        }

        if (/no such table:/i.test(err.message)) {
            return new SqlError(
                `${err.message}. This database contains: ${objects.map(o => o.name).join(', ')}`
            );
        }
    } catch (enrichmentFailure) {
        if (enrichmentFailure instanceof AppError) throw enrichmentFailure;
    }

    return err;
}
