import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the SQLite database path. Pure: reads no files, and never consults
 * process.cwd() — an MCP client spawns the server from an arbitrary directory, so a
 * path resolved against the cwd would point somewhere different for every client.
 * A relative SHOP_DB_PATH is therefore resolved against the project root too, not
 * against wherever the client happened to launch us.
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} moduleUrl  import.meta.url of a module inside src/
 */
export function resolveDbPath(env, moduleUrl) {
    // fileURLToPath, not URL.pathname: pathname stays percent-encoded, so a project
    // directory named "my proj" would be looked up as "my%20proj".
    const projectRoot = fileURLToPath(new URL('..', moduleUrl));

    const configured = env.SHOP_DB_PATH;
    if (configured !== undefined && configured !== '') {
        return isAbsolute(configured) ? configured : join(projectRoot, configured);
    }
    return join(projectRoot, 'shop.db');
}
