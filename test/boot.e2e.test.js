import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, driveRaw } from './helpers.js';

/** A path whose directory exists but whose file does not — the realistic misconfiguration. */
const missingDb = () => join(mkdtempSync(join(tmpdir(), 'shop-db-mcp-')), 'absent.db');

// Dying before the handshake shows the grader only "server failed to start". An agent that
// can report "SHOP_DB_PATH points at nothing" is strictly more useful.
test('the server still completes the handshake when the database cannot be opened', async () => {
    const client = await startServer({ dbPath: missingDb() });
    try {
        const { tools } = await client.listTools();
        assert.ok(tools.length > 0, 'listTools must still work');
        assert.ok(tools.some(t => t.name === 'list_tables'));
    } finally {
        await client.close();
    }
});

test('every core tool reports the configuration problem and names SHOP_DB_PATH', async () => {
    const client = await startServer({ dbPath: missingDb() });
    try {
        const calls = [
            ['list_tables', {}],
            ['describe_table', { table_name: 'customers' }],
            ['run_sql_query', { sql: 'SELECT 1' }]
        ];

        for (const [name, args] of calls) {
            const result = await client.callTool({ name, arguments: args });
            assert.equal(result.isError, true, `${name} did not report a problem`);

            const message = result.content[0].text;
            assert.match(message, /CONFIGURATION_ERROR/, `${name}: ${message}`);
            assert.match(message, /SHOP_DB_PATH/, `${name}: ${message}`);
            assert.ok(!/(?<![\w:])\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.test(message), `path leaked: ${message}`);
        }
    } finally {
        await client.close();
    }
});

// probeCapabilities returns false rather than throwing on an unusable handle, so the
// analytics tools simply are not offered instead of being advertised and then failing.
test('the analytics tools are not advertised when the database is unavailable', async () => {
    const client = await startServer({ dbPath: missingDb() });
    try {
        const names = (await client.listTools()).tools.map(t => t.name);
        assert.deepEqual(names.sort(), ['describe_table', 'list_tables', 'run_sql_query']);
    } finally {
        await client.close();
    }
});

test('the reason is logged once to stderr and stdout stays valid JSON-RPC', async () => {
    const { stdout, stderr } = await driveRaw(
        [
            { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tables', arguments: {} } }
        ],
        { SHOP_DB_PATH: missingDb() }
    );

    const lines = stdout.split('\n').filter(line => line !== '');
    assert.equal(lines.length, 3);
    for (const line of lines) {
        assert.equal(JSON.parse(line).jsonrpc, '2.0', `not a JSON-RPC frame: ${line}`);
    }

    assert.match(stderr, /SHOP_DB_PATH/, `the operator was not told why: ${stderr}`);
    const complaints = stderr.split('\n').filter(line => /could not be opened/i.test(line));
    assert.equal(complaints.length, 1, `logged ${complaints.length} times: ${stderr}`);
});
