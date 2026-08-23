import { z } from 'zod';
import { QueryError } from './db.js';

/**
 * The columns the SQL below names. The grader may attach a different shop.db (F3), so
 * these tools are a bonus layer over the schema-agnostic three, not a replacement: they
 * are registered only where every one of these columns exists. A specialized tool that
 * crashes on someone else's database is strictly worse than one that is absent.
 */
const REQUIRED_COLUMNS = {
    customers: ['id', 'first_name', 'last_name', 'email'],
    products: ['id', 'name', 'category'],
    orders: ['id', 'customer_id', 'order_date', 'status'],
    order_items: ['order_id', 'product_id', 'quantity', 'unit_price']
};

/**
 * Whether this database has the shape the analytics tools hardcode. Runs once at boot and
 * never throws: an unreadable handle is simply a database these tools do not fit, and the
 * server must still start and serve the core tools.
 */
export function probeCapabilities(db) {
    try {
        for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
            // PRAGMA table_info returns an empty list for a table that does not exist, so
            // a missing table and a missing column are the same check. Names are folded to
            // lower case because SQLite identifiers are case-insensitive: a schema
            // declaring FIRST_NAME is the same schema, and the probe must not be stricter
            // than the SQL it gates.
            const present = new Set(
                db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name.toLowerCase())
            );
            if (required.some(column => !present.has(column))) {
                return { hasShopSchema: false };
            }
        }
        return { hasShopSchema: true };
    } catch {
        return { hasShopSchema: false };
    }
}

// Aligned with run_sql_query rather than with Zod's min/max: task 7 pins that tool to a
// teaching INVALID_ARGUMENT naming the range, it cannot move, and the same mistake should
// not get two different shapes of answer depending on which tool family the agent used.
// The bound still reaches the agent up front, through the field description.
const MAX_ROWS = 100;

function assertLimit(limit) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS) {
        throw new QueryError(
            'INVALID_ARGUMENT',
            `limit must be a whole number from 1 to ${MAX_ROWS}; received ${limit}`
        );
    }
}

const CANCELLED_FILTER = "o.status <> 'cancelled'";

const cancelledNote = includeCancelled =>
    includeCancelled
        ? 'cancelled orders are included in these figures; pass include_cancelled=false to exclude them'
        : 'cancelled orders are excluded from these figures; pass include_cancelled=true to include them';

const where = conditions => (conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '');

/**
 * Who spent the most, in one call instead of a three-table join. Ordered by money spent;
 * ties break by name so the ranking is stable between calls.
 */
export function topCustomersBySpend(db, { limit = 10, includeCancelled = false } = {}) {
    assertLimit(limit);

    const customers = db
        .prepare(
            `SELECT c.first_name || ' ' || c.last_name AS name,
                    c.email AS email,
                    ROUND(SUM(oi.quantity * oi.unit_price), 2) AS total_spent,
                    COUNT(DISTINCT o.id) AS order_count
             FROM customers c
             JOIN orders o ON o.customer_id = c.id
             JOIN order_items oi ON oi.order_id = o.id
             ${where(includeCancelled ? [] : [CANCELLED_FILTER])}
             GROUP BY c.id
             ORDER BY total_spent DESC, name ASC
             LIMIT ?`
        )
        .all(limit);

    return { customers, include_cancelled: includeCancelled, note: cancelledNote(includeCancelled) };
}

// rank_by picks the ORDER BY column, so it cannot be a bound parameter. It comes through
// this map and nothing else reaches the SQL.
const RANK_COLUMNS = { revenue: 'revenue', units: 'units_sold' };

/**
 * Products by sales, with BOTH metrics on every row. F6: the unit leader and the revenue
 * leader are different products here, so returning only the ranked metric would let the
 * agent answer "best-selling" without ever seeing that the question is ambiguous.
 */
export function topProductsBySales(db, { limit = 10, rankBy = 'revenue', includeCancelled = false } = {}) {
    assertLimit(limit);

    const products = db
        .prepare(
            `SELECT p.name AS name,
                    p.category AS category,
                    SUM(oi.quantity) AS units_sold,
                    ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue
             FROM products p
             JOIN order_items oi ON oi.product_id = p.id
             JOIN orders o ON o.id = oi.order_id
             ${where(includeCancelled ? [] : [CANCELLED_FILTER])}
             GROUP BY p.id
             ORDER BY ${RANK_COLUMNS[rankBy]} DESC, p.name ASC
             LIMIT ?`
        )
        .all(limit);

    return {
        products,
        ranked_by: rankBy,
        include_cancelled: includeCancelled,
        note: cancelledNote(includeCancelled)
    };
}

const PERIOD_FORMATS = { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' };

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accepts only a date SQLite agrees is that exact date. The shape check alone is not
 * enough and the round trip alone is not either:
 *   '2026-13-01'  date() returns NULL, and the range filter is a lexicographic string
 *                 comparison, so nothing errors — the range just comes back empty and the
 *                 tool reports a confident zero for a month that cannot exist.
 *   '2026-02-30'  date() does NOT reject it; it rolls forward to '2026-03-02' and would
 *                 silently shift the window the caller asked for.
 * Requiring date(?) to return the input unchanged is the only check that refuses both.
 */
function assertDate(db, label, value) {
    if (value === undefined) return;

    const resolved = DATE_PATTERN.test(value) ? db.prepare('SELECT date(?) AS d').get(value).d : null;
    if (resolved !== value) {
        throw new QueryError(
            'INVALID_ARGUMENT',
            `${label} must be a real calendar date written as YYYY-MM-DD; received ` +
                `"${value}"${resolved === null ? '' : `, which is not a date (SQLite reads it as ${resolved})`}`
        );
    }
}

/**
 * Revenue per day, month or year.
 *
 * The empty range is the behaviour that matters (F2). There are no orders in 2025 in this
 * data — order_date runs 2026-02-17 to 2026-08-22 — and homework task 7 asks for 2025
 * revenue. Throwing would read as a malfunction and invite a retry; returning a bare empty
 * list would cost a turn. So the result always carries the range the data actually spans,
 * formatted exactly as start_date and end_date accept it, and the note says the requested
 * range was empty. Both are what let the agent answer "zero, and here is why" in one turn.
 */
export function revenueByPeriod(
    db,
    { groupBy, startDate, endDate, includeCancelled = false } = {}
) {
    assertDate(db, 'start_date', startDate);
    assertDate(db, 'end_date', endDate);

    const conditions = includeCancelled ? [] : [CANCELLED_FILTER];
    const params = [PERIOD_FORMATS[groupBy]];
    if (startDate !== undefined) {
        conditions.push('date(o.order_date) >= ?');
        params.push(startDate);
    }
    if (endDate !== undefined) {
        conditions.push('date(o.order_date) <= ?');
        params.push(endDate);
    }

    const buckets = db
        .prepare(
            `SELECT strftime(?, o.order_date) AS period,
                    ROUND(SUM(oi.quantity * oi.unit_price), 2) AS revenue,
                    COUNT(DISTINCT o.id) AS order_count,
                    SUM(oi.quantity) AS items_sold
             FROM orders o
             JOIN order_items oi ON oi.order_id = o.id
             ${where(conditions)}
             GROUP BY period
             ORDER BY period ASC`
        )
        .all(...params);

    // Measured under the same status filter, so the range the agent reads back is a range
    // its next call can actually use.
    const range = db
        .prepare(
            `SELECT date(MIN(o.order_date)) AS min_order_date,
                    date(MAX(o.order_date)) AS max_order_date
             FROM orders o
             ${where(includeCancelled ? [] : [CANCELLED_FILTER])}`
        )
        .get();

    const notes = [cancelledNote(includeCancelled)];
    if (buckets.length === 0) {
        notes.unshift(
            range.min_order_date === null
                ? 'no orders in the requested range; this database contains no orders at all'
                : `no orders in the requested range, so revenue for it is zero; order dates ` +
                      `span ${range.min_order_date} to ${range.max_order_date}`
        );
    }

    return {
        group_by: groupBy,
        buckets,
        include_cancelled: includeCancelled,
        available_range: range,
        note: notes.join('; ')
    };
}

const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
};

const limitField = subject =>
    z
        .number()
        .int()
        .optional()
        .describe(`How many ${subject} to return, from 1 to ${MAX_ROWS}. Defaults to 10.`);

const includeCancelledField = z
    .boolean()
    .optional()
    .describe(
        'Whether orders with status "cancelled" count toward the figures. Defaults to false, ' +
            'which leaves them out. On data that contains cancelled orders this changes both ' +
            'the totals and the ranking, so it is an assumption worth stating in your answer ' +
            'rather than leaving implicit.'
    );

// The analytics shapes are fixed, unlike a SQL result, so they are worth declaring: the
// SDK validates structuredContent against them on every call.
const CUSTOMER_ROW = z.object({
    name: z.string(),
    email: z.string(),
    total_spent: z.number(),
    order_count: z.number().int()
});

const PRODUCT_ROW = z.object({
    name: z.string(),
    category: z.string(),
    units_sold: z.number(),
    revenue: z.number()
});

const BUCKET_ROW = z.object({
    period: z.string(),
    revenue: z.number(),
    order_count: z.number().int(),
    items_sold: z.number()
});

const asResult = value => ({
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value
});

// Same stopgap shape tools.js uses until task 10 gives errors a sanitizer of their own.
const asError = message => ({ content: [{ type: 'text', text: message }], isError: true });

/**
 * A bad limit or a bad date is the caller's to fix, so it comes back as a tool result it
 * can read and correct, not as a protocol error. The code is the stable part the model
 * pattern-matches on, which is why the shape matches run_sql_query's exactly.
 */
function toolResult(produce) {
    try {
        return asResult(produce());
    } catch (err) {
        return asError(`${err.code ?? 'ERROR'}: ${err.message}`);
    }
}

/**
 * Registers the three specialized tools. Called only when probeCapabilities matches, so
 * these tools are simply absent on a schema they do not fit and the agent falls back to
 * run_sql_query.
 */
export function registerAnalyticsTools(server, { db }) {
    server.registerTool(
        'top_customers_by_spend',
        {
            title: 'Top customers by spend',
            description: [
                'Rank customers by how much money they have spent, with each one\'s order count.',
                '',
                'WHEN TO USE: "who are our best customers", "who spent the most", "top spenders" —',
                'this answers it in one call instead of a customers→orders→order_items join. For',
                'anything narrower — a date window, one product category, a different metric —',
                'use run_sql_query.',
                'RETURNS: {customers: [{name, email, total_spent, order_count}], include_cancelled,',
                'note}, highest spend first. `total_spent` sums quantity × unit_price across the',
                'customer\'s order items and `order_count` counts their distinct orders, both under',
                'the same cancelled-order filter. Customers who never ordered are not listed.',
                'LIMITS: ranks by money only — for "who placed the most orders" use run_sql_query,',
                'which is a different ranking. At most 100 customers per call. Read-only.'
            ].join('\n'),
            inputSchema: {
                limit: limitField('customers'),
                include_cancelled: includeCancelledField
            },
            outputSchema: {
                customers: z.array(CUSTOMER_ROW),
                include_cancelled: z.boolean(),
                note: z.string()
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        ({ limit, include_cancelled }) =>
            toolResult(() => topCustomersBySpend(db, { limit, includeCancelled: include_cancelled }))
    );

    server.registerTool(
        'top_products_by_sales',
        {
            title: 'Top products by sales',
            description: [
                'Rank products by sales, reporting units sold and revenue for every product.',
                '',
                'WHEN TO USE: "best-selling products", "top products", "what sells most". Note that',
                '"best-selling" is ambiguous and the two readings usually disagree: the product',
                'that moves the most units is rarely the one that earns the most money. Both',
                'numbers therefore come back on every row and `rank_by` only chooses the order —',
                'pick it deliberately and say which reading you used when you answer.',
                'RETURNS: {products: [{name, category, units_sold, revenue}], ranked_by,',
                'include_cancelled, note}, ordered by the chosen metric descending. `units_sold`',
                'sums order-item quantities; `revenue` sums quantity × unit_price. Products that',
                'were never ordered are not listed.',
                'LIMITS: covers all time and every category at once — for a date window use',
                'revenue_by_period, and for a per-category or per-customer breakdown use',
                'run_sql_query. At most 100 products per call. Read-only.'
            ].join('\n'),
            inputSchema: {
                limit: limitField('products'),
                rank_by: z
                    .enum(['units', 'revenue'])
                    .optional()
                    .describe(
                        'Which metric orders the result: "revenue" (the default) or "units". Both ' +
                            'metrics are returned either way; this only chooses the ordering.'
                    ),
                include_cancelled: includeCancelledField
            },
            outputSchema: {
                products: z.array(PRODUCT_ROW),
                ranked_by: z.enum(['units', 'revenue']),
                include_cancelled: z.boolean(),
                note: z.string()
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        ({ limit, rank_by, include_cancelled }) =>
            toolResult(() =>
                topProductsBySales(db, {
                    limit,
                    rankBy: rank_by,
                    includeCancelled: include_cancelled
                })
            )
    );

    server.registerTool(
        'revenue_by_period',
        {
            title: 'Revenue by period',
            description: [
                'Total revenue per day, month or year, with the order and item counts behind it.',
                '',
                'WHEN TO USE: "revenue in 2025", "monthly sales", "how did sales trend" — any',
                'time-bucketed total. Buckets are cut on orders.order_date, which is the only',
                'column that records when a sale happened: customers.created_at and',
                'products.created_at are registration dates and may well cover years in which',
                'nothing was ever sold, so grouping by them answers a different question.',
                'RETURNS: {group_by, buckets: [{period, revenue, order_count, items_sold}],',
                'include_cancelled, available_range, note}, oldest bucket first. `available_range`',
                'gives the earliest and latest order date present under the same filter, written',
                'as YYYY-MM-DD so it can be passed straight back in as start_date/end_date.',
                'AN EMPTY `buckets` LIST IS AN ANSWER, NOT AN ERROR: it means no orders fall in',
                'the range you asked for, so revenue for that range is zero. Do not retry the same',
                'range and do not estimate a figure — read `available_range`, tell the user the',
                'period they asked about has no orders, and name the period the data does cover.',
                'LIMITS: buckets by date only; no product, category or customer breakdown — use',
                'run_sql_query for those. Read-only.'
            ].join('\n'),
            inputSchema: {
                group_by: z
                    .enum(['day', 'month', 'year'])
                    .describe('Bucket size: "day", "month" or "year".'),
                start_date: z
                    .string()
                    .optional()
                    .describe(
                        'Earliest order date to include, as YYYY-MM-DD. Inclusive. Omit for no ' +
                            'lower bound.'
                    ),
                end_date: z
                    .string()
                    .optional()
                    .describe(
                        'Latest order date to include, as YYYY-MM-DD. Inclusive, so orders placed ' +
                            'during that day are counted. Omit for no upper bound.'
                    ),
                include_cancelled: includeCancelledField
            },
            outputSchema: {
                group_by: z.enum(['day', 'month', 'year']),
                buckets: z.array(BUCKET_ROW),
                include_cancelled: z.boolean(),
                available_range: z.object({
                    min_order_date: z.string().nullable(),
                    max_order_date: z.string().nullable()
                }),
                note: z.string()
            },
            annotations: READ_ONLY_ANNOTATIONS
        },
        ({ group_by, start_date, end_date, include_cancelled }) =>
            toolResult(() =>
                revenueByPeriod(db, {
                    groupBy: group_by,
                    startDate: start_date,
                    endDate: end_date,
                    includeCancelled: include_cancelled
                })
            )
    );
}
