import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeFixtureDb, toolJson } from './helpers.js';

const NUMS = `CREATE TABLE nums (n INTEGER);
    INSERT INTO nums (n) SELECT x FROM (
        WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 150)
        SELECT x FROM c
    );`;

async function query(args, { dbPath } = {}) {
    const client = await startServer({ dbPath });
    try {
        const result = await client.callTool({ name: 'run_sql_query', arguments: args });
        return { result, body: result.isError ? null : toolJson(result) };
    } finally {
        await client.close();
    }
}

const text = result => result.content[0].text;

test('run_sql_query is advertised with sql, limit and offset', async () => {
    const client = await startServer();
    try {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'run_sql_query');
        assert.ok(tool, `run_sql_query missing from ${tools.map(t => t.name).join(', ')}`);
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['limit', 'offset', 'sql']);
        assert.deepEqual(tool.inputSchema.required, ['sql']);
    } finally {
        await client.close();
    }
});

// F7 ground truth: this is the join the agent must be able to run for homework task 6.
test('the three-table revenue join returns the real top-3 categories', async () => {
    const { result, body } = await query({
        sql: `SELECT p.category, SUM(oi.quantity * oi.unit_price) AS revenue
              FROM order_items oi
              JOIN products p ON p.id = oi.product_id
              GROUP BY p.category
              ORDER BY revenue DESC`,
        limit: 3
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.deepEqual(body.columns, ['category', 'revenue']);
    assert.deepEqual(body.rows, [
        { category: 'Электроника', revenue: 27529610 },
        { category: 'Бытовая техника', revenue: 8276500 },
        { category: 'Одежда и обувь', revenue: 4211080 }
    ]);
    assert.equal(body.row_count, 3);
});

// Homework task 2. `customers.country` is seeded by scripts/seed-extended-data.mjs; the
// count is pinned because a wrong-but-plausible number is the failure this whole design
// exists to prevent, and only an exact figure catches it.
test('the seeded geography answers "how many customers are from Germany"', async () => {
    const { result, body } = await query({
        sql: "SELECT COUNT(*) AS n FROM customers WHERE country = 'Germany'"
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.deepEqual(body.rows, [{ n: 24 }]);
});

// Homework task 3. Asserting the leader alone would pass on a tie, which is the one shape
// of answer the seed was designed to avoid, so the margin over second place is asserted too.
test('the seeded geography answers "which country has the most customers"', async () => {
    const { body } = await query({
        sql: `SELECT country, COUNT(*) AS n
              FROM customers
              GROUP BY country
              ORDER BY n DESC, country ASC`
    });

    assert.deepEqual(body.rows.slice(0, 3), [
        { country: 'Russia', n: 150 },
        { country: 'Germany', n: 24 },
        { country: 'France', n: 16 }
    ]);
    assert.equal(
        body.rows.reduce((total, row) => total + row.n, 0),
        235,
        'every customer must have a country, or the winner is only a winner among some of them'
    );
});

test('a write is refused before it reaches the database', async () => {
    const { result } = await query({ sql: "DELETE FROM orders WHERE status='cancelled'" });
    assert.equal(result.isError, true);
    assert.match(text(result), /READ_ONLY_VIOLATION/);
    assert.match(text(result), /DELETE/);
});

test('a query naming a column that does not exist reports SQLite own diagnosis', async () => {
    const { result } = await query({ sql: 'SELECT city FROM customers' });
    assert.equal(result.isError, true);
    assert.match(text(result), /SQL_ERROR/);
    assert.match(text(result), /no such column: city/);
});

// ---------------------------------------------------------------- pagination

test('a 150-row query with limit=10 pages and names the exact next call', async () => {
    const { body } = await query({ sql: 'SELECT n FROM nums ORDER BY n', limit: 10 }, { dbPath: makeFixtureDb(NUMS) });

    assert.equal(body.rows.length, 10);
    assert.equal(body.row_count, 10);
    assert.equal(body.has_more, true);
    assert.equal(body.rows[0].n, 1);
    assert.match(body.notes, /offset=10/);
});

test('the final page reports has_more false', async () => {
    const { body } = await query(
        { sql: 'SELECT n FROM nums ORDER BY n', limit: 10, offset: 145 },
        { dbPath: makeFixtureDb(NUMS) }
    );

    assert.equal(body.rows.length, 5);
    assert.equal(body.has_more, false);
    assert.equal(body.rows[0].n, 146);
    assert.ok(!body.notes.includes('offset='), `notes should not offer a next page: ${body.notes}`);
});

test('an offset past the end returns no rows rather than an error', async () => {
    const { result, body } = await query(
        { sql: 'SELECT n FROM nums ORDER BY n', offset: 500 },
        { dbPath: makeFixtureDb(NUMS) }
    );
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.deepEqual(body.rows, []);
    assert.equal(body.row_count, 0);
    assert.equal(body.has_more, false);
});

test('limit outside the accepted range is refused and the range is named', async () => {
    for (const limit of [0, 5000]) {
        const { result } = await query({ sql: 'SELECT 1', limit });
        assert.equal(result.isError, true, `limit=${limit} was accepted`);
        assert.match(text(result), /INVALID_ARGUMENT/);
        assert.match(text(result), /1 (to|and) 1000/, `range not named for limit=${limit}: ${text(result)}`);
    }
});

// Appending "LIMIT n OFFSET m" to this would be a syntax error, and to a compound SELECT it
// would change the meaning. Paging by iterating is what keeps the agent's SQL untouched.
test("a query carrying its own LIMIT is paged without being rewritten", async () => {
    const dbPath = makeFixtureDb(NUMS);

    const whole = await query({ sql: 'SELECT n FROM nums ORDER BY n LIMIT 7' }, { dbPath });
    assert.notEqual(whole.result.isError, true, whole.result.content?.[0]?.text);
    assert.equal(whole.body.rows.length, 7);
    assert.equal(whole.body.has_more, false);

    const paged = await query({ sql: 'SELECT n FROM nums ORDER BY n LIMIT 7', limit: 3 }, { dbPath });
    assert.deepEqual(paged.body.rows.map(r => r.n), [1, 2, 3]);
    assert.equal(paged.body.has_more, true);

    const tail = await query({ sql: 'SELECT n FROM nums ORDER BY n LIMIT 7', limit: 3, offset: 3 }, { dbPath });
    assert.deepEqual(tail.body.rows.map(r => r.n), [4, 5, 6]);
});

test('a compound SELECT survives paging', async () => {
    const { result, body } = await query({
        sql: 'SELECT 1 AS v UNION ALL SELECT 2 UNION ALL SELECT 3',
        limit: 2
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.deepEqual(body.rows.map(r => r.v), [1, 2]);
    assert.equal(body.has_more, true);
});

// ---------------------------------------------------------------- values

test('every SQLite value type round-trips without throwing', async () => {
    const { result, body } = await query({
        sql: 'SELECT randomblob(10) AS b, 9223372036854775807 AS big, NULL AS n, 1.5 AS f, \'t\' AS s'
    });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    const [row] = body.rows;
    assert.match(row.b, /^<BLOB 10 bytes>$/);
    assert.equal(row.n, null);
    assert.equal(row.f, 1.5);
    assert.equal(row.s, 't');
});

test('an oversized cell is truncated with a marker and called out in notes', async () => {
    const { body } = await query({
        sql: "SELECT printf('%.100000c', 'x') AS big"
    });

    assert.ok(body.rows[0].big.length < 5000, `cell not truncated: ${body.rows[0].big.length} chars`);
    assert.match(body.rows[0].big, /truncated from 100000 chars/);
    assert.match(body.notes, /truncat/i);
});

// One coercer, two caps: three sample rows must stay small, a query result may be large.
test('sample rows are capped tighter than query results', async () => {
    const dbPath = makeFixtureDb(`
        CREATE TABLE wide (t TEXT);
        INSERT INTO wide (t) VALUES (printf('%.1000c', 'y'));
    `);

    const viaQuery = await query({ sql: 'SELECT t FROM wide' }, { dbPath });
    assert.equal(viaQuery.body.rows[0].t.length, 1000, 'a 1000-char cell is under the 4 KB query cap');

    const client = await startServer({ dbPath });
    try {
        const described = toolJson(
            await client.callTool({ name: 'describe_table', arguments: { table_name: 'wide' } })
        );
        assert.ok(
            described.sample_rows[0].t.length < 400,
            `sample cell not capped tighter: ${described.sample_rows[0].t.length} chars`
        );
        assert.match(described.sample_rows[0].t, /truncated from 1000 chars/);
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------- deadline

// A fast cross join is NOT a timeout case: the row cap answers it correctly in
// milliseconds. Asserting a timeout here would only pass by breaking pagination.
test('a fast cross join is answered by the row cap, not by an error', async () => {
    const startedAt = Date.now();
    const { result, body } = await query({
        sql: 'SELECT a.id FROM order_items a, order_items b, order_items c'
    });

    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(body.row_count, 100);
    assert.equal(body.has_more, true);
    assert.ok(Date.now() - startedAt < 10_000);
});

// What the deadline is really for: rows that are individually expensive, so the page never
// fills and the query would otherwise run for minutes. ~95 ms per row on this database.
test('a query with expensive rows is cut off instead of hanging the server', { timeout: 120_000 }, async () => {
    const startedAt = Date.now();
    const { result } = await query({
        sql: `SELECT o.id, (SELECT COUNT(*) FROM order_items a, order_items b
                            WHERE a.id * b.id > o.id) AS k
              FROM orders o`
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.isError, true);
    assert.match(text(result), /QUERY_TIMEOUT/);
    assert.match(text(result), /WHERE clause/, `no concrete advice: ${text(result)}`);
    assert.match(text(result), /join fewer tables/, `no concrete advice: ${text(result)}`);
    assert.ok(elapsedMs < 30_000, `took ${elapsedMs} ms`);
});

// The deadline only fires between rows, so it cannot interrupt a plan that must finish
// sorting or grouping before row one. That hole has to be stated where the agent reads.
test('the description does not promise a general timeout', async () => {
    const client = await startServer();
    try {
        const { tools } = await client.listTools();
        const description = tools.find(t => t.name === 'run_sql_query').description;
        assert.match(description, /1000/, 'the row cap must be stated');
        assert.match(description, /read-only/i);
        // NOT /sort|group/ — the WHEN TO USE line already says "grouping", so that would
        // match with the whole caveat deleted. These two clauses exist only in the caveat.
        assert.match(description, /only applies once rows start arriving/, `the deadline hole is not disclosed: ${description}`);
        assert.match(description, /can still run for a long time/, `the consequence is not stated: ${description}`);
        // NOT /aggregate/ — the WHEN TO USE line already says "aggregates". The bare
        // aggregate is the worst shape measured, so the caveat has to name it specifically.
        assert.match(description, /computes its whole result first/, `the worst shape is not named: ${description}`);
        assert.match(description, /COUNT\(\*\)/, `the worst shape is not named: ${description}`);
    } finally {
        await client.close();
    }
});

// ---------------------------------------------------------------- response size

const WIDE = cols => `CREATE TABLE w (${cols.map((_, i) => `c${i} TEXT`).join(', ')});
    INSERT INTO w SELECT ${cols.map(() => "printf('%.5000c','z')").join(', ')}
    FROM (WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<100) SELECT i FROM r);`;

// The row cap is not a size cap: 1000 rows x 8 columns x the 4096-char cell cap is 31 MB,
// and the column count is whatever the agent selected. Per-cell truncation alone cannot
// bound this, and a synchronous stdio server cannot afford to serialize it.
test('a wide result is bounded by total size, not just by the row cap', async () => {
    const dbPath = makeFixtureDb(WIDE(Array(8).fill(0)));
    const client = await startServer({ dbPath });
    try {
        const result = await client.callTool({
            name: 'run_sql_query',
            arguments: { sql: 'SELECT * FROM w', limit: 1000 }
        });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);

        const payload = result.content[0].text;
        assert.ok(payload.length < 400_000, `response was ${payload.length} chars`);

        const body = JSON.parse(payload);
        assert.ok(body.rows.length < 100, `returned ${body.rows.length} rows unbounded`);
        assert.equal(body.has_more, true);
        assert.match(body.notes, /response/i);
        assert.match(body.notes, /offset=/);
    } finally {
        await client.close();
    }
});

// A single row wider than the whole budget must still come back — returning nothing with
// no rows to show would be worse than returning the one row the agent asked about.
test('one row larger than the budget is still returned', async () => {
    // 80 columns x the 4096-char cell cap is ~330 KB serialized, comfortably past the
    // 256 KB budget — at 20 columns the row fits and the exemption is never exercised.
    const dbPath = makeFixtureDb(`CREATE TABLE one (${Array(80).fill(0).map((_, i) => `c${i} TEXT`).join(', ')});
        INSERT INTO one VALUES (${Array(80).fill("printf('%.5000c','z')").join(', ')});`);

    const { result, body } = await query({ sql: 'SELECT * FROM one' }, { dbPath });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    assert.equal(body.rows.length, 1, 'the only row must come back even though it alone busts the budget');
    assert.equal(body.has_more, false);
    assert.ok(result.content[0].text.length > 262_144, 'the fixture must actually exceed the budget');
});

// The gate-2 `note` mechanism exists for exactly this disclosure, and sample rows were the
// one place a truncation marker had no authoritative counterpart the agent could trust.
test('describe_table says when its own sample cells were truncated', async () => {
    const dbPath = makeFixtureDb(WIDE(Array(2).fill(0)));
    const client = await startServer({ dbPath });
    try {
        const described = toolJson(
            await client.callTool({ name: 'describe_table', arguments: { table_name: 'w' } })
        );
        assert.match(described.sample_rows[0].c0, /truncated from 5000 chars/);
        assert.match(described.note, /sample cell/i);
        assert.match(described.note, /truncated/i);
    } finally {
        await client.close();
    }
});
