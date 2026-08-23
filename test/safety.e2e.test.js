import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { startServer, toolJson } from './helpers.js';

/**
 * The capstone: homework §4 end to end. Every adversarial statement in plan §6 is driven
 * through a live MCP client — the same path a grader takes — against a throwaway copy of
 * shop.db, and the copy is then proved untouched.
 *
 * What "untouched" is allowed to mean here is the whole point, and it is narrower than it
 * looks. Per the corrected F4, "no new files appeared in the temp directory" proves
 * NOTHING on this path: better-sqlite3 opens an attached database with the parent
 * connection's readonly flag, so `ATTACH DATABASE '<nonexistent>'` is SQLITE_CANTOPEN and
 * cannot create a file even with the guard entirely removed.
 *
 * Which assertion below actually guards which layer was measured, by reverting one
 * protection at a time in a scratch copy of the repo and re-running this file:
 *
 *   - "refused by the guard, not by a deeper layer" and the admitted-attacks list go red
 *     with L3 alone disabled: 6 attacks are then answered normally and ~15 more are
 *     stopped by the engine instead, with a message that explains nothing.
 *   - "sqlite_temp_master is empty" and "the cross-database read never resolves" survive
 *     an L3-only revert, because runQuery calls `statement.columns()` before iterating and
 *     better-sqlite3 throws there for any statement that returns no rows — which is every
 *     ATTACH and every DDL. That is an accident of the paging code, not a safety layer, so
 *     these two assertions were verified against an L3+L2 revert with that call made
 *     lenient: the temp table then lands and `SELECT * FROM sec.creds` returns hunter2.
 *   - "the SHA-256 and byte size are unchanged" needs L0 gone as well: with L3, L2 and
 *     SQLITE_OPEN_READONLY all reverted, `DELETE … RETURNING` (which returns rows, so it
 *     survives the columns() call) empties the table and this assertion goes red.
 */

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

// Case 35: past the guard's 100 000-character cap. Asserted to be over it in the test, so
// it cannot quietly stop exercising the cap if the literal is ever edited.
const OVERLONG_SQL = `SELECT 1 WHERE 1 IN (${'1,'.repeat(60_000)}1)`;

// Case 35's other half: a 4 000-element IN list is ordinary analytical SQL and must pass.
const LONG_BUT_LEGAL_SQL = `SELECT 1 AS n WHERE 1 IN (${'1,'.repeat(3_999)}1)`;

/**
 * A temp directory holding the database under attack and the file an ATTACH would read.
 *
 * The copy is marked through a *writable* connection before the server ever opens it, and
 * the marker is read back through the client. That is the precondition the rest of the
 * test rests on: it proves SHOP_DB_PATH really took effect, so the attacks land on this
 * copy rather than on the committed shop.db, and it proves this process can write the
 * file — without that, "the SHA-256 did not change" could be the filesystem's doing rather
 * than the server's.
 */
function stage() {
    const dir = mkdtempSync(join(tmpdir(), 'shop-db-safety-'));

    const target = join(dir, 'shop.db');
    copyFileSync(join(projectRoot, 'shop.db'), target);
    const marked = new Database(target);
    marked.exec(
        'CREATE TABLE attack_target (marker TEXT);' +
            "INSERT INTO attack_target (marker) VALUES ('temp copy');"
    );
    marked.close();

    // F4's real threat. A reviewer exfiltrated exactly this row through ATTACH with the
    // guard removed, so the secret is spelled out and asserted against by value.
    const secrets = join(dir, 'secrets.db');
    const secretsDb = new Database(secrets);
    secretsDb.exec(
        "CREATE TABLE creds (user TEXT, token TEXT); INSERT INTO creds VALUES ('root', 'hunter2');"
    );
    secretsDb.close();

    return { dir, target, secrets };
}

const fingerprint = path => ({
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    bytes: statSync(path).size
});

/** Plan §6 cases 1-21 and 27-36, plus three shapes the plan's list does not name. */
function attacks({ secrets }) {
    return [
        ['1 the literal homework DELETE', "DELETE FROM orders WHERE status='cancelled'"],
        ['2 INSERT', "INSERT INTO customers (first_name) VALUES ('x')"],
        ['3 UPDATE', 'UPDATE products SET price = 0'],
        ['4 DROP TABLE', 'DROP TABLE orders'],
        ['5 ALTER TABLE', 'ALTER TABLE orders ADD COLUMN x TEXT'],
        ['6a CREATE TABLE', 'CREATE TABLE t (x)'],
        ['6b CREATE TEMP TABLE', 'CREATE TEMP TABLE t (x)'],
        ['7 two statements', 'SELECT 1; DELETE FROM orders'],
        ['8 empty statement between two', 'SELECT 1; ; DELETE FROM orders'],
        ['9 line comment before the verb', '-- harmless\nDELETE FROM orders'],
        ['10 fake SELECT inside a block comment', '/* SELECT */ DELETE FROM orders'],
        ['11 line comment hiding the separator', 'SELECT 1 -- ;\nDELETE FROM orders'],
        [
            '12 CTE-wrapped write',
            'WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)'
        ],
        ['13 PRAGMA writable_schema', 'PRAGMA writable_schema = ON'],
        ['14 PRAGMA table_info', 'PRAGMA table_info(orders)'],
        ['15 ATTACH an existing database', `ATTACH DATABASE '${secrets}' AS sec`],
        // Alias `e`, never `sec`: a DETACH of the alias case 15 uses would tear the
        // attachment down again and rescue the cross-database assertion below — measured,
        // with the guard disabled `DETACH DATABASE sec` made that assertion pass.
        ['16 DETACH', 'DETACH DATABASE e'],
        ['17a VACUUM', 'VACUUM'],
        ['17b REINDEX', 'REINDEX'],
        ['17c BEGIN', 'BEGIN'],
        ['17d COMMIT', 'COMMIT'],
        ['17e ROLLBACK', 'ROLLBACK'],
        ['17f SAVEPOINT', 'SAVEPOINT s'],
        ['18 UPDATE sqlite_master', "UPDATE sqlite_master SET sql = 'x'"],
        ['19 EXPLAIN a write', 'EXPLAIN DELETE FROM orders'],
        ['20 mixed case and tabs', 'dElEtE   from\torders'],
        ['21 natural language in the sql field', 'Delete all cancelled orders.'],
        ['27 block comments do not nest', '/* /* */ DELETE FROM orders */'],
        ['28a unterminated block comment', 'SELECT 1 /* DELETE FROM orders'],
        ['28b unterminated string literal', "SELECT 'x"],
        ['28c unterminated quoted identifier', 'SELECT "x'],
        ['28d unterminated bracket identifier', 'SELECT [x'],
        ['29 null byte', 'SELECT 1 \0; DROP TABLE orders'],
        ['30 load_extension', "SELECT load_extension('evil.so')"],
        ['31 ANALYZE', 'ANALYZE'],
        ['32 empty trailing statement', 'SELECT 1;;'],
        ['33a BOM before a write', '﻿DELETE FROM orders'],
        ['33b non-breaking space between tokens', 'DELETE FROM orders'],
        [
            '34 blob literal must not desync quote pairing',
            "SELECT X'414243', 'x'; DELETE FROM orders"
        ],
        ['35 past the length cap', OVERLONG_SQL],
        ['36a pragma_table_info table-valued function', "SELECT * FROM pragma_table_info('orders')"],
        ['36b pragma_optimize table-valued function', 'SELECT * FROM pragma_optimize'],

        // Beyond §6. A write with RETURNING produces rows, so it is the one write shape
        // that survives runQuery's `statement.columns()` call — the accidental barrier
        // that stops every other DDL and ATTACH once the guard is removed. It is the
        // shortest path from a disabled guard to a modified file, which makes it the case
        // that gives the SHA-256 assertion below its teeth.
        [
            'beyond §6: DELETE … RETURNING returns rows',
            "DELETE FROM orders WHERE status='cancelled' RETURNING id"
        ],
        [
            'beyond §6: INSERT … RETURNING returns rows',
            "INSERT INTO customers (first_name) VALUES ('x') RETURNING id"
        ],
        ['beyond §6: UPDATE … RETURNING returns rows', 'UPDATE products SET price = 0 RETURNING id']
    ];
}

/**
 * describe_table interpolates the table name into `PRAGMA table_info(…)`, so it reaches
 * the engine without passing the SQL guard at all. It is gated on a name that already
 * exists in sqlite_master and the identifier is `"`-escaped, so neither payload can close
 * the quote — but the surface is real and §6 lists only run_sql_query cases.
 */
const IDENTIFIER_INJECTIONS = [
    ['a statement smuggled through a table name', 'orders"); DROP TABLE orders; --'],
    ['a bare quote in a table name', 'orders" ']
];

/**
 * Plan §6 cases 22-26 and the allowed halves of 33-35, plus a real analytical query. A
 * suite that only proved refusals would pass against a server that refuses everything,
 * which fails the homework just as surely as one that permits a write.
 */
const ALLOWED = [
    ['a real aggregate still answers', 'SELECT COUNT(*) AS n FROM orders', [{ n: 750 }]],
    [
        '22 a verb inside a string literal',
        "SELECT * FROM products WHERE name = 'DROP TABLE orders'",
        []
    ],
    ['23 a semicolon inside a string literal', "SELECT * FROM products WHERE name = 'a;b'", []],
    ['24 one trailing semicolon', 'SELECT 1;', [{ 1: 1 }]],
    ['25 a CTE', 'WITH x AS (SELECT 1 AS n) SELECT n FROM x', [{ n: 1 }]],
    [
        '26 a verb as a quoted identifier',
        'SELECT "delete" FROM (SELECT 1 AS "delete")',
        [{ delete: 1 }]
    ],
    ['33 a leading BOM, which SQLite itself accepts', '﻿SELECT 1 AS n', [{ n: 1 }]],
    [
        '34 a blob literal followed by a string literal',
        "SELECT X'414243' AS b, 'DROP TABLE orders' AS s",
        [{ b: '<BLOB 3 bytes>', s: 'DROP TABLE orders' }]
    ],
    ['35 a 4 000-element IN list', LONG_BUT_LEGAL_SQL, [{ n: 1 }]]
];

const text = result => result.content[0].text;
const oneLine = value => value.replace(/\s+/g, ' ').slice(0, 120);

test('every attack in the adversarial set is refused and the database is untouched', async () => {
    const { dir, target, secrets } = stage();
    const before = fingerprint(target);
    const filesBefore = readdirSync(dir).sort();

    assert.ok(OVERLONG_SQL.length > 100_000, 'the length-cap case no longer exceeds the cap');

    const client = await startServer({ dbPath: target });
    const admitted = [];
    const notGuarded = [];
    let tempObjects;
    let crossDatabaseRead;

    try {
        // Precondition. If SHOP_DB_PATH had not taken effect, every attack below would run
        // against the committed shop.db and the integrity checks on this copy would pass
        // without proving anything at all.
        const marker = await client.callTool({
            name: 'run_sql_query',
            arguments: { sql: 'SELECT marker FROM attack_target' }
        });
        assert.notEqual(marker.isError, true, text(marker));
        assert.deepEqual(
            toolJson(marker).rows,
            [{ marker: 'temp copy' }],
            'the server is not reading the staged copy'
        );

        for (const [label, sql] of attacks({ secrets })) {
            const result = await client.callTool({ name: 'run_sql_query', arguments: { sql } });
            if (result.isError !== true) {
                admitted.push(`${label} -> ${oneLine(text(result))}`);
                continue;
            }

            const message = text(result);
            // Refused *by the guard*, not by whatever lies behind it. Every one of these
            // is also stopped by the engine one way or another, so asserting only
            // `isError` would stay green with the guard deleted; what would change is that
            // the agent gets "the database engine reports that this statement is not
            // read-only" — or an INTERNAL_ERROR about a columns() call — instead of an
            // explanation and the read-only equivalent.
            if (!message.startsWith('READ_ONLY_VIOLATION: read-only guard')) {
                notGuarded.push(`${label} -> ${oneLine(message)}`);
            }
            assert.ok(
                !/(?<![\w:])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(message),
                `${label} leaked a path: ${message}`
            );
            assert.ok(!/\sat\s+\S+\s+\(/.test(message), `${label} leaked a stack frame: ${message}`);
            assert.ok(!/\.js:\d+/.test(message), `${label} leaked a source location: ${message}`);
        }

        for (const [label, tableName] of IDENTIFIER_INJECTIONS) {
            const result = await client.callTool({
                name: 'describe_table',
                arguments: { table_name: tableName }
            });
            assert.equal(result.isError, true, `${label} was accepted: ${oneLine(text(result))}`);
            assert.match(text(result), /no such table/, label);
        }

        // Both of these must run on the SAME connection as the attacks: temp tables and
        // attachments are per-connection state, so a freshly spawned server would report
        // an empty temp schema and an unknown `sec` no matter what happened above.
        tempObjects = await client.callTool({
            name: 'run_sql_query',
            arguments: { sql: 'SELECT name FROM sqlite_temp_master' }
        });
        crossDatabaseRead = await client.callTool({
            name: 'run_sql_query',
            arguments: { sql: 'SELECT user, token FROM sec.creds' }
        });
    } finally {
        await client.close();
    }

    // ------------------------------------------------------------ integrity, first

    const after = fingerprint(target);
    assert.equal(after.sha256, before.sha256, 'the database file was modified');
    assert.equal(after.bytes, before.bytes, 'the database file changed size');

    // CREATE TEMP TABLE is the only DDL that succeeds on a readonly connection (F4), so
    // its absence from the temp schema is worth proving through the client.
    assert.notEqual(tempObjects.isError, true, text(tempObjects));
    assert.deepEqual(
        toolJson(tempObjects).rows,
        [],
        'a CREATE TEMP TABLE landed: sqlite_temp_master is not empty'
    );

    // The reachable ATTACH consequence per corrected F4: not a file appearing, but rows
    // crossing over from another database on disk.
    assert.equal(
        crossDatabaseRead.isError,
        true,
        `a cross-database read resolved: ${oneLine(text(crossDatabaseRead))}`
    );
    assert.match(text(crossDatabaseRead), /no such table/);
    assert.ok(!text(crossDatabaseRead).includes('hunter2'), 'the attached secret was returned');

    // NOT load-bearing, and kept only because it is free. Corrected F4: an attachment
    // inherits the parent connection's readonly flag, so ATTACH of a nonexistent file is
    // SQLITE_CANTOPEN and creates nothing — this assertion passes with the guard entirely
    // disabled. The assertions above are the proof; this one is not.
    assert.deepEqual(readdirSync(dir).sort(), filesBefore, 'a file appeared beside the database');

    // ------------------------------------------------------------ then the refusals

    assert.deepEqual(
        admitted,
        [],
        `${admitted.length} attack(s) were not refused:\n${admitted.join('\n')}`
    );
    assert.deepEqual(
        notGuarded,
        [],
        `${notGuarded.length} attack(s) reached past the guard and were stopped by a deeper ` +
            `layer, so the agent got no explanation:\n${notGuarded.join('\n')}`
    );
});

test('the queries a lexer must still allow are answered normally', async () => {
    const { target } = stage();
    assert.ok(LONG_BUT_LEGAL_SQL.length < 100_000, 'the legal IN list has grown past the cap');

    const client = await startServer({ dbPath: target });
    try {
        for (const [label, statement, expected] of ALLOWED) {
            const result = await client.callTool({
                name: 'run_sql_query',
                arguments: { sql: statement }
            });
            assert.notEqual(result.isError, true, `${label} was refused: ${text(result)}`);
            assert.deepEqual(toolJson(result).rows, expected, label);
        }
    } finally {
        await client.close();
    }
});
