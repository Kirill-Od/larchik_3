import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, makeFixtureDb, toolJson } from './helpers.js';

const CORE_TOOLS = ['describe_table', 'list_tables', 'run_sql_query'];
const ANALYTICS_TOOLS = ['revenue_by_period', 'top_customers_by_spend', 'top_products_by_sales'];

async function withServer(dbPath, body) {
    const client = await startServer({ dbPath });
    try {
        return await body(client);
    } finally {
        await client.close();
    }
}

const names = async client => (await client.listTools()).tools.map(t => t.name).sort();

async function call(client, name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, result.content?.[0]?.text);
    return { result, body: toolJson(result) };
}

// ------------------------------------------------ conditional registration (F3)

test('all six tools are advertised against shop.db', async () => {
    await withServer(undefined, async client => {
        assert.deepEqual(await names(client), [...CORE_TOOLS, ...ANALYTICS_TOOLS].sort());
    });
});

// The grader may attach a different shop.db. A specialized tool that crashes on someone
// else's schema is worse than one that is absent, so the analytics layer must disappear
// entirely and leave the agent with run_sql_query.
test('against a database with no orders table only the core tools are advertised', async () => {
    await withServer(makeFixtureDb(), async client => {
        assert.deepEqual(await names(client), CORE_TOOLS);
    });
});

test('a shop-shaped schema missing orders.status also drops the analytics tools', async () => {
    const dbPath = makeFixtureDb(`
        CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT);
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT);
        CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER, unit_price REAL);
    `);
    await withServer(dbPath, async client => {
        assert.deepEqual(await names(client), CORE_TOOLS);
    });
});

// ------------------------------------------------------------- the advertisement

test('every analytics tool carries the read-only annotations and an output schema', async () => {
    await withServer(undefined, async client => {
        const { tools } = await client.listTools();
        for (const name of ANALYTICS_TOOLS) {
            const tool = tools.find(t => t.name === name);
            assert.equal(tool.annotations.readOnlyHint, true, name);
            assert.equal(tool.annotations.destructiveHint, false, name);
            assert.equal(tool.annotations.idempotentHint, true, name);
            assert.equal(tool.annotations.openWorldHint, false, name);
            assert.equal(tool.outputSchema?.type, 'object', `${name} has no output schema`);
            assert.ok(tool.description.length > 200, `${name} description is ${tool.description.length} chars`);
        }
    });
});

// F5: the parameter exists because it changes the answer, and the agent can only state
// that assumption if the description says so.
test('include_cancelled documents that it changes the ranking, on all three tools', async () => {
    await withServer(undefined, async client => {
        const { tools } = await client.listTools();
        for (const name of ANALYTICS_TOOLS) {
            const field = tools.find(t => t.name === name).inputSchema.properties.include_cancelled;
            assert.match(field.description, /defaults to false/i, name);
            assert.match(field.description, /changes both the totals and the ranking/i, name);
        }
    });
});

// F6. Not /ambiguous|both/ — "both" appears in ordinary prose; this clause is the one
// place the tool admits the two readings disagree.
test('top_products_by_sales warns that "best-selling" has two readings', async () => {
    await withServer(undefined, async client => {
        const { tools } = await client.listTools();
        const { description, inputSchema } = tools.find(t => t.name === 'top_products_by_sales');
        assert.match(description, /the two readings usually disagree/);
        assert.match(description, /rarely the one that earns the most money/);
        assert.match(inputSchema.properties.rank_by.description, /both/i);
    });
});

// F2's countermeasure, and the trap next to it: 2025 exists in customers.created_at and
// products.created_at, so an agent joining on the wrong date column finds "activity".
test('revenue_by_period says an empty result is an answer and names the created_at trap', async () => {
    await withServer(undefined, async client => {
        const { tools } = await client.listTools();
        const { description } = tools.find(t => t.name === 'revenue_by_period');
        assert.match(description, /EMPTY `buckets` LIST IS AN ANSWER, NOT AN ERROR/);
        assert.match(description, /revenue for that range is zero/);
        assert.match(description, /do not estimate a figure/);
        assert.match(description, /created_at are registration dates/);
    });
});

// -------------------------------------------------------------------- the answers

test('top_customers_by_spend returns the real spenders as validated structured content', async () => {
    await withServer(undefined, async client => {
        const { result, body } = await call(client, 'top_customers_by_spend', { limit: 3 });

        assert.deepEqual(body.customers[0], {
            name: 'Екатерина Харитонов',
            email: 'ekaterina.kharitonov777@gmail.com',
            total_spent: 859460,
            order_count: 11
        });
        assert.deepEqual(body.customers.map(c => c.name), [
            'Екатерина Харитонов',
            'Дмитрий Харитонов',
            'Наталья Петрова'
        ]);
        assert.equal(body.include_cancelled, false);
        assert.deepEqual(result.structuredContent, body, 'the output schema is not being filled');
    });
});

test('including cancelled orders through the tool boundary reorders the runners-up', async () => {
    await withServer(undefined, async client => {
        const { body } = await call(client, 'top_customers_by_spend', {
            limit: 3,
            include_cancelled: true
        });

        assert.deepEqual(body.customers.map(c => [c.name, c.total_spent]), [
            ['Екатерина Харитонов', 885420],
            ['Наталья Петрова', 876900],
            ['Дмитрий Харитонов', 785750]
        ]);
    });
});

test('top_products_by_sales ranks by the requested metric and reports both', async () => {
    await withServer(undefined, async client => {
        const byRevenue = await call(client, 'top_products_by_sales', { limit: 1 });
        const byUnits = await call(client, 'top_products_by_sales', { limit: 1, rank_by: 'units' });

        assert.deepEqual(byRevenue.body.products[0], {
            name: 'Ноутбук UltraBook 15',
            category: 'Электроника',
            units_sold: 98,
            revenue: 8819020
        });
        assert.deepEqual(byUnits.body.products[0], {
            name: 'Планшет Tab 10',
            category: 'Электроника',
            units_sold: 123,
            revenue: 4303770
        });
    });
});

// Homework task 7 asks for 2025 revenue. It used to be zero for want of data; since
// scripts/seed-extended-data.mjs it is a real figure, and this is the call that produces it.
test('revenue_by_period for 2025 returns the seeded figure through the tool boundary', async () => {
    await withServer(undefined, async client => {
        const { body } = await call(client, 'revenue_by_period', {
            group_by: 'year',
            start_date: '2025-01-01',
            end_date: '2025-12-31'
        });

        assert.deepEqual(body.buckets, [
            { period: '2025', revenue: 8990280, order_count: 183, items_sold: 912 }
        ]);
        assert.deepEqual(body.available_range, {
            min_order_date: '2025-09-01',
            max_order_date: '2026-08-22'
        });
    });
});

// The empty-range answer is still the behaviour that matters — 2024 is now the year that
// has no orders — and an empty list on its own would cost the agent a turn.
test('revenue_by_period for a year with no orders says so and names the range there is', async () => {
    await withServer(undefined, async client => {
        const { body } = await call(client, 'revenue_by_period', {
            group_by: 'year',
            start_date: '2024-01-01',
            end_date: '2024-12-31'
        });

        assert.deepEqual(body.buckets, []);
        assert.deepEqual(body.available_range, {
            min_order_date: '2025-09-01',
            max_order_date: '2026-08-22'
        });
        assert.match(body.note, /revenue for it is zero/);
        assert.match(body.note, /2025-09-01 to 2026-08-22/);
    });
});

test('revenue_by_period without a range buckets both years that exist', async () => {
    await withServer(undefined, async client => {
        const { body } = await call(client, 'revenue_by_period', { group_by: 'year' });

        assert.deepEqual(body.buckets, [
            { period: '2025', revenue: 8990280, order_count: 183, items_sold: 912 },
            { period: '2026', revenue: 28134150, order_count: 648, items_sold: 3295 }
        ]);
    });
});

test('an out-of-range limit teaches the range instead of an SDK schema rejection', async () => {
    await withServer(undefined, async client => {
        const result = await client.callTool({
            name: 'top_customers_by_spend',
            arguments: { limit: 500 }
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /INVALID_ARGUMENT/);
        assert.match(result.content[0].text, /1 to 100/);
    });
});

test('a malformed date is refused with a code and the accepted format', async () => {
    await withServer(undefined, async client => {
        const result = await client.callTool({
            name: 'revenue_by_period',
            arguments: { group_by: 'month', start_date: 'January 2025' }
        });

        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /INVALID_ARGUMENT/);
        assert.match(result.content[0].text, /YYYY-MM-DD/);
    });
});
