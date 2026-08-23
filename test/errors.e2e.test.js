import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

const CUSTOMER_COLUMNS = ['id', 'first_name', 'last_name', 'email', 'phone', 'created_at'];
const TABLES = ['customers', 'products', 'orders', 'order_items'];

async function failing(name, args) {
    const client = await startServer();
    try {
        const result = await client.callTool({ name, arguments: args });
        assert.equal(result.isError, true, `expected a refusal, got ${result.content[0].text}`);
        return result.content[0].text;
    } finally {
        await client.close();
    }
}

const sql = statement => failing('run_sql_query', { sql: statement });

// F1. The whole point: the agent asks for a column that does not exist, and the refusal
// hands back the columns that do, so it can conclude the data has no geography rather than
// inventing "Germany: 12".
test('a missing column is answered with the columns that do exist', async () => {
    const message = await sql('SELECT country FROM customers');

    assert.match(message, /SQL_ERROR/);
    assert.match(message, /no such column: country/);
    for (const column of CUSTOMER_COLUMNS) {
        assert.match(message, new RegExp(`\\b${column}\\b`), `${column} missing from: ${message}`);
    }
    assert.match(message, /does not contain it/i, `no honesty nudge in: ${message}`);
});

test('a missing table is answered with the tables that do exist', async () => {
    const message = await sql('SELECT * FROM nope');

    assert.match(message, /SQL_ERROR/);
    assert.match(message, /no such table: nope/);
    for (const table of TABLES) {
        assert.match(message, new RegExp(`\\b${table}\\b`), `${table} missing from: ${message}`);
    }
});

// The literal homework case. A refusal that only says "denied" wastes the agent's turn.
test('the cancelled-orders delete is refused with its read-only equivalent', async () => {
    const message = await sql("DELETE FROM orders WHERE status='cancelled'");

    assert.match(message, /READ_ONLY_VIOLATION/);
    assert.ok(
        message.includes("SELECT * FROM orders WHERE status = 'cancelled'"),
        `no usable equivalent offered in: ${message}`
    );
});

test('an update is refused with the select that inspects the same rows', async () => {
    const message = await sql('UPDATE products SET price = 0 WHERE id = 3');
    assert.ok(message.includes('SELECT * FROM products WHERE id = 3'), message);
});

test('an insert is refused with a select against the same table', async () => {
    const message = await sql("INSERT INTO customers (first_name) VALUES ('x')");
    assert.ok(message.includes('SELECT * FROM customers'), message);
});

// Three refusals whose fixes differ must not read the same. `remedy` already distinguishes
// them in the guard; the message layer has to preserve that.
test('refusals with different fixes give different instructions', async () => {
    const pragma = await sql('PRAGMA table_info(orders)');
    const prose = await sql('Delete all cancelled orders.');
    const twoStatements = await sql('SELECT 1; DELETE FROM orders');

    assert.match(pragma, /describe_table/, `PRAGMA should point at the right tool: ${pragma}`);
    assert.match(prose, /write.{0,20}SQL/i, `prose should be told to send SQL: ${prose}`);
    assert.ok(!/describe_table/.test(prose), 'prose must not get the PRAGMA remedy');
    assert.match(twoStatements, /one statement/i, twoStatements);
    assert.ok(!/write.{0,20}SQL/i.test(twoStatements), 'a two-statement call is already SQL');
});

// Plan §6 asks for this as a property of every error the suite produces, not a spot check.
test('no error message anywhere leaks a filesystem path or a stack frame', async () => {
    const client = await startServer();
    const messages = [];
    try {
        const calls = [
            ['run_sql_query', { sql: 'SELECT country FROM customers' }],
            ['run_sql_query', { sql: 'SELECT * FROM nope' }],
            ['run_sql_query', { sql: "DELETE FROM orders WHERE status='cancelled'" }],
            ['run_sql_query', { sql: 'INSERT INTO customers (first_name) VALUES (\'x\')' }],
            ['run_sql_query', { sql: 'UPDATE products SET price = 0' }],
            ['run_sql_query', { sql: 'DROP TABLE orders' }],
            ['run_sql_query', { sql: 'ALTER TABLE orders ADD COLUMN x TEXT' }],
            ['run_sql_query', { sql: 'CREATE TEMP TABLE t (x)' }],
            ['run_sql_query', { sql: 'SELECT 1; DELETE FROM orders' }],
            ['run_sql_query', { sql: '-- harmless\nDELETE FROM orders' }],
            ['run_sql_query', { sql: '/* SELECT */ DELETE FROM orders' }],
            ['run_sql_query', { sql: 'WITH x AS (SELECT 1) DELETE FROM orders' }],
            ['run_sql_query', { sql: 'PRAGMA writable_schema = ON' }],
            ['run_sql_query', { sql: 'ATTACH DATABASE \'/tmp/evil.db\' AS e' }],
            ['run_sql_query', { sql: 'VACUUM' }],
            ['run_sql_query', { sql: 'EXPLAIN DELETE FROM orders' }],
            ['run_sql_query', { sql: 'Delete all cancelled orders.' }],
            ['run_sql_query', { sql: 'SELECT * FROM customers', limit: 0 }],
            ['run_sql_query', { sql: 'SELECT * FROM customers', limit: 5000 }],
            ['run_sql_query', { sql: 'SELECT bad syntax here' }],
            ['describe_table', { table_name: 'nope' }],
            ['revenue_by_period', { group_by: 'year', start_date: 'not-a-date' }]
        ];

        for (const [name, args] of calls) {
            const result = await client.callTool({ name, arguments: args });
            if (result.isError) messages.push(`${name}: ${result.content[0].text}`);
        }
    } finally {
        await client.close();
    }

    // Precondition: if the calls stopped producing errors this test would pass vacuously.
    assert.ok(messages.length >= 20, `only ${messages.length} errors produced; the sweep is not sweeping`);

    for (const message of messages) {
        assert.ok(!/(?<![\w:])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(message), `path leaked: ${message}`);
        assert.ok(!/\sat\s+\S+\s+\(/.test(message), `stack frame leaked: ${message}`);
        assert.ok(!/\.js:\d+/.test(message), `source location leaked: ${message}`);
    }
});
