// MUST stay the first statement: stdout is the JSON-RPC channel and a single stray
// write to it corrupts the frame, leaving the client with an apparently dead server.
// Every console method that writes to stdout is rerouted, not just log.
for (const method of ['log', 'info', 'debug', 'dir', 'table']) {
    console[method] = console.error;
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveDbPath } from './config.js';
import { openDatabase, unavailableDatabase } from './db.js';
import { sanitize } from './errors.js';
import { registerTools } from './tools.js';

const INSTRUCTIONS = [
    'This server exposes one SQLite database of an online shop, and it is strictly read-only:',
    'nothing here can insert, update, delete or otherwise change the data, and any attempt is',
    'refused with an explanation and the equivalent read-only query.',
    '',
    'Start with list_tables to see what exists, then describe_table for each table you need.',
    'Verify that a column exists before you query it: describe_table lists the real columns',
    'along with three sample rows, and a column it does not list is not in the data.',
    '',
    'If the schema cannot answer the question, say plainly what is missing instead of guessing.',
    'Do not invent a value, substitute a different column for the one you wanted, or estimate a',
    'figure the data does not support — naming the gap is the correct answer, and an empty',
    'result is an answer too, not an error to work around.',
    '',
    'Results are capped, so prefer an aggregate (COUNT, SUM, GROUP BY) over paging through many',
    'rows. run_sql_query covers anything the specialised tools do not.'
].join('\n');

const dbPath = resolveDbPath(process.env, import.meta.url);

let db;
try {
    db = openDatabase(dbPath);
    console.error(`shop-db MCP server ready on stdio (database: ${dbPath})`);
} catch (err) {
    // Boot deliberately continues. An agent that can report "SHOP_DB_PATH points at nothing"
    // is more useful than a process that dies before the handshake and shows the operator
    // only "server failed to start". Full detail goes here, to stderr, where the operator can
    // see it; the agent gets the sanitized CONFIGURATION_ERROR from every tool instead.
    console.error(
        `shop-db MCP server: the database could not be opened at ${dbPath} (${err.message}). ` +
            'Set SHOP_DB_PATH to a readable SQLite file, or place shop.db in the project root. ' +
            'Every tool will report CONFIGURATION_ERROR until this is fixed.'
    );
    db = unavailableDatabase(sanitize(err.message));
}

const server = new McpServer({ name: 'shop-db', version: '0.1.0' }, { instructions: INSTRUCTIONS });
registerTools(server, { db });

await server.connect(new StdioServerTransport());
