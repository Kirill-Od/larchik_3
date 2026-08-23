import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { assertReadOnly, ReadOnlyViolation } from '../src/sql-guard.js';
import { makeFixtureDb } from './helpers.js';

const label = sql =>
    typeof sql === 'string'
        ? JSON.stringify(sql.length > 90 ? `${sql.slice(0, 90)}…` : sql)
        : String(sql);

/** Asserts `sql` is refused and hands the violation back so its shape can be checked. */
function refusal(sql) {
    try {
        assertReadOnly(sql);
    } catch (err) {
        assert.ok(
            err instanceof ReadOnlyViolation,
            `${label(sql)} threw ${err?.constructor?.name}, not ReadOnlyViolation: ${err?.message}`
        );
        return err;
    }
    return assert.fail(`${label(sql)} was allowed, but must be refused`);
}

function allows(sql) {
    try {
        assertReadOnly(sql);
    } catch (err) {
        assert.fail(`${label(sql)} must be allowed, but was refused: ${err.message}`);
    }
}

/** A readonly connection to a throwaway database, closed when the test ends. */
function readonlyFixture(t) {
    const db = new Database(makeFixtureDb(), { readonly: true });
    t.after(() => db.close());
    return db;
}

/** L3 in front of a real connection, in the order src/db.js runQuery applies them. */
function guarded(db, sql) {
    assertReadOnly(sql);
    const statement = db.prepare(sql);
    return statement.reader ? statement.all() : statement.run();
}

// ---------------------------------------------------------------------------
// Task 3 — allow-listed opener and the single-statement rule
// ---------------------------------------------------------------------------

// Plan §6 cases 1-6. Every one of these is a statement the homework explicitly requires
// the server to refuse, and CREATE TEMP is the one L0 (SQLITE_OPEN_READONLY) lets through.
test('plain mutations are refused', () => {
    const mutations = [
        "DELETE FROM orders WHERE status='cancelled'",
        "INSERT INTO customers (first_name) VALUES ('x')",
        'UPDATE products SET price = 0',
        'DROP TABLE orders',
        'ALTER TABLE orders ADD COLUMN x TEXT',
        'CREATE TABLE t (x)',
        'CREATE TEMP TABLE t (x)',
        "UPDATE sqlite_master SET sql = 'x'"
    ];
    for (const sql of mutations) {
        const err = refusal(sql);
        assert.equal(err.code, 'READ_ONLY_VIOLATION', `wrong code for ${label(sql)}`);
    }
});

test('a single SELECT, with or without its trailing semicolon, is allowed', () => {
    allows('SELECT 1');
    allows('SELECT 1;');
    allows('  SELECT 1  ;  ');
});

// Plan §6 cases 7-8. better-sqlite3's prepare() refuses a second statement on its own
// (L1), but the guard has to produce the *explanation*, and it is the layer that still
// stands if the execution path ever changes.
test('a second statement after a semicolon is refused', () => {
    for (const sql of ['SELECT 1; DELETE FROM orders', 'SELECT 1; ; DELETE FROM orders']) {
        const err = refusal(sql);
        assert.equal(err.reason, 'MULTIPLE_STATEMENTS', `wrong reason for ${label(sql)}`);
        assert.equal(err.remedy, 'SINGLE_STATEMENT');
    }
});

// A semicolon that separates nothing is still two statements as far as the guard is
// concerned: allowing it would mean the guard has to reason about what follows.
test('a doubled trailing semicolon is refused', () => {
    assert.equal(refusal('SELECT 1;;').reason, 'MULTIPLE_STATEMENTS');
});

test('an opener that is not SELECT, WITH or VALUES is refused even when harmless', () => {
    // ANALYZE mutates sqlite_stat1 and is in no denylist; the allow-list is what stops it.
    const err = refusal('ANALYZE');
    assert.equal(err.reason, 'DISALLOWED_OPENER');
    assert.equal(err.construct, 'ANALYZE');
});

test('empty and whitespace-only input is refused rather than reaching the database', () => {
    for (const sql of ['', '   \n\t  ']) {
        assert.equal(refusal(sql).reason, 'EMPTY_INPUT', `wrong reason for ${label(sql)}`);
    }
});

// ---------------------------------------------------------------------------
// Task 4 — comments and quoted text are lexed away before verbs are matched
// ---------------------------------------------------------------------------

// Plan §6 cases 9-11.
test('a comment cannot smuggle a write past the opener check', () => {
    for (const sql of [
        '-- harmless\nDELETE FROM orders',
        '/* SELECT */ DELETE FROM orders',
        'SELECT 1 -- ;\nDELETE FROM orders'
    ]) {
        assert.equal(refusal(sql).code, 'READ_ONLY_VIOLATION', `not refused: ${label(sql)}`);
    }
});

// Verified against SQLite 3.53.4: block comments do NOT nest — the first `*/` ends the
// comment, so SQLite reads this as `DELETE FROM orders */`. A lexer that nested comments
// would see the whole string as one comment and wave the DELETE through.
test('block comments do not nest, matching SQLite', () => {
    assert.equal(refusal('/* /* */ DELETE FROM orders */').construct, 'DELETE');
});

test('a comment between a verb and its object does not break the verb up', () => {
    assert.equal(refusal('DELETE/**/FROM orders').construct, 'DELETE');
    assert.equal(refusal('SELECT 1 UNION ALL DROP/* x */TABLE orders').construct, 'DROP');
});

// Fails closed. An unterminated construct is the one place the guard and SQLite could
// disagree about where the statement ends, and no legitimate query contains one.
test('unterminated comments, literals and identifiers are refused', () => {
    for (const sql of [
        'SELECT 1 /* trailing',
        "SELECT 'unterminated",
        'SELECT "unterminated',
        'SELECT [unterminated'
    ]) {
        const err = refusal(sql);
        assert.equal(err.reason, 'UNTERMINATED_TOKEN', `wrong reason for ${label(sql)}`);
    }
});

// Plan §6 cases 22-23 and 26 — the false-positive guards. A regex over the raw string
// gets every one of these wrong, and a guard that refuses legitimate SQL fails the
// homework just as surely as one that permits writes.
test('a forbidden verb inside a string literal is data, not a verb', () => {
    allows("SELECT * FROM products WHERE name = 'DROP TABLE orders'");
    allows("SELECT 'it''s fine; DROP TABLE orders' AS s");
});

test('a semicolon inside a string literal is not a statement separator', () => {
    allows("SELECT * FROM products WHERE name = 'a;b'");
});

test('a quoted identifier is not a verb, in any of SQLite four quoting styles', () => {
    allows('SELECT "delete" FROM (SELECT 1 AS "delete")');
    allows('SELECT `drop` FROM (SELECT 1 AS `drop`)');
    allows('SELECT [update] FROM (SELECT 1 AS [update])');
    allows('SELECT 1 AS "a""; DROP TABLE orders"');
});

// The X prefix must not desynchronize quote pairing, or the *next* literal's quotes pair
// against the wrong characters and its contents stop being opaque.
test('a blob literal is a literal, and does not desynchronize the ones after it', () => {
    allows("SELECT X'44524F50' AS b, 'DELETE FROM orders; ok' AS s");
});

// SQLite accepts a leading BOM, so refusing one would reject a query the engine runs.
// Unicode whitespace is the opposite case: JS \s is a strict superset of the five bytes
// SQLite calls whitespace, so treating it as a separator can only ever split a token
// further — the guard sees more tokens than SQLite, never fewer, and so fails closed.
test('a BOM and Unicode whitespace cannot hide a verb', () => {
    allows('﻿SELECT 1');
    assert.equal(refusal('﻿DELETE FROM orders').construct, 'DELETE');
    assert.equal(
        refusal('WITH x AS (SELECT 1) DELETE FROM orders').construct,
        'DELETE'
    );
});

// SQLite truncates its statement text at a NUL: `SELECT 1 \0; DROP TABLE x` prepares as
// `SELECT 1 `. The guard and the engine must not disagree about where a statement ends.
test('a null byte is refused outright', () => {
    const err = refusal('SELECT 1 \0; DROP TABLE orders');
    assert.equal(err.reason, 'ILLEGAL_CHARACTER');
});

test('input consisting only of comments is empty, not a statement', () => {
    assert.equal(refusal('-- nothing here\n/* nor here */').reason, 'EMPTY_INPUT');
});

// ---------------------------------------------------------------------------
// Task 5 — the bare-token verb denylist across the whole lexed statement
// ---------------------------------------------------------------------------

// Plan §6 case 12: this is the case the allow-listed opener alone cannot catch. It opens
// with WITH and passes any prefix check.
test('a CTE cannot wrap a write', () => {
    const err = refusal('WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)');
    assert.equal(err.reason, 'FORBIDDEN_VERB');
    assert.equal(err.construct, 'DELETE');
});

test('an ordinary CTE is allowed', () => {
    allows('WITH x AS (SELECT 1 AS n) SELECT n FROM x');
    allows('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c LIMIT 3) SELECT * FROM c');
});

// Plan §6 case 37. RETURNING is the one write shape that returns rows, and that is what
// makes it worth its own test: every other write dies on the current query path even with
// this guard removed, because runQuery reaches statements through columns()/iterate() and
// better-sqlite3 throws on both for a statement that returns nothing. That barrier is an
// accident of the paging code rather than a layer — and RETURNING walks straight past it.
// The capstone measured this shape, and no other, modifying the database file with L2 and
// L3 both reverted. The verb scan already catches all three; pinning them here stops the
// uniquely dangerous case from being covered only incidentally by the plain-mutation test.
test('a RETURNING write is refused, the one write shape that returns rows', () => {
    const forms = {
        'DELETE FROM orders WHERE id = 1 RETURNING *': 'DELETE',
        "INSERT INTO customers (first_name) VALUES ('x') RETURNING id": 'INSERT',
        'UPDATE products SET price = 0 WHERE id = 1 RETURNING id': 'UPDATE'
    };
    for (const [sql, construct] of Object.entries(forms)) {
        const err = refusal(sql);
        // The verb list, not the opener allow-list, which reports the same construct for
        // all three: only the reason says which rule refused.
        assert.equal(err.reason, 'FORBIDDEN_VERB', `wrong reason for ${label(sql)}`);
        assert.equal(err.construct, construct, `wrong construct for ${label(sql)}`);
    }

    // Behind a CTE the opener allow-list cannot rescue the refusal at all.
    const cte = refusal(
        'WITH x AS (SELECT id FROM orders) ' +
            'DELETE FROM orders WHERE id IN (SELECT id FROM x) RETURNING *'
    );
    assert.equal(cte.reason, 'FORBIDDEN_VERB');
    assert.equal(cte.construct, 'DELETE');
});

// Plan §6 cases 13-14. All PRAGMA is blocked, including the read-only ones: describe_table
// covers the legitimate need, so the refusal has to say so or the agent just retries.
test('PRAGMA is refused, and table_info is pointed at describe_table', () => {
    assert.equal(refusal('PRAGMA writable_schema = ON').construct, 'PRAGMA');

    const err = refusal('PRAGMA table_info(orders)');
    assert.equal(err.reason, 'FORBIDDEN_VERB');
    assert.equal(err.construct, 'PRAGMA');
    assert.equal(err.remedy, 'USE_DESCRIBE_TABLE');
});

// Plan §6 case 36. Every pragma is also reachable as a table-valued function — an
// ordinary identifier sitting behind an allowed opener, which neither the opener
// allow-list nor the PRAGMA verb sees. The slice-3 review put all 66 pragmas of this
// build through that spelling and every one was allowed.
test('the pragma_* table-valued functions are refused, and route to the PRAGMA remedy', () => {
    const info = refusal("SELECT * FROM pragma_table_info('orders')");
    assert.equal(info.reason, 'FORBIDDEN_VERB');
    assert.equal(info.construct, 'PRAGMA_TABLE_INFO');
    assert.equal(
        info.remedy,
        'USE_DESCRIBE_TABLE',
        'the same request as PRAGMA table_info, so the same remedy'
    );

    // Measured: this one reaches the engine and attempts a write, stopped only by L0.
    assert.equal(refusal('SELECT * FROM pragma_optimize').construct, 'PRAGMA_OPTIMIZE');
    assert.equal(refusal('SELECT * FROM PRAGMA_TABLE_LIST').construct, 'PRAGMA_TABLE_LIST');
});

// A prefix, not a substring. `pragma_notes` is refused deliberately: the guard holds no
// schema and cannot tell a table of that name from the table-valued function, so it fails
// closed — and the quoted spelling is the escape hatch, exactly as for `"delete"`.
test('a word that merely contains "pragma" is an ordinary identifier', () => {
    allows('SELECT pragmatic_score FROM ratings');
    allows('SELECT * FROM pragmatists');
    assert.equal(refusal('SELECT * FROM pragma_notes').construct, 'PRAGMA_NOTES');
    allows('SELECT * FROM "pragma_notes"');
});

// Plan §6 case 15 and corrected F4. The reachable threat on this path is reading
// *another* SQLite file, not creating one: SQLite opens an attached database with the
// parent connection's readonly flag, so ATTACH of a nonexistent file is SQLITE_CANTOPEN
// and nothing appears on disk. An `existsSync(evil) === false` assertion therefore passes
// with this module deleted — it measures SQLite, not the guard. ATTACH of an *existing*
// database succeeds on a readonly connection and its rows come straight back.
test('ATTACH of an existing database is refused, and no cross-database read resolves', t => {
    const secret = makeFixtureDb(
        `CREATE TABLE creds (user TEXT, token TEXT);
         INSERT INTO creds (user, token) VALUES ('root', 'hunter2');`
    );
    const db = readonlyFixture(t);

    const err = refusal(`ATTACH DATABASE '${secret}' AS sec`);
    // The verb list, not the opener allow-list: deleting ATTACH from FORBIDDEN_VERBS
    // leaves DISALLOWED_OPENER behind, which reports the same construct.
    assert.equal(err.reason, 'FORBIDDEN_VERB');
    assert.equal(err.construct, 'ATTACH');

    // Executed, not merely asserted. With the guard bypassed the ATTACH succeeds and the
    // read below returns [{"user":"root","token":"hunter2"}].
    assert.throws(
        () => guarded(db, `ATTACH DATABASE '${secret}' AS sec`),
        ReadOnlyViolation,
        'the guard let ATTACH reach the connection'
    );
    assert.throws(
        () => guarded(db, 'SELECT * FROM sec.creds'),
        /no such table: sec\.creds/,
        'a cross-database read resolved'
    );
});

// Why L3 exists at all, measured here rather than quoted from the plan: both statements
// run with nothing in front of them on a connection opened SQLITE_OPEN_READONLY.
test('a readonly connection runs PRAGMA writable_schema, and calls it read-only', t => {
    const db = readonlyFixture(t);
    const statement = db.prepare('PRAGMA writable_schema = ON');

    assert.equal(statement.readonly, true, 'L2 would have caught this');
    statement.run();

    assert.equal(refusal('PRAGMA writable_schema = ON').construct, 'PRAGMA');
});

test('a readonly connection runs CREATE TEMP TABLE, and the table is then real', t => {
    const db = readonlyFixture(t);
    const statement = db.prepare('CREATE TEMP TABLE t (x)');

    // Unlike ATTACH and PRAGMA writable_schema, this one L2 does catch: the engine calls
    // it a write even though the readonly flag still lets it run.
    assert.equal(statement.readonly, false);
    statement.run();
    assert.deepEqual(db.prepare('SELECT name FROM sqlite_temp_master').all(), [{ name: 't' }]);

    assert.equal(refusal('CREATE TEMP TABLE t (x)').construct, 'CREATE');
});

// Plan §6 cases 16-17 and the rest of the transaction and DDL verbs.
test('detach, maintenance and transaction verbs are all refused', () => {
    const verbs = {
        'DETACH DATABASE e': 'DETACH',
        VACUUM: 'VACUUM',
        REINDEX: 'REINDEX',
        BEGIN: 'BEGIN',
        'BEGIN IMMEDIATE': 'BEGIN',
        COMMIT: 'COMMIT',
        ROLLBACK: 'ROLLBACK',
        'SAVEPOINT s': 'SAVEPOINT',
        'RELEASE s': 'RELEASE',
        'TRUNCATE TABLE orders': 'TRUNCATE',
        'REPLACE INTO customers VALUES (1)': 'REPLACE'
    };
    for (const [sql, construct] of Object.entries(verbs)) {
        assert.equal(refusal(sql).construct, construct, `wrong construct for ${label(sql)}`);
    }
});

// Plan §6 case 19. EXPLAIN is read-only in itself, but it is not on the allow-list, and
// EXPLAIN <write> must never reach prepare().
test('EXPLAIN is not an allowed opener, with or without a write behind it', () => {
    assert.equal(refusal('EXPLAIN DELETE FROM orders').construct, 'DELETE');
    assert.equal(refusal('EXPLAIN QUERY PLAN SELECT 1').reason, 'DISALLOWED_OPENER');
});

// Plan §6 case 20.
test('matching is case- and whitespace-insensitive', () => {
    assert.equal(refusal('dElEtE   from\torders').construct, 'DELETE');
    assert.equal(refusal('\n\n  DrOp\n\tTable\torders\n').construct, 'DROP');
    allows('select 1 union all select 2');
});

// Plan §6 case 21. A real agent puts the user's sentence in the `sql` field, and
// "DELETE is forbidden" is the wrong thing to tell it — the fix is to write SQL at all.
test('natural language is refused with a distinct remedy from a forbidden verb', () => {
    const prose = refusal('Delete all cancelled orders.');
    assert.equal(prose.reason, 'NOT_SQL');
    assert.equal(prose.remedy, 'WRITE_SQL');

    const sql = refusal("DELETE FROM orders WHERE status='cancelled'");
    assert.equal(sql.reason, 'FORBIDDEN_VERB');
    assert.equal(sql.remedy, 'USE_SELECT');
});

test('prose that does not open with a verb is still reported as prose', () => {
    assert.equal(refusal('Show me the top spending customers').reason, 'NOT_SQL');
});

// ---------------------------------------------------------------------------
// CASE ... END: END is a transaction verb (a synonym for COMMIT) and also the closing
// keyword of an ordinary CASE expression, which analytical SQL is full of. Pairing is the
// resolution: an END that closes an open CASE is expression syntax, an unpaired one is
// the verb.
// ---------------------------------------------------------------------------

test('CASE ... END is allowed, including nested', () => {
    allows("SELECT CASE WHEN 1 THEN 'a' ELSE 'b' END AS c");
    allows('SELECT CASE WHEN 1 THEN CASE WHEN 2 THEN 3 END ELSE 4 END AS c');
    allows("SELECT SUM(CASE WHEN status = 'cancelled' THEN 0 ELSE total_amount END) FROM orders");
});

test('an END that closes no CASE is the transaction verb and is refused', () => {
    assert.equal(refusal('SELECT 1 END').construct, 'END');
    assert.equal(refusal('SELECT CASE WHEN 1 THEN 2 END END').construct, 'END');
});

// ---------------------------------------------------------------------------
// REPLACE is both a write statement (REPLACE INTO) and one of SQLite's most common
// scalar functions. Refusing every REPLACE would break ordinary analytical queries.
// ---------------------------------------------------------------------------

test('replace() the function is allowed while REPLACE INTO is refused', () => {
    allows("SELECT replace(name, 'a', 'b') FROM products");
    allows("SELECT replace (name, 'a', 'b') FROM products");
    allows("SELECT replace/* comment */(name, 'a', 'b') FROM products");
    assert.equal(refusal("REPLACE INTO customers VALUES (1, 'x')").construct, 'REPLACE');
    assert.equal(refusal('SELECT 1 UNION ALL REPLACE INTO t VALUES (1)').construct, 'REPLACE');
});

// load_extension() loads an arbitrary shared library. Measured on this build:
// sqlite3_stmt_readonly reports TRUE for it, so L2 does not catch it — better-sqlite3
// denies it at execution time, but the guard should name it rather than rely on that.
test('load_extension is refused', () => {
    assert.equal(refusal("SELECT load_extension('/tmp/x.so')").construct, 'LOAD_EXTENSION');
    allows('SELECT 1 AS "load_extension"');
});

test('a bare reserved word used as an alias is refused, a quoted one is allowed', () => {
    // `SELECT 1 AS insert` is a syntax error in SQLite anyway; the quoted form is legal.
    assert.equal(refusal('SELECT 1 AS insert').construct, 'INSERT');
    allows('SELECT 1 AS "insert"');
});

test('VALUES is an allowed opener', () => {
    allows('VALUES (1), (2)');
});

test('a leading semicolon is a second statement', () => {
    assert.equal(refusal('; SELECT 1').reason, 'MULTIPLE_STATEMENTS');
});

// ---------------------------------------------------------------------------
// What the violation carries, so task 10 can build a message from it
// ---------------------------------------------------------------------------

// Task 10 has to turn this into a refusal ending in the read-only equivalent. Rendering
// the surviving tokens gives it a normalized statement it can rewrite by swapping the
// leading verb, without ever re-parsing the raw input next to the security boundary.
test('the violation carries enough structure to build the read-only equivalent', () => {
    const err = refusal("DELETE FROM orders WHERE status='cancelled'");

    assert.equal(err.construct, 'DELETE');
    assert.equal(err.statement, "DELETE FROM orders WHERE status = 'cancelled'");
    assert.equal(err.statementTruncated, false);
    assert.equal(
        `SELECT * ${err.statement.slice('DELETE'.length).trim()}`,
        "SELECT * FROM orders WHERE status = 'cancelled'"
    );
});

// Nothing unbounded may reach a log or a message. The message is built from the construct
// alone, and the carried statement is capped.
test('neither the message nor the carried statement echoes the input unbounded', () => {
    const long = `DELETE FROM orders WHERE note = '${'x'.repeat(5000)}'`;
    const err = refusal(long);

    assert.ok(err.statement.length <= 201, `statement was ${err.statement.length} chars`);
    assert.equal(err.statementTruncated, true);
    assert.ok(err.message.length < 120, `message was ${err.message.length} chars`);
    assert.ok(!err.message.includes('xxxx'), 'the message echoed the input');

    const secret = refusal("DELETE FROM orders WHERE status='cancelled'");
    assert.ok(!secret.message.includes('cancelled'), 'the message echoed the input');
});

test('input far larger than any real query is refused before it is lexed', () => {
    const err = refusal(`SELECT ${'x'.repeat(200_000)}`);
    assert.equal(err.reason, 'TOO_LONG');

    // …but a genuinely large query, such as a wide IN list, still runs.
    const ids = Array.from({ length: 4000 }, (_, i) => i).join(', ');
    allows(`SELECT * FROM orders WHERE id IN (${ids})`);
});

// The docstring promises this function either returns or throws ReadOnlyViolation. Zod's
// z.string() keeps non-strings out at the tool boundary, but runQuery in src/db.js is a
// live internal caller, and task 10's sanitizer keys on err.code — which a TypeError
// raised by `sql.length` does not carry.
test('a non-string sql argument is a violation, not a TypeError', () => {
    for (const value of [null, undefined, 42, {}, [], true, Symbol('sql'), 1n]) {
        const err = refusal(value);
        assert.equal(err.code, 'READ_ONLY_VIOLATION', `wrong code for ${label(value)}`);
        assert.equal(err.reason, 'NOT_SQL', `wrong reason for ${label(value)}`);
        assert.equal(err.remedy, 'WRITE_SQL', `wrong remedy for ${label(value)}`);
    }
});
