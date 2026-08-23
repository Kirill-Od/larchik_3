import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const CORE = ['list_tables', 'describe_table', 'run_sql_query'];
const ANALYTICS = ['top_customers_by_spend', 'top_products_by_sales', 'revenue_by_period'];

async function withTools(assertions) {
    const client = await startServer();
    try {
        const { tools } = await client.listTools();
        await assertions(tools, client);
    } finally {
        await client.close();
    }
}

test('all six tools carry the read-only annotations and a substantial description', async () => {
    await withTools(tools => {
        const names = tools.map(t => t.name).sort();
        assert.deepEqual(names, [...CORE, ...ANALYTICS].sort());

        for (const tool of tools) {
            assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} readOnlyHint`);
            assert.equal(tool.annotations.destructiveHint, false, `${tool.name} destructiveHint`);
            assert.equal(tool.annotations.openWorldHint, false, `${tool.name} openWorldHint`);
            assert.ok(tool.description.length > 200, `${tool.name} description is ${tool.description.length} chars`);
        }
    });
});

// One author, one shape: the homework grades tool design, and six descriptions that answer
// the same four questions in the same order are what that looks like.
test('every description follows the WHEN TO USE / RETURNS / LIMITS house style', async () => {
    await withTools(tools => {
        for (const tool of tools) {
            const [first, blank] = tool.description.split('\n');
            assert.ok(first.length > 0 && !first.startsWith('WHEN'), `${tool.name} needs a summary line`);
            assert.equal(blank, '', `${tool.name} needs a blank line after its summary`);
            assert.match(tool.description, /WHEN TO USE:/, `${tool.name} has no WHEN TO USE`);
            assert.match(tool.description, /RETURNS:/, `${tool.name} has no RETURNS`);
            assert.match(tool.description, /LIMITS:/, `${tool.name} has no LIMITS`);
            assert.match(tool.description, /[Rr]ead-only/, `${tool.name} never says it is read-only`);
        }
    });
});

test('run_sql_query states both the row cap and what it refuses', async () => {
    await withTools(tools => {
        const description = tools.find(t => t.name === 'run_sql_query').description;
        assert.match(description, /1000/);
        for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'PRAGMA', 'ATTACH']) {
            assert.match(description, new RegExp(verb), `${verb} not listed as refused`);
        }
    });
});

test('describe_table tells the agent to confirm a column before querying it', async () => {
    await withTools(tools => {
        const description = tools.find(t => t.name === 'describe_table').description;
        assert.match(description, /confirm a column exists before/i);
        assert.match(description, /does not contain it/i);
    });
});

// The description used to promise the samples reveal "which years and formats it really
// covers". Half of that was false the moment 2025 orders were seeded behind the first three
// rows, and it is the half an agent acts on.
test('describe_table does not sell its sample rows as evidence of coverage', async () => {
    await withTools(tools => {
        const { description } = tools.find(t => t.name === 'describe_table');

        assert.match(description, /NOT A REPRESENTATIVE SAMPLE/);
        assert.match(description, /never\s+read coverage off them/i);
        assert.ok(!/years and formats it really covers/.test(description), description);
        // Disowning a reading is only half a fix; the agent needs the route that does work.
        assert.match(description, /MIN\/MAX/);
        assert.match(description, /available_range/);
    });
});

// Measured on the committed database: `WHERE order_date < '2026'` matches 0 of 960 rows and
// `>= '2026'` matches all 960, because DATETIME carries NUMERIC affinity and the bare year
// is coerced to an integer that every stored text date compares greater than. It returns a
// confident, wrong, zero — and only run_sql_query is exposed, since the analytics tools wrap
// the column in date().
test('run_sql_query warns that a bare-year literal silently matches nothing', async () => {
    await withTools(tools => {
        const { description } = tools.find(t => t.name === 'run_sql_query');

        assert.match(description, /NUMERIC affinity/);
        assert.match(description, /matches nothing at all/);
        assert.match(description, /2026-01-01/);
        assert.match(description, /strftime|date\(order_date\)/);
    });
});

test('list_tables tells the agent to call it first', async () => {
    await withTools(tools => {
        assert.match(tools.find(t => t.name === 'list_tables').description, /call this first/i);
    });
});

// The fourth mechanism plan §F2 assigns against the 2025 and Germany traps: the server
// tells the agent, once at initialize, to say what is missing rather than guess.
test('the server sends instructions that steer against guessing', async () => {
    const client = await startServer();
    try {
        const instructions = client.getInstructions();
        assert.ok(instructions && instructions.length > 100, `instructions were: ${instructions}`);

        assert.match(instructions, /read-only/i);
        assert.match(instructions, /list_tables/);
        assert.match(instructions, /describe_table/);
        assert.match(instructions, /verify.{0,40}column.{0,40}exists|confirm.{0,40}column/i);
        assert.match(instructions, /say/i);
        assert.match(instructions, /missing/i);
        assert.match(instructions, /guess/i);
        assert.match(instructions, /aggregate/i);
    } finally {
        await client.close();
    }
});
