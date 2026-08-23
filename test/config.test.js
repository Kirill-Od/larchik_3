import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDbPath } from '../src/config.js';

// A file: URL percent-encodes anything unusual in a path segment. Taking `.pathname`
// hands that encoding straight to the filesystem, which then looks for a directory
// literally named "my%20proj".
test('the default path is decoded from a module URL containing a space', () => {
    const dbPath = resolveDbPath({}, 'file:///tmp/my%20proj/src/config.js');
    assert.equal(dbPath, '/tmp/my proj/shop.db');
});

test('the default path is decoded from a module URL containing non-ASCII characters', () => {
    const dbPath = resolveDbPath(
        {},
        'file:///tmp/%D0%BF%D1%80%D0%BE%D0%B5%D0%BA%D1%82/src/config.js'
    );
    assert.equal(dbPath, '/tmp/проект/shop.db');
});

test('an absolute SHOP_DB_PATH is taken as given', () => {
    const dbPath = resolveDbPath({ SHOP_DB_PATH: '/var/data/other.db' }, 'file:///tmp/p/src/config.js');
    assert.equal(dbPath, '/var/data/other.db');
});

// Returning a relative value un-resolved makes better-sqlite3 resolve it against the
// client's spawn directory, which is exactly the cwd-dependence the design forbids.
test('a relative SHOP_DB_PATH resolves against the project root, not the caller cwd', () => {
    const dbPath = resolveDbPath({ SHOP_DB_PATH: 'data/other.db' }, 'file:///tmp/my%20proj/src/config.js');
    assert.equal(dbPath, '/tmp/my proj/data/other.db');
});

test('an empty SHOP_DB_PATH falls back to the default', () => {
    const dbPath = resolveDbPath({ SHOP_DB_PATH: '' }, 'file:///tmp/p/src/config.js');
    assert.equal(dbPath, '/tmp/p/shop.db');
});
