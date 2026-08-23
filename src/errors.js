/**
 * Every failure the agent can see passes through here. Two jobs: give it a stable `code` to
 * pattern-match, and make sure the text that reaches it teaches rather than merely denies —
 * while never carrying a filesystem path or a stack frame out of the process.
 */

const PLACEHOLDER = '<database>';

/** Base for every failure this server raises deliberately. */
export class AppError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'AppError';
        this.code = code;
    }
}

/**
 * Retained because analytics.js constructs errors by code. AppError is the real base; new
 * code should throw one of the specific classes below instead of naming a code by hand.
 */
export class QueryError extends AppError {}

export class ConfigurationError extends AppError {
    constructor(message) {
        super('CONFIGURATION_ERROR', message);
    }
}

export class InvalidArgument extends AppError {
    constructor(message) {
        super('INVALID_ARGUMENT', message);
    }
}

export class SqlError extends AppError {
    constructor(message) {
        super('SQL_ERROR', message);
    }
}

export class QueryTimeout extends AppError {
    constructor(message) {
        super('QUERY_TIMEOUT', message);
    }
}

/**
 * Strips anything filesystem-shaped and any stack frame. SQLite's own diagnostics are worth
 * forwarding word for word — "no such column: country" is exactly what the agent needs — so
 * this has to remove paths without damaging the message around them.
 */
export function sanitize(message) {
    let out = String(message)
        .replace(/\n\s*at\s+.*/g, '')
        .replace(/(?<![\w.])(?:[A-Za-z]:\\|\\\\)[^\s]*/g, PLACEHOLDER)
        // One separator is enough: SHOP_DB_PATH=/shop.db is ordinary inside a container. The
        // character class keeps `near "/": syntax error` intact and the lookbehind keeps
        // 2026/08/23 and http:// from being mistaken for paths.
        .replace(/(?<![\w:/])\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g, PLACEHOLDER);

    // A path containing a space survives the pass above as a tail: "/tmp/my proj/shop.db"
    // becomes "<database> proj/shop.db", which still leaks a directory name. Absorb
    // slash-bearing tokens that directly follow the placeholder, repeatedly, so paths with
    // several spaces collapse too. Requiring a slash inside the token is what stops ordinary
    // prose after a path from being eaten.
    let previous;
    do {
        previous = out;
        out = out.replace(
            /<database>(?:\s+[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)/g,
            PLACEHOLDER
        );
    } while (out !== previous);

    return out.trim();
}

/**
 * The read-only equivalent of a refused write, built from the guard's normalized statement.
 * A refusal that ends with the SELECT the agent should have sent keeps the turn productive;
 * one that only says "denied" wastes it.
 *
 * This is a suggestion, not something the server runs, so "helpful" is the bar rather than
 * "provably equivalent". It returns null when the shape is not recognized, and the caller
 * falls back to generic advice rather than offering something malformed.
 */
export function readOnlyEquivalent({ statement, statementTruncated }) {
    if (!statement || statementTruncated) return null;

    const text = statement.trim();
    let match;

    if ((match = /^DELETE\s+FROM\s+(.+)$/i.exec(text))) {
        return `SELECT * FROM ${match[1]}`;
    }
    if ((match = /^UPDATE\s+(\S+)\s+SET\s+(.+)$/i.exec(text))) {
        const where = /\sWHERE\s.+$/i.exec(match[2]);
        return `SELECT * FROM ${match[1]}${where ? where[0] : ''}`;
    }
    if ((match = /^(?:INSERT|REPLACE)\s+(?:OR\s+\S+\s+)?INTO\s+([^\s(]+)/i.exec(text))) {
        return `SELECT * FROM ${match[1]}`;
    }
    if ((match = /^(?:DROP|ALTER|TRUNCATE)\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^\s(;]+)/i.exec(text))) {
        return `SELECT * FROM ${match[1]}`;
    }
    return null;
}

/**
 * Guidance keyed by the guard's `remedy`, because the three refusals an agent actually hits
 * have three different fixes and must not read alike: a write needs the equivalent SELECT, a
 * PRAGMA needs a different tool, and an English sentence in the `sql` field needs SQL.
 */
function remedyAdvice(err) {
    switch (err.remedy) {
        case 'USE_SELECT': {
            const equivalent = readOnlyEquivalent(err);
            return equivalent
                ? `Read the same rows instead: ${equivalent}`
                : 'Send a SELECT that reads the data instead of changing it.';
        }
        case 'USE_DESCRIBE_TABLE':
            return 'Use the describe_table tool for schema information; PRAGMA is not available here.';
        case 'WRITE_SQL':
            return (
                'Write SQL, not an instruction in English: the sql argument takes a statement ' +
                "such as SELECT * FROM orders WHERE status = 'cancelled'."
            );
        case 'SINGLE_STATEMENT':
            return 'Send one statement per call; remove everything after the first.';
        case 'FIX_SYNTAX':
            return 'Fix the syntax and send the statement again.';
        case 'SHORTEN':
            return 'Send a shorter statement.';
        default:
            return null;
    }
}

/** Converts any thrown value into the MCP tool result the agent sees. */
export function toToolResult(err) {
    const code = err?.code ?? 'INTERNAL_ERROR';
    const advice = err?.remedy ? remedyAdvice(err) : null;
    const message = advice ? `${err.message}. ${advice}` : String(err?.message ?? err);

    return {
        content: [{ type: 'text', text: `${code}: ${sanitize(message)}` }],
        isError: true
    };
}
