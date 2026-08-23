import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import {
    probeCapabilities,
    registerAnalyticsTools,
    revenueByPeriod,
    topCustomersBySpend,
    topProductsBySales
} from '../src/analytics.js';
import { makeFixtureDb } from './helpers.js';

const shop = openDatabase(fileURLToPath(new URL('../shop.db', import.meta.url)));
const fixture = schemaSql => openDatabase(makeFixtureDb(schemaSql));

// ------------------------------------------------------------ error sanitizing

/**
 * Registers the tools against a stub handle and hands back the raw handlers, so a failure
 * can be driven through exactly the path an MCP call takes without a subprocess.
 */
function captureHandlers(db) {
    const handlers = new Map();
    registerAnalyticsTools({ registerTool: (name, _config, handler) => handlers.set(name, handler) }, { db });
    return handlers;
}

const CALLS = [
    ['top_customers_by_spend', {}],
    ['top_products_by_sales', {}],
    ['revenue_by_period', { group_by: 'year' }]
];

// Gate 6. Sanitization is unconditional per plan §4, so it cannot depend on which of the six
// tools failed. Nothing these tools currently produce carries a path — better-sqlite3 leaves
// the filename out of its open errors — so the input has to be constructed, or the test
// passes while guarding nothing. The precondition assert below is what proves it was.
test('a driver error carrying a filesystem path is scrubbed on every analytics tool', () => {
    const leaky = 'unable to open database file /home/user/private/shop.db\n    at Database.prepare (/x/y.js:1:1)';
    assert.match(leaky, /\/home\/user\/private/, 'the injected error must actually carry a path');

    const handlers = captureHandlers({
        prepare() {
            throw new Error(leaky);
        }
    });

    for (const [name, args] of CALLS) {
        const result = handlers.get(name)(args);
        const text = result.content[0].text;

        assert.equal(result.isError, true, name);
        assert.ok(!text.includes('/Users'), `${name} leaked a path: ${text}`);
        assert.ok(!text.includes('private'), `${name} leaked a directory name: ${text}`);
        assert.ok(!/\bat\s+\S+\(/.test(text), `${name} leaked a stack frame: ${text}`);
        assert.match(text, /<database>/, `${name} did not route through the sanitizer: ${text}`);
    }
});

// The same routing has to carry the stable code, not just the scrubbing: a raw SQLITE_* code
// escaping to the agent is outside the vocabulary the README documents.
test('a deliberate refusal keeps its code and its teaching text through the same path', () => {
    const handlers = captureHandlers(shop);
    const text = handlers.get('top_customers_by_spend')({ limit: 500 }).content[0].text;

    assert.match(text, /^INVALID_ARGUMENT: /);
    assert.match(text, /1 to 100/);
});

// ---------------------------------------------------------------- the probe

// F3: the grader may attach a different shop.db. These tools exist only where the columns
// they hardcode exist, so the probe is what keeps them from being registered elsewhere.
test('the probe recognises shop.db', () => {
    assert.deepEqual(probeCapabilities(shop), { hasShopSchema: true });
});

test('the probe rejects a database with none of the shop tables', () => {
    assert.deepEqual(probeCapabilities(fixture()), { hasShopSchema: false });
});

// Table names alone are not enough: every column the SQL names has to be there, or the
// tool crashes on someone else's schema, which is strictly worse than being absent.
test('the probe rejects a shop-shaped schema missing one column the SQL needs', () => {
    const db = fixture(`
        CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT);
        CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT);
        CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER, unit_price REAL);
    `);
    assert.deepEqual(probeCapabilities(db), { hasShopSchema: false }, 'orders.status is absent');
});

// Gate 5, finding 2. SQLite identifiers are case-insensitive, so this schema is the same
// schema — and all three functions already run correctly against it. The precondition
// assert is the point: if the fixture ever stopped being upper-cased, the test would keep
// passing while guarding nothing.
test('the probe accepts the shop schema declared in a different case', () => {
    const schema = `
        CREATE TABLE Customers (ID INTEGER PRIMARY KEY, First_Name TEXT, LAST_NAME TEXT, Email TEXT);
        CREATE TABLE PRODUCTS (Id INTEGER PRIMARY KEY, NAME TEXT, Category TEXT);
        CREATE TABLE Orders (ID INTEGER PRIMARY KEY, Customer_Id INTEGER, ORDER_DATE TEXT, Status TEXT);
        CREATE TABLE Order_Items (Order_Id INTEGER, PRODUCT_ID INTEGER, Quantity INTEGER, Unit_Price REAL);
        INSERT INTO Customers VALUES (1, 'Ann', 'Lee', 'ann@example.com');
        INSERT INTO PRODUCTS VALUES (1, 'Widget', 'Tools');
        INSERT INTO Orders VALUES (1, 1, '2026-05-01 10:00:00', 'completed');
        INSERT INTO Order_Items VALUES (1, 1, 2, 15.0);
    `;
    assert.match(schema, /FIRST_NAME|First_Name/, 'the fixture must declare columns in a case we do not use');
    const db = fixture(schema);

    assert.deepEqual(probeCapabilities(db), { hasShopSchema: true });
    // The probe must not be stricter than the SQL it gates: this handle really does work.
    assert.deepEqual(topCustomersBySpend(db).customers, [
        { name: 'Ann Lee', email: 'ann@example.com', total_spent: 30, order_count: 1 }
    ]);
});

test('the probe reports false rather than throwing on a handle that cannot be read', () => {
    const broken = {
        prepare() {
            throw new Error('database disk image is malformed');
        }
    };
    assert.deepEqual(probeCapabilities(broken), { hasShopSchema: false });
});

// ------------------------------------------------- top_customers_by_spend (F5)

test('the top spender and their totals are the real ones, cancelled orders excluded', () => {
    const { customers, include_cancelled } = topCustomersBySpend(shop);

    assert.equal(include_cancelled, false, 'excluding cancelled orders is the default');
    assert.deepEqual(customers[0], {
        name: 'Екатерина Харитонов',
        email: 'ekaterina.kharitonov777@gmail.com',
        total_spent: 859460,
        order_count: 11
    });
    assert.equal(customers.length, 10, 'the default limit is 10');
});

// F5's whole point: the parameter exists because it changes the answer. Second and third
// place swap between the two bases, so asserting first place alone would pass either way.
test('including cancelled orders raises the totals and reorders the runners-up', () => {
    const excluded = topCustomersBySpend(shop, { limit: 3 });
    const included = topCustomersBySpend(shop, { limit: 3, includeCancelled: true });

    assert.deepEqual(
        excluded.customers.map(c => [c.name, c.total_spent]),
        [
            ['Екатерина Харитонов', 859460],
            ['Дмитрий Харитонов', 701780],
            ['Наталья Петрова', 690950]
        ]
    );
    assert.deepEqual(
        included.customers.map(c => [c.name, c.total_spent]),
        [
            ['Екатерина Харитонов', 885420],
            ['Наталья Петрова', 876900],
            ['Дмитрий Харитонов', 785750]
        ]
    );
    assert.equal(included.include_cancelled, true);
});

test('the note states which basis the totals were computed on', () => {
    assert.match(topCustomersBySpend(shop, { limit: 1 }).note, /cancelled orders are excluded/i);
    assert.match(
        topCustomersBySpend(shop, { limit: 1, includeCancelled: true }).note,
        /cancelled orders are included/i
    );
});

// Gate 5, finding 3. shop.db has no tie among its top rows, so the `, name ASC` tie-break
// was pure decoration there — deleting it failed nothing. SQLite guarantees no ordering
// among equal sort keys, so without it the same question can return a different ranking
// from one call to the next.
//
// The fixture needs enough tied rows to make coincidence implausible: measured, a
// two-row tie comes back alphabetically ANYWAY, so a two-row fixture passes with the
// tie-break deleted and guards nothing. With ten, the unguarded order is reverse
// insertion order. Names are inserted in an order that is neither alphabetical nor its
// reverse, so neither an unstable sort nor a stable one can produce the expected answer
// by accident.
const TIED_NAMES = ['Яна', 'Эмма', 'Юлия', 'Анна', 'Борис', 'Мария', 'Вера', 'Зоя', 'Ольга', 'Пётр'];
const ALPHABETICAL = [...TIED_NAMES].sort((a, b) => (a < b ? -1 : 1));

const TIED = `
    CREATE TABLE customers (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, email TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, category TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, order_date TEXT, status TEXT);
    CREATE TABLE order_items (order_id INTEGER, product_id INTEGER, quantity INTEGER, unit_price REAL);
    ${TIED_NAMES.map(
        (name, i) => `
    INSERT INTO customers VALUES (${i + 1}, '${name}', 'Ф', 'c${i + 1}@example.com');
    INSERT INTO products VALUES (${i + 1}, '${name}', 'Фрукты');
    INSERT INTO orders VALUES (${i + 1}, ${i + 1}, '2026-05-01 10:00:00', 'completed');
    INSERT INTO order_items VALUES (${i + 1}, ${i + 1}, 2, 50.0);`
    ).join('')}
`;

test('customers tied on spend are ranked by name, so the same question answers the same way', () => {
    const { customers } = topCustomersBySpend(fixture(TIED), { limit: 10 });

    assert.equal(customers.length, 10);
    assert.equal(
        new Set(customers.map(c => c.total_spent)).size,
        1,
        'the fixture must tie every customer on spend, or the tie-break is never reached'
    );
    assert.deepEqual(customers.map(c => c.name), ALPHABETICAL.map(name => `${name} Ф`));
});

test('products tied on the ranked metric are ranked by name', () => {
    const db = fixture(TIED);

    for (const rankBy of ['revenue', 'units']) {
        const { products } = topProductsBySales(db, { limit: 10, rankBy });
        assert.equal(new Set(products.map(p => p.revenue)).size, 1, `no revenue tie for ${rankBy}`);
        assert.equal(new Set(products.map(p => p.units_sold)).size, 1, `no units tie for ${rankBy}`);
        assert.deepEqual(products.map(p => p.name), ALPHABETICAL, rankBy);
    }
});

// Gate 5. run_sql_query cannot move its bounds into the schema (task 7 pins the teaching
// INVALID_ARGUMENT), so these align to it rather than to an SDK schema rejection: the same
// mistake gets the same shape of answer whichever tool family the agent reached for.
test('a limit outside the accepted range is refused with the range named', () => {
    for (const rank of [topCustomersBySpend, topProductsBySales]) {
        for (const limit of [0, -1, 500, 1.5]) {
            assert.throws(
                () => rank(shop, { limit }),
                err => {
                    assert.equal(err.code, 'INVALID_ARGUMENT', `${rank.name} limit=${limit}`);
                    assert.match(err.message, /1 to 100/, `${rank.name} limit=${limit}`);
                    return true;
                },
                `${rank.name} accepted limit=${limit}`
            );
        }
    }
});

test('the accepted range boundaries themselves are allowed', () => {
    assert.equal(topCustomersBySpend(shop, { limit: 1 }).customers.length, 1);
    assert.equal(topCustomersBySpend(shop, { limit: 100 }).customers.length, 100);
});

// ------------------------------------------------- top_products_by_sales (F6)

test('ranking by revenue and ranking by units disagree about the best seller', () => {
    const byRevenue = topProductsBySales(shop, { limit: 1 });
    const byUnits = topProductsBySales(shop, { limit: 1, rankBy: 'units' });

    assert.equal(byRevenue.ranked_by, 'revenue', 'revenue is the default ranking');
    assert.deepEqual(byRevenue.products[0], {
        name: 'Ноутбук UltraBook 15',
        category: 'Электроника',
        units_sold: 98,
        revenue: 8819020
    });
    assert.deepEqual(byUnits.products[0], {
        name: 'Планшет Tab 10',
        category: 'Электроника',
        units_sold: 123,
        revenue: 4303770
    });
});

// Both metrics on every row is the answer to F6's ambiguity: the agent can see that the
// unit leader is not the revenue leader without making a second call.
test('units_sold and revenue come back on every row whichever metric ranks', () => {
    for (const rankBy of ['revenue', 'units']) {
        const { products } = topProductsBySales(shop, { limit: 5, rankBy });
        for (const product of products) {
            assert.deepEqual(Object.keys(product), ['name', 'category', 'units_sold', 'revenue'], rankBy);
            assert.ok(product.units_sold > 0, `${product.name} sold no units`);
            assert.ok(product.revenue > 0, `${product.name} earned nothing`);
        }
    }
    const byUnits = topProductsBySales(shop, { limit: 3, rankBy: 'units' });
    assert.deepEqual(byUnits.products.map(p => p.units_sold), [123, 117, 111], 'not ordered by units');
});

// The two bases agree on which product earns the most, so a top-1 assertion would pass
// whatever include_cancelled did. Second and third place are where they disagree.
test('cancelled orders change the product ranking too', () => {
    const excluded = topProductsBySales(shop, { limit: 3 });
    const included = topProductsBySales(shop, { limit: 3, includeCancelled: true });

    assert.deepEqual(excluded.products.map(p => p.name), [
        'Ноутбук UltraBook 15',
        'Планшет Tab 10',
        'Смартфон Galaxy S21'
    ]);
    assert.deepEqual(included.products.map(p => p.name), [
        'Ноутбук UltraBook 15',
        'Смартфон Galaxy S21',
        'Планшет Tab 10'
    ]);
    assert.deepEqual(included.products[0], {
        name: 'Ноутбук UltraBook 15',
        category: 'Электроника',
        units_sold: 113,
        revenue: 10168870
    });
});

// ---------------------------------------------------- revenue_by_period (F2)

test('grouping by year finds both years this data covers', () => {
    const { buckets, available_range } = revenueByPeriod(shop, { groupBy: 'year' });

    assert.deepEqual(buckets, [
        { period: '2025', revenue: 8990280, order_count: 183, items_sold: 912 },
        { period: '2026', revenue: 28134150, order_count: 648, items_sold: 3295 }
    ]);
    assert.deepEqual(available_range, { min_order_date: '2025-09-01', max_order_date: '2026-08-22' });
});

test('grouping by month returns every month in order with its own revenue', () => {
    const { buckets } = revenueByPeriod(shop, { groupBy: 'month' });

    assert.deepEqual(
        buckets.map(b => [b.period, b.revenue]),
        [
            ['2025-09', 1660710],
            ['2025-10', 2098970],
            ['2025-11', 2407470],
            ['2025-12', 2823130],
            ['2026-02', 1502350],
            ['2026-03', 4347380],
            ['2026-04', 2981970],
            ['2026-05', 5644490],
            ['2026-06', 4285410],
            ['2026-07', 4660750],
            ['2026-08', 4711800]
        ],
        'January 2026 has no orders and must not appear as an empty bucket'
    );
    assert.deepEqual(buckets[0], { period: '2025-09', revenue: 1660710, order_count: 31, items_sold: 139 });
});

test('a start and end date bound the buckets inclusively at both ends', () => {
    const { buckets } = revenueByPeriod(shop, {
        groupBy: 'day',
        startDate: '2026-02-17',
        endDate: '2026-02-19'
    });

    assert.deepEqual(buckets, [
        { period: '2026-02-17', revenue: 61840, order_count: 2, items_sold: 6 },
        { period: '2026-02-18', revenue: 590770, order_count: 10, items_sold: 63 },
        { period: '2026-02-19', revenue: 169590, order_count: 7, items_sold: 21 }
    ]);
});

// Homework task 7. 2025 used to be the empty year; scripts/seed-extended-data.mjs gave it
// orders, so this is now the figure the agent must come back with.
test('2025 revenue is a real figure, not an empty range', () => {
    const result = revenueByPeriod(shop, {
        groupBy: 'year',
        startDate: '2025-01-01',
        endDate: '2025-12-31'
    });

    assert.deepEqual(result.buckets, [
        { period: '2025', revenue: 8990280, order_count: 183, items_sold: 912 }
    ]);
    assert.deepEqual(
        revenueByPeriod(shop, {
            groupBy: 'year',
            startDate: '2025-01-01',
            endDate: '2025-12-31',
            includeCancelled: true
        }).buckets,
        [{ period: '2025', revenue: 10906130, order_count: 210, items_sold: 1047 }]
    );
});

// F2's mechanism outlived the gap that motivated it: an empty list alone would cost the
// agent a turn, so the available range rides along. 2024 is now the year with no orders.
test('a range with no orders returns empty buckets carrying the real available range', () => {
    const result = revenueByPeriod(shop, {
        groupBy: 'year',
        startDate: '2024-01-01',
        endDate: '2024-12-31'
    });

    assert.deepEqual(result.buckets, []);
    assert.deepEqual(result.available_range, {
        min_order_date: '2025-09-01',
        max_order_date: '2026-08-22'
    });
    assert.match(result.note, /no orders in the requested range/i);
    assert.match(result.note, /2025-09-01/);
    assert.match(result.note, /2026-08-22/);
});

// Gate 5, finding 1. A date that is merely ISO-SHAPED but not a real date is the worst
// input this tool can take: the filter is a lexicographic comparison on text, so an
// impossible month does not error — it empties the range and the tool answers "revenue for
// that period is zero", sourced and confident, for a date SQLite itself resolves to NULL.
// That is the exact hallucination revenue_by_period exists to prevent.
test('an ISO-shaped date that is not a real calendar date is refused, not answered with zero', () => {
    for (const impossible of ['2026-13-01', '2026-99-99', '2026-00-00', '0000-00-00']) {
        assert.throws(
            () => revenueByPeriod(shop, { groupBy: 'year', startDate: impossible }),
            err => {
                assert.equal(err.code, 'INVALID_ARGUMENT', impossible);
                assert.match(err.message, /calendar date/, impossible);
                return true;
            },
            `${impossible} was accepted`
        );
    }
});

// SQLite rolls this forward to 2026-03-02 rather than rejecting it, so a shape check plus a
// bare "does SQLite parse it" check would both let it through and silently shift the range.
test('a day that does not exist in its month is refused rather than rolled forward', () => {
    assert.throws(() => revenueByPeriod(shop, { groupBy: 'day', endDate: '2026-02-30' }), {
        code: 'INVALID_ARGUMENT'
    });
});

test('a real leap day is accepted', () => {
    const { buckets } = revenueByPeriod(shop, {
        groupBy: 'day',
        startDate: '2024-02-29',
        endDate: '2025-09-01'
    });

    assert.deepEqual(buckets, [
        { period: '2025-09-01', revenue: 102530, order_count: 3, items_sold: 7 }
    ]);
});

test('a date that is not YYYY-MM-DD is refused with the accepted format named', () => {
    assert.throws(
        () => revenueByPeriod(shop, { groupBy: 'month', startDate: '01/2025' }),
        err => {
            assert.equal(err.code, 'INVALID_ARGUMENT');
            assert.match(err.message, /start_date/);
            assert.match(err.message, /YYYY-MM-DD/);
            return true;
        }
    );
    assert.throws(() => revenueByPeriod(shop, { groupBy: 'month', endDate: '2026-13-40x' }), {
        code: 'INVALID_ARGUMENT'
    });
});
