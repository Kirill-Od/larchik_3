import Database from 'better-sqlite3';
import { AppError, ConfigurationError, InvalidArgument, QueryTimeout, SqlError, sanitize } from './errors.js';
import { assertReadOnly } from './sql-guard.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const MAX_CELL_CHARS = 4096;

// The row cap is not a size cap. MAX_LIMIT rows x an unbounded column count x MAX_CELL_CHARS
// is 31 MB for eight wide columns, and `SELECT *` is the first thing an agent writes. On a
// synchronous stdio server that is a serialization stall, a payload many clients reject, and
// a blown context window. Per-cell truncation cannot bound it; only a total can.
const MAX_RESPONSE_CHARS = 262_144;

// Chosen so an ordinary analytical query on a laptop-sized database never trips it, while
// a runaway join is cut off long before a client gives up on the server.
const DEFAULT_DEADLINE_MS = 5000;

/** Opens the database read-only. SQLITE_OPEN_READONLY is the outermost safety layer. */
export function openDatabase(path) {
    return new Database(path, { readonly: true });
}

/**
 * A stand-in handle used when the database could not be opened. Every access fails with a
 * CONFIGURATION_ERROR naming the setting to fix, which is how the tools can keep answering
 * after a bad SHOP_DB_PATH instead of the process dying before the handshake.
 */
export function unavailableDatabase(reason) {
    const fail = () => {
        throw new ConfigurationError(
            `the database could not be opened: ${reason}. Set SHOP_DB_PATH to a readable ` +
                'SQLite file, or place shop.db in the project root, then restart the server'
        );
    };
    return { prepare: fail, exec: fail };
}

/**
 * Turns SQLite's JS values into something JSON can carry, capping each cell at
 * `maxCellChars`. The cap is a parameter because the two call sites want different
 * budgets: a query result may legitimately be wide, while three sample rows attached to a
 * schema description must stay small.
 *
 * BigInt matters more than it looks: JSON.stringify throws outright on one, so a single
 * uncoerced BigInt fails the entire call rather than one cell.
 */
function coerceRow(row, maxCellChars) {
    let truncatedCells = 0;

    const coerced = Object.fromEntries(
        Object.entries(row).map(([column, value]) => {
            if (Buffer.isBuffer(value)) {
                return [column, `<BLOB ${value.length} bytes>`];
            }
            if (typeof value === 'bigint') {
                const exact =
                    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
                    value <= BigInt(Number.MAX_SAFE_INTEGER);
                return [column, exact ? Number(value) : value.toString()];
            }
            if (typeof value === 'string' && value.length > maxCellChars) {
                truncatedCells++;
                return [
                    column,
                    `${value.slice(0, maxCellChars)}… <truncated from ${value.length} chars>`
                ];
            }
            return [column, value];
        })
    );

    return { row: coerced, truncatedCells };
}

export function coerceRows(rows, maxCellChars) {
    let truncatedCells = 0;
    const coerced = rows.map(row => {
        const one = coerceRow(row, maxCellChars);
        truncatedCells += one.truncatedCells;
        return one.row;
    });
    return { rows: coerced, truncatedCells };
}

/**
 * Two different failures wear the QUERY_TIMEOUT code, and telling them apart is the whole
 * value of the message. A plan that never yielded a row was not "streaming", and telling it
 * to "aggregate instead of returning raw rows" is a no-op when it is already an aggregate —
 * measured, a bare COUNT(*) over a 64 M-row join returns its first row only when completely
 * finished, so it overshoots the deadline by orders of magnitude and the only real remedy is
 * to shrink what is being joined.
 */
function timeoutError(rowsSeen, elapsedMs, deadlineMs) {
    if (rowsSeen === 0) {
        return new QueryTimeout(
            `the query produced no rows for ${elapsedMs} ms and could not be stopped any ` +
                `earlier (the deadline is ${deadlineMs} ms, but a plan is only interruptible ` +
                'between rows). Plans that compute their whole result before returning ' +
                'anything behave this way: a bare COUNT(*) or SUM over a joined set is the ' +
                'usual cause, and ORDER BY, GROUP BY, DISTINCT and UNION over a large join do ' +
                'the same. Make the input smaller before combining it — filter each table in ' +
                'its own subquery first, aggregate one table at a time, or join fewer tables'
        );
    }
    return new QueryTimeout(
        `the query was still returning rows after ${elapsedMs} ms and was stopped (the ` +
            `deadline is ${deadlineMs} ms). Narrow it: add a WHERE clause to cut rows out, ` +
            'aggregate with COUNT/SUM and GROUP BY instead of returning raw rows, or join ' +
            'fewer tables'
    );
}

/**
 * Runs one validated read-only statement and returns a page of its rows.
 *
 * Three layers, in order, each catching what the others cannot:
 *   L3  assertReadOnly  — the only thing that stops ATTACH, PRAGMA and load_extension,
 *                         all of which sqlite3_stmt_readonly reports as read-only.
 *   L1  db.prepare      — never db.exec, because prepare accepts exactly one statement.
 *   L2  stmt.readonly   — the engine's own verdict, which catches anything the guard's
 *                         vocabulary does not know about.
 *
 * Paging iterates rather than rewriting the caller's SQL. Appending `LIMIT n OFFSET m`
 * would collide with a LIMIT the agent already wrote, change the meaning of a compound
 * SELECT, and put string splicing directly against a security boundary.
 *
 * THE DEADLINE BOUNDS SLOW-STREAMING PLANS ONLY, and that is narrower than it sounds.
 * It is checked between rows, so it catches a query whose rows are individually expensive
 * — a correlated subquery over a large join, measured at ~95 ms/row on shop.db — and it
 * bounds the offset-skipping phase, which runs in the same loop. It is NOT what saves you
 * from a plain cross join: `SELECT a.id FROM order_items a, b, c` returns its 100 rows in
 * 2 ms because the row cap answers it first. And it CANNOT stop a plan that must finish
 * before its first row — ORDER BY, GROUP BY, DISTINCT and UNION over a large join all sort
 * or aggregate the whole result before emitting anything, so the check never gets a turn.
 * better-sqlite3 exposes no interrupt and no progress handler (verified: neither is on the
 * Database prototype), so there is no in-process way to cancel one. Plan §7 puts a worker
 * thread out of scope; this is the residual it names. Do not describe this as a general
 * timeout.
 */
export function runQuery(
    db,
    sql,
    { limit = DEFAULT_LIMIT, offset = 0, deadlineMs = DEFAULT_DEADLINE_MS } = {}
) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new InvalidArgument(
            `limit must be a whole number from 1 to ${MAX_LIMIT}; received ${limit}`
        );
    }
    if (!Number.isInteger(offset) || offset < 0) {
        throw new InvalidArgument(`offset must be a whole number of 0 or more; received ${offset}`);
    }

    assertReadOnly(sql);

    let statement;
    try {
        statement = db.prepare(sql);
    } catch (err) {
        // A ConfigurationError from an unusable handle must not be relabelled as bad SQL.
        if (err instanceof AppError) throw err;
        throw new SqlError(sanitize(err.message));
    }

    if (statement.readonly !== true) {
        throw new AppError(
            'READ_ONLY_VIOLATION',
            'the database engine reports that this statement is not read-only; only ' +
                'statements that read data are permitted'
        );
    }

    const columns = statement.columns().map(column => column.name);
    const rows = [];
    let hasMore = false;
    let budgetReached = false;
    let truncatedCells = 0;
    let responseChars = 0;
    let rowsSeen = 0;
    let skipped = 0;
    const startedAt = Date.now();

    try {
        for (const row of statement.iterate()) {
            // Before rowsSeen is incremented, so "did this plan give us anything before the
            // deadline?" is answered about rows that arrived earlier, not about this one.
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs > deadlineMs) throw timeoutError(rowsSeen, elapsedMs, deadlineMs);
            rowsSeen++;

            if (skipped < offset) {
                skipped++;
                continue;
            }
            if (rows.length >= limit) {
                // One row past the page, so has_more is exact rather than a guess.
                hasMore = true;
                break;
            }

            const coerced = coerceRow(row, MAX_CELL_CHARS);
            const size = JSON.stringify(coerced.row).length;
            // Always keep the first row: a single row wider than the whole budget is still
            // more useful than an empty result the agent cannot learn anything from.
            if (rows.length > 0 && responseChars + size > MAX_RESPONSE_CHARS) {
                budgetReached = true;
                hasMore = true;
                break;
            }

            responseChars += size;
            truncatedCells += coerced.truncatedCells;
            rows.push(coerced.row);
        }
    } catch (err) {
        if (err instanceof AppError) throw err;
        throw new SqlError(sanitize(err.message));
    }

    const notes = [];
    if (budgetReached) {
        notes.push(
            `stopped after ${rows.length} row(s) to keep the response under ` +
                `${MAX_RESPONSE_CHARS} characters; call again with offset=${offset + rows.length}, ` +
                'or select fewer columns'
        );
    } else if (hasMore) {
        notes.push(
            `more rows available; call again with offset=${offset + limit}, or use an ` +
                'aggregate (COUNT/SUM with GROUP BY) instead of paging through rows'
        );
    }
    if (truncatedCells > 0) {
        notes.push(
            `${truncatedCells} cell(s) were longer than ${MAX_CELL_CHARS} characters and ` +
                'were truncated'
        );
    }

    return {
        columns,
        rows,
        row_count: rows.length,
        limit,
        offset,
        has_more: hasMore,
        notes: notes.join('; ')
    };
}
