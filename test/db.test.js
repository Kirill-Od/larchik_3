import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { coerceRows, runQuery } from '../src/db.js';
import { makeFixtureDb } from './helpers.js';

/** A handle that answers `prepare` however the test wants and forbids everything else. */
function stubHandle(statement) {
    return {
        prepare: () => statement,
        // db.exec() is the one API that runs multiple statements; nothing may reach it.
        exec: () => {
            throw new Error('db.exec must never be called');
        }
    };
}

const readonlyStatement = (readonly, rows = []) => ({
    readonly,
    columns: () => Object.keys(rows[0] ?? { v: null }).map(name => ({ name })),
    iterate: function* () {
        yield* rows;
    }
});

// L2. The guard cannot see everything the engine knows, and the engine cannot see
// everything the guard knows — slice 3 measured sqlite3_stmt_readonly returning true for
// load_extension(). Both layers stay because they fail in different directions.
test('a statement the engine reports as not read-only is refused after the guard passed', () => {
    const handle = stubHandle(readonlyStatement(false));

    assert.throws(
        () => runQuery(handle, 'SELECT 1'),
        err => {
            assert.equal(err.code, 'READ_ONLY_VIOLATION');
            // "the engine says so" is what distinguishes L2 from the guard's own refusal.
            assert.match(err.message, /engine/i);
            assert.match(err.message, /not read-only/i);
            return true;
        }
    );
});

test('a read-only statement is executed and its rows returned', () => {
    const handle = stubHandle(readonlyStatement(true, [{ v: 1 }, { v: 2 }]));
    const result = runQuery(handle, 'SELECT 1');

    assert.deepEqual(result.rows, [{ v: 1 }, { v: 2 }]);
    assert.equal(result.row_count, 2);
    assert.equal(result.has_more, false);
});

// The crude stopgap is allowed to be crude; it is not allowed to leak.
test('an absolute path in a SQLite message never reaches the caller', () => {
    const handle = {
        prepare: () => {
            throw new Error('unable to open database file /srv/private/shop.db');
        },
        exec: () => {
            throw new Error('db.exec must never be called');
        }
    };

    assert.throws(
        () => runQuery(handle, 'SELECT 1'),
        err => {
            assert.equal(err.code, 'SQL_ERROR');
            assert.ok(!err.message.includes('/srv/'), `path leaked: ${err.message}`);
            assert.ok(!/\bat \w+ \(/.test(err.message), `stack frame leaked: ${err.message}`);
            return true;
        }
    );
});

test('an out-of-range limit is refused with the accepted range', () => {
    const handle = stubHandle(readonlyStatement(true));

    for (const limit of [0, -1, 1001, 5000, 1.5]) {
        assert.throws(
            () => runQuery(handle, 'SELECT 1', { limit }),
            err => {
                assert.equal(err.code, 'INVALID_ARGUMENT');
                assert.match(err.message, /1 (to|and) 1000/);
                return true;
            },
            `limit=${limit} was accepted`
        );
    }
});

test('a negative offset is refused', () => {
    const handle = stubHandle(readonlyStatement(true));
    assert.throws(
        () => runQuery(handle, 'SELECT 1', { offset: -1 }),
        err => err.code === 'INVALID_ARGUMENT'
    );
});

// JSON.stringify throws outright on a BigInt, so an uncoerced one breaks the whole call.
test('coerceRows converts every SQLite value type to something JSON can carry', () => {
    const { rows } = coerceRows(
        [
            {
                blob: Buffer.from([1, 2, 3]),
                small: 42n,
                huge: 9223372036854775807n,
                nothing: null,
                real: 1.5,
                text: 'plain'
            }
        ],
        4096
    );

    assert.equal(rows[0].blob, '<BLOB 3 bytes>');
    assert.equal(rows[0].small, 42);
    assert.equal(rows[0].huge, '9223372036854775807');
    assert.equal(rows[0].nothing, null);
    assert.equal(rows[0].real, 1.5);
    assert.equal(rows[0].text, 'plain');
    assert.doesNotThrow(() => JSON.stringify(rows));
});

test('coerceRows applies whatever cap it is given and reports that it did', () => {
    const long = 'x'.repeat(500);

    const wide = coerceRows([{ t: long }], 4096);
    assert.equal(wide.rows[0].t.length, 500);
    assert.equal(wide.truncatedCells, 0);

    const narrow = coerceRows([{ t: long }], 100);
    assert.ok(narrow.rows[0].t.startsWith('x'.repeat(100)));
    assert.match(narrow.rows[0].t, /truncated from 500 chars/);
    assert.equal(narrow.truncatedCells, 1);
});

// The deadline is checked between rows, so what it actually bounds is a query whose rows
// are individually expensive — the page never fills, so the loop keeps getting turns. A
// fast cross join is bounded by the row cap instead, in milliseconds (see the e2e suite).
test('a query with expensive rows stops at the deadline', () => {
    const db = new Database(
        makeFixtureDb(`CREATE TABLE t (x INTEGER);
            INSERT INTO t (x) SELECT x FROM (
                WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300)
                SELECT x FROM c);`),
        { readonly: true }
    );

    const startedAt = Date.now();
    assert.throws(
        () =>
            runQuery(
                db,
                'SELECT a.x, (SELECT COUNT(*) FROM t b, t c WHERE b.x * c.x > a.x) AS k FROM t a',
                { limit: 1000, deadlineMs: 50 }
            ),
        err => {
            assert.equal(err.code, 'QUERY_TIMEOUT');
            assert.match(err.message, /still returning rows/);
            // Each concrete remedy, separately: an alternation here would be rescued by
            // whichever member is most generic, which is how "narrow" alone slipped through.
            assert.match(err.message, /WHERE clause/);
            assert.match(err.message, /GROUP BY/);
            assert.match(err.message, /join fewer tables/);
            return true;
        }
    );
    assert.ok(Date.now() - startedAt < 5000, 'the deadline did not bound the query');
    db.close();
});

// The skip phase is inside the same loop, so a large offset is bounded too.
test('the deadline also bounds the rows skipped for an offset', () => {
    const db = new Database(
        makeFixtureDb(`CREATE TABLE t (x INTEGER);
            INSERT INTO t (x) SELECT x FROM (
                WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 300)
                SELECT x FROM c);`),
        { readonly: true }
    );

    assert.throws(
        () =>
            runQuery(
                db,
                'SELECT a.x, (SELECT COUNT(*) FROM t b, t c WHERE b.x * c.x > a.x) AS k FROM t a',
                { limit: 1, offset: 250, deadlineMs: 50 }
            ),
        err => err.code === 'QUERY_TIMEOUT'
    );
    db.close();
});

// The plan that matters most produces its first row only when it is completely finished, so
// "still streaming" is false and "aggregate instead of returning raw rows" is a no-op — the
// query already is an aggregate. Each case has to say what is actually true of it.
test('a plan that returns nothing until it finishes is reported as such, not as streaming', () => {
    const db = new Database(
        makeFixtureDb(`CREATE TABLE t (x INTEGER);
            INSERT INTO t (x) SELECT x FROM (
                WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 400)
                SELECT x FROM c);`),
        { readonly: true }
    );

    const startedAt = Date.now();
    assert.throws(
        () => runQuery(db, 'SELECT COUNT(*) AS k FROM t a, t b, t c', { deadlineMs: 50 }),
        err => {
            assert.equal(err.code, 'QUERY_TIMEOUT');
            assert.match(err.message, /produced no rows/);
            assert.match(err.message, /could not be stopped/);

            // It must own up to overshooting the deadline rather than quoting it as if met.
            const reported = Number(err.message.match(/(\d+) ms/)[1]);
            assert.ok(reported > 50, `reported ${reported} ms, which is just the deadline`);

            // The no-op advice must not appear on the shape it cannot help.
            assert.ok(
                !/instead of returning raw rows/.test(err.message),
                `advice is a no-op for an aggregate: ${err.message}`
            );
            assert.match(err.message, /smaller/);
            return true;
        }
    );
    assert.ok(Date.now() - startedAt < 5000);
    db.close();
});

// Finding 4: the POSIX branch required two separators, so a root-level database — exactly
// what SHOP_DB_PATH=/shop.db gives you in the Dockerfile task 15 ships — went through whole.
test('paths with a single separator and UNC paths are scrubbed too', () => {
    for (const leak of ['/shop.db', '\\\\server\\share\\shop.db']) {
        const handle = {
            prepare: () => {
                throw new Error(`unable to open database file ${leak}`);
            },
            exec: () => {
                throw new Error('db.exec must never be called');
            }
        };
        assert.throws(
            () => runQuery(handle, 'SELECT 1'),
            err => {
                assert.ok(!err.message.includes(leak), `path leaked: ${err.message}`);
                assert.match(err.message, /<database>/);
                return true;
            },
            `not scrubbed: ${leak}`
        );
    }
});

// Over-scrubbing would destroy the diagnostics that make SQL_ERROR worth forwarding.
test('scrubbing leaves genuine SQLite diagnostics intact', () => {
    const preserved = [
        'no such column: country',
        'near "FROM": syntax error',
        'no such table: main.gone',
        'datatype mismatch on 2026/08/23',
        'unrecognized token: "http://example.com/x"'
    ];

    for (const message of preserved) {
        const handle = {
            prepare: () => {
                throw new Error(message);
            },
            exec: () => {
                throw new Error('db.exec must never be called');
            }
        };
        assert.throws(
            () => runQuery(handle, 'SELECT 1'),
            err => {
                assert.equal(err.message, message, `over-scrubbed: ${err.message}`);
                return true;
            }
        );
    }
});
