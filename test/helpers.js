import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const serverEntry = join(projectRoot, 'src', 'index.js');

/**
 * Spawns src/index.js as a child process and completes the MCP handshake over stdio —
 * the same path a real client takes.
 */
export async function startServer({ dbPath, cwd, entry = serverEntry } = {}) {
    // StdioClientTransport replaces the child environment wholesale when `env` is given,
    // so the default inherited vars (PATH above all) have to be merged back in.
    const env = { ...getDefaultEnvironment() };
    if (dbPath !== undefined) {
        env.SHOP_DB_PATH = dbPath;
    }

    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [entry],
        env,
        cwd
    });

    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(transport);
    return client;
}

/**
 * Copies src/ and shop.db into a temp directory named `dirName` and returns the staged
 * entry point. node_modules is symlinked rather than copied. Used to run the server from
 * a path the repo itself can never have — one containing a space.
 */
export function stageServerAt(dirName) {
    const root = join(mkdtempSync(join(tmpdir(), 'shop-db-mcp-')), dirName);
    mkdirSync(root, { recursive: true });
    cpSync(join(projectRoot, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(projectRoot, 'shop.db'), join(root, 'shop.db'));
    symlinkSync(join(projectRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
    return join(root, 'src', 'index.js');
}

const WIDGETS = `CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT);
                 INSERT INTO widgets (label) VALUES ('a'), ('b'), ('c');`;

/** A throwaway database in a fresh temp directory, deliberately unlike shop.db. */
export function makeFixtureDb(schemaSql = WIDGETS) {
    const path = join(mkdtempSync(join(tmpdir(), 'shop-db-mcp-')), 'fixture.db');
    const db = new Database(path);
    db.exec(schemaSql);
    db.close();
    return path;
}

/** Pipes raw JSON-RPC lines into the server and returns its raw stdout and stderr. */
export async function driveRaw(messages, extraEnv = {}) {
    const child = promisify(execFile)(process.execPath, [serverEntry], {
        cwd: tmpdir(),
        env: { ...getDefaultEnvironment(), ...extraEnv }
    });
    child.child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    return child;
}

/** Parses the JSON payload a tool returns in its first text content block. */
export function toolJson(result) {
    return JSON.parse(result.content[0].text);
}
