import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { INVARIANTS } from '../scripts/seed-extended-data.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const shopDbPath = join(projectRoot, 'shop.db');
const seedScript = join(projectRoot, 'scripts', 'seed-extended-data.mjs');
const run = promisify(execFile);

const countsIn = path => {
    const db = new Database(path, { readonly: true });
    try {
        return Object.fromEntries(
            ['customers', 'orders', 'order_items'].map(t => [
                t,
                db.prepare(`SELECT COUNT(*) FROM ${t}`).pluck().get()
            ])
        );
    } finally {
        db.close();
    }
};

const copyOfShopDb = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'shop-db-seed-')), 'shop.db');
    copyFileSync(shopDbPath, path);
    return path;
};

// ------------------------------------------------- the committed database, right now

/**
 * The seeding script checks these when it generates, which proves it was correct on the day
 * it ran — not that the file in the repository still is. Anyone can hand-edit shop.db, and
 * an incoherent row (a German customer with a +33 phone, an order predating its customer)
 * would otherwise sail through the entire suite: no other test reads those columns together.
 */
test('the committed shop.db still satisfies every invariant the seeding script enforces', () => {
    const shop = new Database(shopDbPath, { readonly: true });
    try {
        const labels = INVARIANTS.map(([label]) => label);
        // The loop is only as good as the list, so the two checks that no other test could
        // possibly catch are named explicitly rather than trusted to be present.
        assert.ok(labels.length >= 13, `only ${labels.length} invariants; the list has shrunk`);
        assert.ok(
            labels.some(l => /phone country code/.test(l)),
            `no phone/country coherence check in: ${labels.join(' | ')}`
        );
        assert.ok(
            labels.some(l => /predates the customer/.test(l)),
            `no order/customer chronology check in: ${labels.join(' | ')}`
        );

        for (const [label, sql] of INVARIANTS) {
            assert.equal(shop.prepare(sql).pluck().get(), 0, `${label} — violated in the committed shop.db`);
        }
        assert.deepEqual(shop.pragma('foreign_key_check'), []);
    } finally {
        shop.close();
    }
});

// ------------------------------------------------------------------ the seeding script

/**
 * The script deletes the rows it owns and re-inserts them. Those deletes have to roll back
 * with the inserts: outside a transaction they autocommit, and a failure anywhere in the
 * 210-order insert loop would leave the committed database stripped back to the provided
 * rows, with no backup and every documented figure wrong.
 */
test('a failure part-way through seeding rolls back the deletes it had already made', async () => {
    const target = copyOfShopDb();
    const before = countsIn(target);
    assert.deepEqual(
        before,
        { customers: 235, orders: 960, order_items: 2429 },
        'the fixture must be the seeded database, or a rollback has nothing to save'
    );

    // A fault the script cannot route around, fired 50 orders into a 210-order insert, so
    // the deletes are long committed by the time it hits if they are not in the transaction.
    const db = new Database(target);
    db.exec(`CREATE TRIGGER injected_failure BEFORE INSERT ON orders WHEN NEW.id = 800
             BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    db.close();

    await assert.rejects(run(process.execPath, [seedScript, target]), /injected failure/);

    assert.deepEqual(countsIn(target), before, 'the deletes outlived the failure that undid the inserts');
    const after = new Database(target, { readonly: true });
    try {
        assert.equal(
            after.prepare("SELECT COUNT(*) FROM customers WHERE country = 'Germany'").pluck().get(),
            24,
            'the seeded geography did not survive the rollback'
        );
    } finally {
        after.close();
    }
});

/**
 * `id > 150` and `order_date < '2026-01-01'` mean something only for this dataset. The
 * script takes a path argument, so pointed at somebody else's shop.db those predicates
 * would delete real rows — and on a schema without AUTOINCREMENT it would then crash
 * rewinding sqlite_sequence, with the deletes already committed.
 */
test('the script refuses a database it cannot identify, before deleting anything', async () => {
    const foreign = join(mkdtempSync(join(tmpdir(), 'shop-db-seed-')), 'someone-elses.db');
    const db = new Database(foreign);
    db.exec(`
        CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT, last_name TEXT,
            email TEXT, phone TEXT, created_at TEXT);
        CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, category TEXT,
            price REAL, stock_quantity INTEGER, created_at TEXT);
        CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER,
            order_date TEXT, status TEXT, total_amount REAL);
        CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER,
            product_id INTEGER, quantity INTEGER, unit_price REAL);
        INSERT INTO customers (first_name, last_name, email, phone, created_at)
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200)
            SELECT 'a', 'b', 'c' || i, '+1' || i, '2024-01-01' FROM n;
        INSERT INTO orders (customer_id, order_date, status, total_amount)
            WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
            SELECT 1, '2024-06-01', 'completed', 10.0 FROM n;
    `);
    db.close();

    const before = countsIn(foreign);
    // Precondition: without rows the script's predicates would destroy, a refusal proves nothing.
    assert.equal(before.customers, 200, 'the fixture needs customers above id 150 to lose');
    assert.equal(before.orders, 40, 'the fixture needs pre-2026 orders to lose');

    const failure = await run(process.execPath, [seedScript, foreign]).then(
        () => null,
        err => err
    );

    assert.ok(failure, 'the script accepted a database that is not shop.db');
    assert.match(failure.stderr, /is not the shop\.db this script was written for/);
    assert.deepEqual(countsIn(foreign), before, 'rows were deleted from a database the script refused');
});
