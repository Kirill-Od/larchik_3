import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { startServer, makeFixtureDb, stageServerAt, driveRaw, toolJson } from './helpers.js';

test('the server completes the MCP handshake and advertises list_tables', async () => {
    const client = await startServer();
    try {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name);
        assert.ok(names.includes('list_tables'), `expected list_tables in ${names.join(', ')}`);

        const listTables = tools.find(t => t.name === 'list_tables');
        assert.equal(listTables.annotations.readOnlyHint, true);
        assert.ok(listTables.description.length > 0);
    } finally {
        await client.close();
    }
});

test('list_tables reports the four shop tables with their row counts', async () => {
    const client = await startServer();
    try {
        const result = await client.callTool({ name: 'list_tables', arguments: {} });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);

        const counts = Object.fromEntries(toolJson(result).tables.map(t => [t.name, t.row_count]));
        assert.deepEqual(counts, {
            customers: 235,
            products: 50,
            orders: 960,
            order_items: 2429
        });
    } finally {
        await client.close();
    }
});

test('the database is found when the client spawns the server from another directory', async () => {
    const client = await startServer({ cwd: tmpdir() });
    try {
        const result = await client.callTool({ name: 'list_tables', arguments: {} });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        assert.equal(toolJson(result).tables.length, 4);
    } finally {
        await client.close();
    }
});

test('SHOP_DB_PATH takes precedence over the project-relative default', async () => {
    const client = await startServer({ dbPath: makeFixtureDb() });
    try {
        const { tables } = toolJson(await client.callTool({ name: 'list_tables', arguments: {} }));
        assert.deepEqual(tables, [
            { name: 'widgets', type: 'table', row_count: 3, columns: 'id INTEGER, label TEXT' }
        ]);
    } finally {
        await client.close();
    }
});

test('the server boots from a project directory whose name contains a space', async () => {
    const client = await startServer({ entry: stageServerAt('my proj') });
    try {
        const result = await client.callTool({ name: 'list_tables', arguments: {} });
        assert.notEqual(result.isError, true, result.content?.[0]?.text);
        assert.equal(toolJson(result).tables.length, 4);
    } finally {
        await client.close();
    }
});

// stdout is the JSON-RPC channel. This guards the whole category: any stray write, from
// our code or a dependency, shows up here as a line that is not a JSON-RPC frame.
test('the child writes nothing to stdout but JSON-RPC frames', async () => {
    const { stdout } = await driveRaw([
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_tables', arguments: {} } }
    ]);

    const lines = stdout.split('\n').filter(line => line !== '');
    assert.equal(lines.length, 3);
    for (const line of lines) {
        assert.equal(JSON.parse(line).jsonrpc, '2.0', `not a JSON-RPC frame: ${line}`);
    }
});
