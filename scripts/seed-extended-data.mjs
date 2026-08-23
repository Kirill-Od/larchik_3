/**
 * Seeds the generated half of shop.db, in place and deterministically.
 *
 * WHAT IS GENERATED, AND WHY
 * --------------------------
 * The dataset that shipped with the assignment cannot answer three of its own eight
 * questions: it has no geography column at all (tasks 2 and 3) and every one of its 750
 * orders falls in 2026 (task 7). Rather than leave the server answering "the data does not
 * contain it" three times, the owner chose to extend the data. This script is that
 * extension, and it is the only thing that has ever written to shop.db.
 *
 * Everything it adds is separable from the provided data by a single predicate:
 *
 *   - `customers.country`            — a new column. The 150 provided customers all have
 *                                      Russian names and +79 phone numbers, so they are
 *                                      backfilled to 'Russia'; that is a reading of the
 *                                      provided data, not an invention.
 *   - `customers.id > 150`           — 85 GENERATED customers from seven other countries.
 *   - `orders.order_date < '2026'`   — 210 GENERATED orders, all dated 2025, with their
 *                                      order_items.
 *
 * No provided row is modified, and no order dated 2026 is touched, so every figure the
 * project ever measured about 2026 is still exactly what the provided data says.
 *
 * COHERENCE RULES (the point of generating rather than randomising)
 * ----------------------------------------------------------------
 * A Russian name with a +79 phone and country 'Brazil' is spotted instantly and is worse
 * than the honest gap it replaces. So for every generated customer the given name, the
 * family name, the phone country code and the email domain all agree with the country.
 *
 * The 2025 orders are confined to 2025-09-01 … 2025-12-31 on purpose. In the provided
 * data the catalogue begins on 2025-08-24 (only 5 of 50 products exist before September)
 * and the earliest customer registered on 2025-08-22, so an order dated earlier would buy
 * products that did not exist yet from customers who had not signed up. Each generated
 * order therefore draws only from products already created on its date, and belongs to a
 * customer already registered on its date.
 *
 * INVARIANTS
 * ----------
 * Verified by `verify()` below on every run, and printed. total_amount is computed from
 * the items rather than asserted about them, and unit_price is read from the product row,
 * so the two cross-table invariants hold by construction rather than by luck.
 *
 * DETERMINISM AND RE-RUNNABILITY
 * ------------------------------
 * A fixed-seed PRNG, explicit primary keys, and a delete-then-insert of exactly the three
 * groups above. Running it twice produces a byte-identical result to running it once, so
 * the figures quoted in README.md and homework.md stay true if it is ever re-run.
 *
 *   node scripts/seed-extended-data.mjs [path-to-db]     # defaults to ../shop.db
 */

import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const SEED = 20260823;
const PROVIDED_CUSTOMER_COUNT = 150;
const FIRST_GENERATED_ORDER_DATE = '2025-09-01';
const ORDERS_PER_MONTH = { '2025-09': 36, '2025-10': 48, '2025-11': 58, '2025-12': 68 };

/** mulberry32 — small, seedable, and identical on every platform and Node version. */
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rng = makeRng(SEED);
const pick = list => list[Math.floor(rng() * list.length)];
const intBetween = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));

/** Weighted pick over [[value, weight], …]; the weights are the shape of the data. */
function weighted(pairs) {
    const total = pairs.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;
    for (const [value, weight] of pairs) {
        roll -= weight;
        if (roll < 0) return value;
    }
    return pairs[pairs.length - 1][0];
}

// ------------------------------------------------------------------- the countries

/**
 * Germany is the largest generated group because homework task 2 asks how many customers
 * are from Germany and a two-row answer would defeat the exercise. Russia keeps a decisive
 * lead for task 3 — 150 against 24 — because a near-tie makes that answer wobble.
 */
const COUNTRIES = [
    {
        country: 'Germany',
        count: 24,
        phone: () => `+49151${digits(7)}`,
        domains: ['gmx.de', 'web.de', 't-online.de', 'freenet.de'],
        first: ['Lukas', 'Jonas', 'Leon', 'Finn', 'Paul', 'Maximilian', 'Felix', 'Elias', 'Noah', 'Ben',
                'Anna', 'Emma', 'Mia', 'Hannah', 'Lena', 'Laura', 'Sophie', 'Marie', 'Julia', 'Lea',
                'Sarah', 'Katharina', 'Niklas', 'Tobias'],
        last: ['Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker',
               'Hoffmann', 'Schäfer', 'Koch', 'Bauer', 'Richter', 'Klein', 'Wolf', 'Neumann',
               'Zimmermann', 'Braun', 'Krüger', 'Hofmann', 'Lange', 'Werner', 'Krause', 'Schulz']
    },
    {
        country: 'France',
        count: 16,
        phone: () => `+336${digits(8)}`,
        domains: ['orange.fr', 'free.fr', 'laposte.net', 'sfr.fr'],
        first: ['Lucas', 'Hugo', 'Louis', 'Gabriel', 'Jules', 'Théo', 'Nathan', 'Enzo',
                'Camille', 'Manon', 'Léa', 'Chloé', 'Emma', 'Sarah', 'Julie', 'Clara'],
        last: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Petit', 'Durand', 'Leroy',
               'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Girard', 'David', 'Roux']
    },
    {
        country: 'United Kingdom',
        count: 13,
        phone: () => `+447${digits(9)}`,
        domains: ['btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net'],
        first: ['Oliver', 'Harry', 'Jack', 'Charlie', 'George', 'Amelia', 'Olivia', 'Isla',
                'Emily', 'Sophie', 'Thomas', 'Jacob', 'Grace'],
        last: ['Smith', 'Jones', 'Taylor', 'Brown', 'Williams', 'Wilson', 'Johnson', 'Davies',
               'Patel', 'Robinson', 'Wright', 'Thompson', 'Evans']
    },
    {
        country: 'Italy',
        count: 11,
        phone: () => `+393${digits(9)}`,
        domains: ['libero.it', 'tiscali.it', 'virgilio.it', 'alice.it'],
        first: ['Francesco', 'Alessandro', 'Lorenzo', 'Matteo', 'Giulia', 'Chiara', 'Sofia',
                'Martina', 'Andrea', 'Luca', 'Elena'],
        last: ['Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Colombo', 'Ricci',
               'Marino', 'Greco', 'Conti']
    },
    {
        country: 'Spain',
        count: 9,
        phone: () => `+346${digits(8)}`,
        domains: ['telefonica.net', 'terra.es', 'hotmail.es', 'ya.com'],
        first: ['Javier', 'Carlos', 'Miguel', 'Lucía', 'Marta', 'Elena', 'Pablo', 'Sergio', 'Carmen'],
        last: ['García', 'Martínez', 'Rodríguez', 'Fernández', 'López', 'Sánchez', 'Pérez',
               'Gómez', 'Ruiz']
    },
    {
        country: 'Poland',
        count: 7,
        phone: () => `+485${digits(8)}`,
        domains: ['wp.pl', 'onet.pl', 'interia.pl', 'o2.pl'],
        first: ['Jakub', 'Kacper', 'Piotr', 'Anna', 'Zofia', 'Katarzyna', 'Michał'],
        last: ['Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamiński', 'Lewandowski']
    },
    {
        country: 'Netherlands',
        count: 5,
        phone: () => `+316${digits(8)}`,
        domains: ['ziggo.nl', 'kpnmail.nl', 'home.nl', 'planet.nl'],
        first: ['Daan', 'Sem', 'Lotte', 'Sanne', 'Bram'],
        last: ['de Jong', 'Jansen', 'van Dijk', 'Bakker', 'Visser']
    }
];

const digits = n => Array.from({ length: n }, () => intBetween(0, 9)).join('');

/**
 * The email has to read as the person's own, so it is derived from the name rather than
 * drawn from a pool: umlauts and accents become the ASCII an address can actually carry.
 */
const TRANSLITERATION = {
    ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss',
    à: 'a', á: 'a', â: 'a', ã: 'a', å: 'a',
    è: 'e', é: 'e', ê: 'e', ë: 'e',
    ì: 'i', í: 'i', î: 'i', ï: 'i',
    ò: 'o', ó: 'o', ô: 'o', õ: 'o',
    ù: 'u', ú: 'u', û: 'u',
    ç: 'c', ñ: 'n',
    ł: 'l', ś: 's', ż: 'z', ź: 'z', ą: 'a', ę: 'e', ć: 'c'
};

const asciiFold = text =>
    [...text.toLowerCase()]
        .map(ch => TRANSLITERATION[ch] ?? ch)
        .join('')
        .replace(/[^a-z]/g, '');

// ------------------------------------------------------------------------ the dates

const pad = n => String(n).padStart(2, '0');
const DAYS_IN_MONTH = { '09': 30, '10': 31, '11': 30, '12': 31 };

/** A timestamp in the provided data's format: "YYYY-MM-DD HH:MM:SS". */
function timestamp(month, day) {
    return `${month}-${pad(day)} ${pad(intBetween(8, 21))}:${pad(intBetween(0, 59))}:${pad(intBetween(0, 59))}`;
}

// --------------------------------------------------------------------------- seeding

function clearPreviousSeed(db) {
    const removed = {
        order_items: db
            .prepare(
                `DELETE FROM order_items
                 WHERE order_id IN (SELECT id FROM orders WHERE order_date < '2026-01-01')`
            )
            .run().changes,
        orders: db.prepare("DELETE FROM orders WHERE order_date < '2026-01-01'").run().changes,
        customers: db.prepare('DELETE FROM customers WHERE id > ?').run(PROVIDED_CUSTOMER_COUNT).changes
    };
    // AUTOINCREMENT remembers the high-water mark, so without this a second run would
    // continue numbering above the deleted rows and stop being byte-identical.
    for (const table of ['customers', 'orders', 'order_items']) {
        const max = db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get().m;
        db.prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?').run(max, table);
    }
    return removed;
}

function addCountryColumn(db) {
    const hasCountry = db
        .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('customers') WHERE name = 'country'")
        .get().n;
    if (!hasCountry) {
        db.exec('ALTER TABLE customers ADD COLUMN country TEXT');
    }
    // Unconditional: on a re-run the provided rows are already 'Russia', and this is also
    // what backfills them the first time.
    db.prepare("UPDATE customers SET country = 'Russia' WHERE id <= ?").run(PROVIDED_CUSTOMER_COUNT);
}

function insertCustomers(db) {
    const insert = db.prepare(
        `INSERT INTO customers (id, first_name, last_name, email, phone, created_at, country)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const taken = new Set(db.prepare('SELECT email FROM customers').all().map(r => r.email));

    let id = PROVIDED_CUSTOMER_COUNT;
    for (const spec of COUNTRIES) {
        for (let i = 0; i < spec.count; i += 1) {
            const firstName = pick(spec.first);
            const lastName = pick(spec.last);

            let email;
            do {
                email = `${asciiFold(firstName)}.${asciiFold(lastName)}${intBetween(10, 999)}@${pick(spec.domains)}`;
            } while (taken.has(email));
            taken.add(email);

            // Registered before the orders they place: September through mid-December 2025.
            const month = `2025-${weighted([['09', 3], ['10', 3], ['11', 2], ['12', 1]])}`;
            const created = timestamp(month, intBetween(1, month.endsWith('12') ? 10 : DAYS_IN_MONTH[month.slice(-2)]));

            id += 1;
            insert.run(id, firstName, lastName, email, spec.phone(), created, spec.country);
        }
    }
    return id - PROVIDED_CUSTOMER_COUNT;
}

/**
 * Past orders, so the status mix leans to settled outcomes rather than copying the
 * in-flight mix of the 2026 data — but all five CHECK values still occur, and cancelled
 * orders are a real share, because include_cancelled has to keep changing the answer.
 */
const STATUS_MIX = [
    ['completed', 58],
    ['shipped', 18],
    ['cancelled', 14],
    ['processing', 6],
    ['new', 4]
];

function insertOrders(db) {
    const products = db.prepare('SELECT id, price, created_at FROM products ORDER BY id').all();
    const customers = db
        .prepare('SELECT id, created_at FROM customers ORDER BY id')
        .all()
        .map(c => ({ ...c, generated: c.id > PROVIDED_CUSTOMER_COUNT }));

    const insertOrder = db.prepare(
        'INSERT INTO orders (id, customer_id, order_date, status, total_amount) VALUES (?, ?, ?, ?, ?)'
    );
    const insertItem = db.prepare(
        'INSERT INTO order_items (id, order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?, ?)'
    );

    let orderId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM orders').get().m;
    let itemId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM order_items').get().m;
    let items = 0;

    for (const [month, count] of Object.entries(ORDERS_PER_MONTH)) {
        const dates = Array.from({ length: count }, () =>
            timestamp(month, intBetween(1, DAYS_IN_MONTH[month.slice(-2)]))
        ).sort();

        for (const orderDate of dates) {
            // Both halves of the customer base, weighted so the 85 generated customers are
            // well covered without the 150 provided ones falling out of the 2025 data.
            const generated = rng() < 0.55;
            const eligible = customers.filter(
                c => c.generated === generated && c.created_at <= orderDate
            );
            const customer = pick(eligible.length > 0 ? eligible : customers.filter(c => c.created_at <= orderDate));

            const catalogue = products.filter(p => p.created_at <= orderDate);
            const basket = new Map();
            for (let i = 0, want = intBetween(1, Math.min(4, catalogue.length)); i < want; i += 1) {
                const product = pick(catalogue);
                if (!basket.has(product.id)) basket.set(product.id, { product, quantity: intBetween(1, 3) });
            }

            const total = [...basket.values()].reduce(
                (sum, { product, quantity }) => sum + quantity * product.price,
                0
            );

            orderId += 1;
            insertOrder.run(orderId, customer.id, orderDate, weighted(STATUS_MIX), Math.round(total * 100) / 100);
            for (const { product, quantity } of basket.values()) {
                itemId += 1;
                insertItem.run(itemId, orderId, product.id, quantity, product.price);
                items += 1;
            }
        }
    }
    return { orders: orderId - 750, items };
}

// ------------------------------------------------------------------ the target guard

/**
 * This script deletes before it inserts, and the predicates it deletes on — `id > 150` on
 * customers, `order_date < '2026-01-01'` on orders — are meaningful for exactly one
 * dataset. Pointed at somebody else's shop.db (README's own F3 warns the grader may attach
 * one) they would silently destroy real rows, and on a schema without AUTOINCREMENT the run
 * would then crash updating sqlite_sequence with the deletes already committed.
 *
 * So the target is identified before anything is written: the four tables, the columns this
 * script reads and writes, the AUTOINCREMENT sequences it rewinds, and a digest of every
 * provided row. The digests are taken over the provided columns only, so they match both
 * the pristine database and one this script has already seeded.
 */
const PROVIDED_DIGESTS = {
    customers: 'b02fbfdfc5fb0a66',
    products: '2a64d1d73aaa62ed',
    orders: 'bd53564560b9be6d',
    order_items: '3f82b1561c0b48b7'
};

const PROVIDED_ROWS = {
    customers: 'SELECT id, first_name, last_name, email, phone, created_at FROM customers WHERE id <= 150 ORDER BY id',
    products: 'SELECT id, name, category, price, stock_quantity, created_at FROM products ORDER BY id',
    orders: 'SELECT id, customer_id, order_date, status, total_amount FROM orders WHERE id <= 750 ORDER BY id',
    order_items: 'SELECT id, order_id, product_id, quantity, unit_price FROM order_items WHERE id <= 1900 ORDER BY id'
};

const REQUIRED_COLUMNS = {
    customers: ['id', 'first_name', 'last_name', 'email', 'phone', 'created_at'],
    products: ['id', 'name', 'category', 'price', 'stock_quantity', 'created_at'],
    orders: ['id', 'customer_id', 'order_date', 'status', 'total_amount'],
    order_items: ['id', 'order_id', 'product_id', 'quantity', 'unit_price']
};

export function digestProvidedRows(db, table) {
    const rows = db.prepare(PROVIDED_ROWS[table]).raw().all();
    return createHash('sha256')
        .update(rows.map(row => row.join('\u0001')).join('\n'))
        .digest('hex')
        .slice(0, 16);
}

class WrongDatabase extends Error {}

/** Throws before a single row is deleted if `dbPath` is not the database this script owns. */
export function assertExpectedDatabase(db, dbPath) {
    const refuse = why => {
        throw new WrongDatabase(
            `${dbPath} is not the shop.db this script was written for: ${why}. It deletes ` +
                'customers above id 150 and every order before 2026 before re-inserting them, ' +
                'so it refuses to touch a database it cannot identify. Seed a copy of the ' +
                "project's own shop.db instead."
        );
    };

    for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
        let present;
        try {
            present = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        } catch {
            present = [];
        }
        if (present.length === 0) refuse(`it has no ${table} table`);

        const missing = required.filter(column => !present.includes(column));
        if (missing.length > 0) refuse(`${table} is missing ${missing.join(', ')}`);
    }

    // clearPreviousSeed rewinds these; on a table declared without AUTOINCREMENT there is no
    // row to rewind and the ids would stop being reproducible.
    const sequenced = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'")
        .all();
    if (sequenced.length === 0) refuse('it has no AUTOINCREMENT tables');
    const seqNames = db.prepare('SELECT name FROM sqlite_sequence').pluck().all();
    for (const table of ['customers', 'orders', 'order_items']) {
        if (!seqNames.includes(table)) refuse(`${table} is not AUTOINCREMENT`);
    }

    for (const [table, expected] of Object.entries(PROVIDED_DIGESTS)) {
        const actual = digestProvidedRows(db, table);
        if (actual !== expected) {
            refuse(`its provided ${table} rows digest to ${actual}, not ${expected}`);
        }
    }
}

// ---------------------------------------------------------------------- verification

/**
 * Exported so the test suite can re-run them against the committed shop.db. Checking them
 * only at generation time would prove the script was correct on the day it ran, not that
 * the database in the repository still satisfies them — see test/data-invariants.test.js.
 */
export const INVARIANTS = [
    [
        'orders.status is always one of the five CHECK values',
        `SELECT COUNT(*) FROM orders
         WHERE status NOT IN ('new','processing','shipped','completed','cancelled')`
    ],
    ['order_items.quantity is always > 0', 'SELECT COUNT(*) FROM order_items WHERE quantity <= 0'],
    [
        'orders.total_amount equals SUM(quantity * unit_price)',
        `SELECT COUNT(*) FROM (
             SELECT o.id FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             GROUP BY o.id
             HAVING ROUND(o.total_amount, 2) <> ROUND(SUM(oi.quantity * oi.unit_price), 2))`
    ],
    [
        "order_items.unit_price equals the product's current price",
        `SELECT COUNT(*) FROM order_items oi
         JOIN products p ON p.id = oi.product_id
         WHERE oi.unit_price <> p.price`
    ],
    [
        'customers.email is unique',
        'SELECT COUNT(*) FROM (SELECT email FROM customers GROUP BY email HAVING COUNT(*) > 1)'
    ],
    [
        'every order has at least one item',
        `SELECT COUNT(*) FROM orders o
         WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id)`
    ],
    [
        'every customer has a country',
        `SELECT COUNT(*) FROM customers WHERE country IS NULL OR TRIM(country) = ''`
    ],
    [
        'order_items.order_id resolves',
        'SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL'
    ],
    [
        'order_items.product_id resolves',
        'SELECT COUNT(*) FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id WHERE p.id IS NULL'
    ],
    [
        'orders.customer_id resolves',
        'SELECT COUNT(*) FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE c.id IS NULL'
    ],
    [
        'the phone country code agrees with the country on every generated row',
        `SELECT COUNT(*) FROM customers
         WHERE NOT (
             (country = 'Russia'         AND phone LIKE '+79%')  OR
             (country = 'Germany'        AND phone LIKE '+49%')  OR
             (country = 'France'         AND phone LIKE '+33%')  OR
             (country = 'United Kingdom' AND phone LIKE '+44%')  OR
             (country = 'Italy'          AND phone LIKE '+39%')  OR
             (country = 'Spain'          AND phone LIKE '+34%')  OR
             (country = 'Poland'         AND phone LIKE '+48%')  OR
             (country = 'Netherlands'    AND phone LIKE '+31%'))`
    ],
    [
        'no generated order predates the customer who placed it',
        `SELECT COUNT(*) FROM orders o
         JOIN customers c ON c.id = o.customer_id
         WHERE o.order_date < c.created_at`
    ],
    [
        'no generated order buys a product that did not exist yet',
        `SELECT COUNT(*) FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE o.order_date < p.created_at`
    ]
];

export function verify(db, log = console.log) {
    let failures = 0;
    for (const [label, sql] of INVARIANTS) {
        const violations = db.prepare(sql).pluck().get();
        if (violations !== 0) failures += 1;
        log(`  ${violations === 0 ? 'ok  ' : 'FAIL'}  ${label} — ${violations} violation(s)`);
    }
    const fk = db.pragma('foreign_key_check');
    log(`  ${fk.length === 0 ? 'ok  ' : 'FAIL'}  PRAGMA foreign_key_check — ${fk.length} row(s)`);
    return failures + fk.length;
}

// ---------------------------------------------------------------------------- main

function main() {
    const dbPath = process.argv[2] ?? fileURLToPath(new URL('../shop.db', import.meta.url));
    const db = new Database(dbPath);
    db.pragma('foreign_keys = ON');

    assertExpectedDatabase(db, dbPath);

    // clearPreviousSeed belongs INSIDE the transaction. Outside it, its three DELETEs autocommit
    // and a failure anywhere in the inserts leaves the file stripped back to the provided rows
    // with no seeded data and no backup — the deletes are the destructive half, so they must
    // roll back with everything else.
    db.transaction(() => {
        const removed = clearPreviousSeed(db);
        if (removed.customers + removed.orders > 0) {
            console.log(
                `Cleared a previous run: ${removed.customers} customers, ${removed.orders} orders, ` +
                    `${removed.order_items} order items.`
            );
        }

        addCountryColumn(db);
        const customers = insertCustomers(db);
        const { orders, items } = insertOrders(db);
        console.log(`Added ${customers} customers, ${orders} orders, ${items} order items.`);
    })();

    console.log('\nRow counts:');
    for (const table of ['customers', 'products', 'orders', 'order_items']) {
        console.log(`  ${table.padEnd(12)} ${db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get()}`);
    }

    console.log('\nCustomers by country:');
    for (const row of db
        .prepare('SELECT country, COUNT(*) AS n FROM customers GROUP BY country ORDER BY n DESC, country')
        .all()) {
        console.log(`  ${row.country.padEnd(16)} ${row.n}`);
    }

    console.log('\nInvariants:');
    const failures = verify(db);
    db.close();

    if (failures > 0) {
        console.error(`\n${failures} invariant(s) violated — the database is not in a valid state.`);
        process.exit(1);
    }
    console.log('\nAll invariants hold.');
}

// Importable without side effects: test/data-invariants.test.js reads INVARIANTS from here.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
