import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
    StdioClientTransport,
    getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolJson } from './helpers.js';

// Trailing separator stripped: the placeholder in the JSON is always followed by one.
const projectRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const configPath = new URL('../mcp.config.example.json', import.meta.url);

const PLACEHOLDER = '<PROJECT_ROOT>';

/**
 * The README tells the reader to copy this file into their client and replace one token
 * with the path to their clone. That is exactly what happens here, so the test spawns the
 * documented configuration itself rather than a paraphrase of it: if src/index.js is
 * renamed, if the env variable is renamed, or if the JSON shape drifts from what a client
 * expects, this goes red and the documentation cannot rot silently.
 */
function loadExampleConfig() {
    const raw = readFileSync(configPath, 'utf8');

    // The substitution below is the whole mechanism, and a no-op substitution would leave
    // a test that passes without proving anything. Assert the token was really there.
    assert.ok(
        raw.includes(PLACEHOLDER),
        `mcp.config.example.json no longer contains ${PLACEHOLDER}; the README's ` +
            'replace-this-token instruction and this test have drifted apart'
    );

    const parsed = JSON.parse(raw.replaceAll(PLACEHOLDER, projectRoot));
    const names = Object.keys(parsed.mcpServers ?? {});
    assert.deepEqual(names, ['shop-db'], 'expected exactly one server named shop-db');

    return parsed.mcpServers['shop-db'];
}

test('mcp.config.example.json spawns a server that completes a listTools handshake', async t => {
    const entry = loadExampleConfig();

    assert.equal(typeof entry.command, 'string');
    assert.ok(Array.isArray(entry.args) && entry.args.length > 0);

    const transport = new StdioClientTransport({
        command: entry.command,
        args: entry.args,
        // The client's env replaces the child's wholesale, so PATH has to be merged back
        // in or `node` cannot be found. The config's own values win over the defaults.
        env: { ...getDefaultEnvironment(), ...(entry.env ?? {}) },
        // Deliberately NOT the project root. A client spawns the server from wherever it
        // happens to be running, so a config that only works from the repo directory is a
        // broken config.
        cwd: tmpdir()
    });

    const client = new Client({ name: 'config-example-test', version: '0.0.0' });
    await client.connect(transport);
    t.after(() => client.close());

    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name).sort();

    assert.deepEqual(names, [
        'describe_table',
        'list_tables',
        'revenue_by_period',
        'run_sql_query',
        'top_customers_by_spend',
        'top_products_by_sales'
    ]);

    // listTools alone would still succeed with a wrong SHOP_DB_PATH, because the server
    // deliberately boots without a readable database and reports the problem per call.
    // Only a tool call proves the path in the config reaches the real shop.db.
    const result = await client.callTool({ name: 'list_tables', arguments: {} });
    assert.notEqual(result.isError, true, `list_tables failed: ${result.content?.[0]?.text}`);

    const counts = Object.fromEntries(
        toolJson(result).tables.map(table => [table.name, table.row_count])
    );
    assert.deepEqual(counts, {
        customers: 235,
        products: 50,
        orders: 960,
        order_items: 2429
    });
});
