import test from 'node:test';
import assert from 'node:assert/strict';
import { UnknownTableError, describeTable, listTables } from '../src/introspect.js';

/**
 * A handle whose COUNT against `bad` fails the way a damaged table would. Views are never
 * counted, so a stub is the only honest way to reach the per-object catch.
 */
const stubDb = {
    prepare(sql) {
        if (sql.includes('sqlite_master')) {
            return { all: () => [{ name: 'ok', type: 'table' }, { name: 'bad', type: 'table' }] };
        }
        if (sql.startsWith('PRAGMA table_info')) {
            return { all: () => [{ name: 'a', type: 'TEXT' }] };
        }
        if (sql.includes('"bad"')) {
            throw new Error('database disk image is malformed');
        }
        return { get: () => ({ n: 7 }) };
    }
};

test('a table that cannot be counted degrades to its own row and the rest still list', () => {
    const tables = listTables(stubDb);

    assert.deepEqual(tables.map(t => t.name), ['ok', 'bad']);
    assert.equal(tables[0].row_count, 7);
    assert.equal(tables[1].row_count, null);
    assert.match(tables[1].note, /malformed/);
});

test('describeTable throws a distinguishable error for a name that does not exist', () => {
    assert.throws(() => describeTable(stubDb, 'nope'), UnknownTableError);
});

test('a table whose columns cannot be read still returns its other facts', () => {
    const brokenColumns = {
        prepare(sql) {
            if (sql.includes('sqlite_master')) {
                return { all: () => [{ name: 't', type: 'table', sql: 'CREATE TABLE t (a TEXT)' }] };
            }
            if (sql.startsWith('PRAGMA table_info')) throw new Error('no such table: main.gone');
            if (sql.startsWith('PRAGMA')) return { all: () => [] };
            if (sql.startsWith('SELECT *')) return { all: () => [{ a: 'x' }] };
            return { get: () => ({ n: 1 }) };
        }
    };

    const described = describeTable(brokenColumns, 't');
    assert.deepEqual(described.columns, []);
    assert.equal(described.row_count, 1);
    assert.deepEqual(described.sample_rows, [{ a: 'x' }]);
    assert.match(described.note, /columns unavailable: no such table: main\.gone/);
});

// Notes are agent-visible too, so the sanitizer has to cover this path and not only the
// tool-level errors — countRows and safely both interpolate a raw SQLite message.
test('a database path in a degraded note is scrubbed before the agent sees it', () => {
    const leaky = {
        prepare(sql) {
            if (sql.includes('sqlite_master')) {
                return { all: () => [{ name: 't', type: 'table', sql: 'CREATE TABLE t (a TEXT)' }] };
            }
            throw new Error('disk I/O error on /srv/private/shop.db');
        }
    };

    const [row] = listTables(leaky);

    // Precondition: the note must actually have been produced, or this passes vacuously.
    assert.match(row.note, /row count unavailable/);
    assert.ok(!row.note.includes('/srv/'), `path leaked into a note: ${row.note}`);
    assert.match(row.note, /<database>/);
});
