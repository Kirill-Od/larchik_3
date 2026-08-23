import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeFixtureDb, toolJson } from './helpers.js';

async function listTablesVia(schemaSql) {
    const client = await startServer({ dbPath: makeFixtureDb(schemaSql) });
    try {
        const startedAt = Date.now();
        const result = await client.callTool({ name: 'list_tables', arguments: {} });
        const elapsedMs = Date.now() - startedAt;
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        return { tables: toolJson(result).tables, elapsedMs };
    } finally {
        await client.close();
    }
}

// A 1000-row table; a triple cross join over it is 1e9 rows.
const BIG = `CREATE TABLE big (x INTEGER);
    INSERT INTO big (x) SELECT x FROM (
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000)
        SELECT x FROM c
    );`;

// LIKE treats `_` as "any one character", so 'sqlite_%' also matches sqliteXtra and
// silently hides a legitimate user table from the agent.
test('a user table whose name begins with "sqlite" is listed, while sqlite_sequence is not', async () => {
    const { tables } = await listTablesVia(`
        CREATE TABLE sqliteXtra (a TEXT);
        INSERT INTO sqliteXtra (a) VALUES ('x'), ('y');
        CREATE TABLE counted (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
        INSERT INTO counted (v) VALUES ('one');
    `);

    const names = tables.map(t => t.name);
    assert.deepEqual(names.sort(), ['counted', 'sqliteXtra']);
    assert.equal(tables.find(t => t.name === 'sqliteXtra').row_count, 2);
});

// One unresolvable view must not take down the listing — this is the tool the agent is
// told to call first, so returning zero schema leaves it with nothing at all.
test('a broken view does not take down the listing', async () => {
    const { tables } = await listTablesVia(`
        CREATE TABLE kept (a TEXT);
        INSERT INTO kept (a) VALUES ('x');
        CREATE TABLE doomed (b TEXT);
        CREATE VIEW broken AS SELECT * FROM doomed;
        DROP TABLE doomed;
    `);

    assert.deepEqual(tables.map(t => t.name).sort(), ['broken', 'kept']);
    assert.equal(tables.find(t => t.name === 'kept').row_count, 1);

    const broken = tables.find(t => t.name === 'broken');
    assert.equal(broken.row_count, null);
    assert.ok(broken.note);
});

// LIMIT bounds the work only when the plan can stream. ORDER BY sorts the whole 1e9-row
// result before emitting anything, so counting this view costs ~19 s — on the call the
// agent is told to make first, in a synchronous server that can answer nothing meanwhile.
test('an expensive view does not slow the orientation call', { timeout: 60_000 }, async () => {
    const { tables, elapsedMs } = await listTablesVia(`
        ${BIG}
        CREATE VIEW sorted AS SELECT a.x FROM big a, big b, big c ORDER BY a.x;
    `);

    assert.equal(tables.find(t => t.name === 'big').row_count, 1000);
    assert.equal(tables.find(t => t.name === 'sorted').row_count, null);
    assert.ok(elapsedMs < 3000, `list_tables took ${elapsedMs} ms; it must not count views`);
});

// An aggregating view returns ONE row, so a row cap never trips and the result looks
// perfectly healthy — after a 6 s stall. The count must be refused, not merely capped.
test('an aggregating view is reported as uncounted rather than as a healthy count', async () => {
    const { tables } = await listTablesVia(`
        ${BIG}
        CREATE VIEW rollup AS SELECT COUNT(*) AS c FROM big a, big b, big c;
    `);

    const rollup = tables.find(t => t.name === 'rollup');
    assert.equal(rollup.row_count, null, 'a view must never report a row count');
    assert.match(rollup.note, /not counted/);
});

test('a table larger than the cap reports no count rather than scanning it all', async () => {
    const { tables } = await listTablesVia(`
        CREATE TABLE huge (x INTEGER);
        INSERT INTO huge (x) SELECT x FROM (
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100001)
            SELECT x FROM c
        );
    `);

    const huge = tables.find(t => t.name === 'huge');
    assert.equal(huge.row_count, null);
    assert.match(huge.note, /more than 100000 rows/);
});
