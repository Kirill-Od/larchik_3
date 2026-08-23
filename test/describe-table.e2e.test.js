import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeFixtureDb, toolJson } from './helpers.js';

const viewFixture = () => makeFixtureDb(`
    CREATE TABLE base (a TEXT, b INTEGER);
    INSERT INTO base (a, b) VALUES ('x', 1), ('y', 2);
    CREATE VIEW v AS SELECT a FROM base;
`);

const brokenViewFixture = () => makeFixtureDb(`
    CREATE TABLE gone (a TEXT);
    CREATE VIEW brokenview AS SELECT * FROM gone;
    DROP TABLE gone;
`);

async function describe(tableName, { dbPath } = {}) {
    const client = await startServer({ dbPath });
    try {
        const result = await client.callTool({
            name: 'describe_table',
            arguments: { table_name: tableName }
        });
        return { result, body: result.isError ? null : toolJson(result) };
    } finally {
        await client.close();
    }
}

test('describe_table is advertised alongside list_tables', async () => {
    const client = await startServer();
    try {
        const { tools } = await client.listTools();
        const tool = tools.find(t => t.name === 'describe_table');
        assert.ok(tool, `describe_table missing from ${tools.map(t => t.name).join(', ')}`);
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.deepEqual(Object.keys(tool.inputSchema.properties), ['table_name']);
    } finally {
        await client.close();
    }
});

// `country` was seeded by scripts/seed-extended-data.mjs and homework tasks 2 and 3 depend
// on it, so it must be discoverable. The finer geography the data still does not have must
// stay absent: an agent that reads `city` here would invent a breakdown nothing supports.
test('describe_table(customers) returns exactly the seven real columns, country included', async () => {
    const { result, body } = await describe('customers');
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    const names = body.columns.map(c => c.name);
    assert.deepEqual(names, ['id', 'first_name', 'last_name', 'email', 'phone', 'created_at', 'country']);
    assert.ok(!names.includes('city'), 'a city column must not be invented');
    assert.ok(!names.includes('address'));
    assert.ok(!JSON.stringify(body).toLowerCase().includes('city'));
});

test('describe_table(customers) reports column type, nullability and primary key', async () => {
    const { body } = await describe('customers');
    const byName = Object.fromEntries(body.columns.map(c => [c.name, c]));

    assert.deepEqual(byName.id, { name: 'id', type: 'INTEGER', not_null: false, primary_key: true, default: null });
    assert.deepEqual(byName.phone, { name: 'phone', type: 'TEXT', not_null: false, primary_key: false, default: null });
    assert.equal(byName.first_name.not_null, true);
});

// The sample rows are what let the agent see that country and phone agree rather than
// guessing at either. The first three rows are provided customers, so they are the Russian
// ones; asserting a count would not prove the two columns are coherent.
test('describe_table(customers) sample rows show a +79 phone against country Russia', async () => {
    const { body } = await describe('customers');

    assert.equal(body.sample_rows.length, 3);
    for (const row of body.sample_rows) {
        assert.match(row.phone, /^\+79\d+$/, `expected a +79 phone, got ${row.phone}`);
        assert.equal(row.country, 'Russia', `a +79 phone must not sit against ${row.country}`);
        assert.ok(row.email.includes('@'));
    }
});

// The samples are the first three rows in storage order, which for `orders` are all 2026
// while a fifth of the table is 2025. The documented path to a date question runs through
// describe_table, so an agent that reads coverage off three rows answers zero for 2025 —
// the exact hallucination the rest of this design exists to prevent. The payload therefore
// has to disown the reading, in `note`, where the agent gets it without a second call.
test('describe_table(orders) disowns its sample rows as evidence of which years exist', async () => {
    const { body } = await describe('orders');

    assert.equal(body.sample_rows.length, 3);
    for (const row of body.sample_rows) {
        assert.match(row.order_date, /^2026-/, `expected a 2026 order_date, got ${row.order_date}`);
    }
    // Precondition: with no rows outside the sampled year the warning would be pedantry.
    assert.ok(body.row_count > 900, `only ${body.row_count} orders`);

    assert.match(body.note, /first 3 rows in storage order/i, body.note);
    assert.match(body.note, /not a representative sample/i, body.note);
    assert.match(body.note, /do not infer date ranges/i, body.note);
});

// The whole table fitting in the sample is the one case where the samples ARE the coverage,
// and a warning there would teach the agent to distrust a payload it can trust.
test('a table smaller than the sample carries no not-representative warning', async () => {
    const { body } = await describe('base', { dbPath: viewFixture() });

    assert.equal(body.row_count, 2);
    assert.equal(body.sample_rows.length, 2);
    assert.ok(
        !/representative/.test(body.note ?? ''),
        `the sample is the whole table, so nothing needs disowning: ${body.note}`
    );
});

// The five status values exist only inside the CHECK constraint in the DDL. Without this,
// the agent has to guess them or discover them by trial and error.
test('describe_table(orders) exposes the five status CHECK values', async () => {
    const { body } = await describe('orders');

    const checks = body.check_constraints.join(' ');
    for (const status of ['new', 'processing', 'shipped', 'completed', 'cancelled']) {
        assert.ok(checks.includes(`'${status}'`), `status '${status}' not discoverable in ${checks}`);
    }
});

test('describe_table(order_items) names both foreign key targets', async () => {
    const { body } = await describe('order_items');

    const targets = body.foreign_keys.map(fk => `${fk.column}->${fk.references}`).sort();
    assert.deepEqual(targets, ['order_id->orders(id)', 'product_id->products(id)']);
    assert.ok(body.check_constraints.some(c => c.includes('quantity')));
});

test('describe_table(customers) reports the unique index on email', async () => {
    const { body } = await describe('customers');

    const unique = body.indexes.find(i => i.unique);
    assert.ok(unique, `no unique index in ${JSON.stringify(body.indexes)}`);
    assert.deepEqual(unique.columns, ['email']);
});

test('describe_table(nope) errors and names the four real tables', async () => {
    const { result } = await describe('nope');
    assert.equal(result.isError, true);

    const message = result.content[0].text;
    for (const name of ['customers', 'products', 'orders', 'order_items']) {
        assert.ok(message.includes(name), `${name} missing from: ${message}`);
    }
});

// The `note` must carry the explanation the view branch exists to produce. Matching only
// /view/i would also match countRows' "views are not counted", so it would still pass with
// the whole view branch reverted — assert the clause only this mechanism can emit.
test('describe_table on a view explains what a view does not have', async () => {
    const { result, body } = await describe('v', { dbPath: viewFixture() });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.equal(body.type, 'view');
    assert.deepEqual(body.columns.map(c => c.name), ['a']);
    assert.deepEqual(body.foreign_keys, []);
    assert.deepEqual(body.check_constraints, []);
    assert.deepEqual(body.indexes, []);
    assert.match(body.note, /no foreign keys, CHECK constraints or indexes of its own/);
    assert.match(body.sql, /CREATE VIEW/i);
});

test('describe_table on a view says why it carries no sample rows', async () => {
    const { body } = await describe('v', { dbPath: viewFixture() });

    assert.deepEqual(body.sample_rows, []);
    assert.match(body.note, /sample rows not taken/);
});

// LIMIT does not bound a view: measured on this fixture, ORDER BY costs ~19 s and GROUP BY
// ~74 s, because the sort or grouping must complete before any row exists. better-sqlite3
// exposes no interrupt, so the only safe bound is not to run it.
test('describing an expensive view is fast', { timeout: 60_000 }, async () => {
    const dbPath = makeFixtureDb(`
        CREATE TABLE big (x INTEGER);
        INSERT INTO big (x) SELECT x FROM (
            WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000)
            SELECT x FROM c
        );
        CREATE VIEW sorted AS SELECT a.x FROM big a, big b, big c ORDER BY a.x;
    `);

    const client = await startServer({ dbPath });
    try {
        const startedAt = Date.now();
        const result = await client.callTool({
            name: 'describe_table',
            arguments: { table_name: 'sorted' }
        });
        const elapsedMs = Date.now() - startedAt;

        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        assert.deepEqual(toolJson(result).sample_rows, []);
        assert.ok(elapsedMs < 3000, `describe_table took ${elapsedMs} ms; it must not sample views`);
    } finally {
        await client.close();
    }
});

// Guard against over-correcting finding 2: tables must still be sampled.
test('tables are still sampled after views stopped being sampled', async () => {
    const { body } = await describe('base', { dbPath: viewFixture() });
    assert.deepEqual(body.sample_rows, [{ a: 'x', b: 1 }, { a: 'y', b: 2 }]);
});

// list_tables advertises this view, so describe_table must have something to say about it.
// Returning isError tells the agent that `main.gone` is missing — a name it has never seen
// and cannot act on — while the columns, definition and FK/index facts were all available.
test('a broken view degrades instead of failing the whole call', async () => {
    const { result, body } = await describe('brokenview', { dbPath: brokenViewFixture() });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.equal(body.name, 'brokenview');
    assert.equal(body.type, 'view');
    assert.match(body.sql, /CREATE VIEW brokenview/i);
    assert.deepEqual(body.foreign_keys, []);
    assert.deepEqual(body.indexes, []);
    assert.deepEqual(body.columns, []);
    assert.match(body.note, /columns unavailable/);
    assert.match(body.note, /no such table: main\.gone/);
});

// "you named something that does not exist" and "this object is broken" must not reach the
// agent as the same shape; only the first can be fixed by picking another name.
test('a broken object and an unknown name are distinguishable', async () => {
    const dbPath = brokenViewFixture();
    const broken = await describe('brokenview', { dbPath });
    const unknown = await describe('nope', { dbPath });

    assert.notEqual(broken.result.isError, true);
    assert.equal(unknown.result.isError, true);

    // Only the unknown-name case lists what does exist.
    assert.match(unknown.result.content[0].text, /This database contains: brokenview/);
    assert.ok(!broken.body.note.includes('This database contains'));
});

test('a BLOB or oversized cell in a sample row does not break the call', async () => {
    const dbPath = makeFixtureDb(`
        CREATE TABLE odd (b BLOB, big TEXT);
        INSERT INTO odd (b, big) VALUES (randomblob(16), (SELECT group_concat('x') FROM
            (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<9000) SELECT i FROM c)));
    `);
    const { result, body } = await describe('odd', { dbPath });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    const [row] = body.sample_rows;
    assert.match(row.b, /BLOB/);
    assert.ok(row.big.length < 1000, `oversized cell was not truncated: ${row.big.length} chars`);
});

// A CHECK spelled inside a string literal is not a constraint, and a parenthesis inside a
// literal must not unbalance the match. Scanning the raw DDL gets both of these wrong.
test('a CHECK inside a string literal is not reported as a constraint', async () => {
    const dbPath = makeFixtureDb(`
        CREATE TABLE tricky (
            a TEXT DEFAULT 'CHECK(not a constraint',
            b INTEGER CHECK(b > 0 AND b < 10)
        );
        INSERT INTO tricky (b) VALUES (5);
    `);
    const { result, body } = await describe('tricky', { dbPath });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);

    assert.deepEqual(body.check_constraints, ['b > 0 AND b < 10']);
});
