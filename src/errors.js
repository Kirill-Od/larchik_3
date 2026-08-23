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
 * Anything that starts like a filesystem path, run to a terminator that genuinely cannot
 * occur mid-path.
 *
 * The earlier version allow-listed what a component may contain, which is the wrong shape of
 * rule: every leak found in review was a character nobody enumerated — a second space, an
 * apostrophe, a bracket, Cyrillic, CJK. So this inverts it. A component may contain anything
 * at all, including spaces, and the match ends only at a quote, an angle bracket or a line
 * break. Over-scrubbing trailing prose is the deliberate direction to fail in: losing a few
 * words of a diagnostic is recoverable, leaking a directory name is not.
 *
 * The lookbehind is what keeps `a/b`, `2026/08/23` and `http://example.com/foo/bar` intact —
 * a separator preceded by a word character, a colon or another slash is not a path anchor.
 * Requiring one non-space character after the anchor is what keeps `near "/": syntax error`
 * intact.
 */
const PATH = /(?<![\w:/\\])(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"`<>\n\r][^"`<>\n\r]*/g;

/**
 * Strips anything filesystem-shaped and any stack frame. SQLite's own diagnostics are worth
 * forwarding word for word — "no such column: country" is exactly what the agent needs — so
 * this has to remove paths without damaging the message around them.
 */
export function sanitize(message) {
    return String(message)
        .replace(/\n\s*at\s+.*/g, '')
        .replace(PATH, match => {
            // Keep sentence punctuation that trails the path outside the placeholder.
            const path = match.replace(/[\s.,;:!?]+$/, '');
            return PLACEHOLDER + match.slice(path.length);
        })
        .trim();
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

/**
 * The complete set of codes an agent may receive, and the whole contract the README
 * documents as stable. A driver code such as SQLITE_NOTADB is not one of them: it carries
 * engine internals and no remedy the agent can act on.
 *
 * Anything unrecognized maps to INTERNAL_ERROR, deliberately and not to SQL_ERROR. Reporting
 * a server-side fault as a query fault sends the agent to rewrite a query that was never the
 * problem; it fails identically and rewrites again, burning every remaining turn. A code
 * that names the wrong side of the boundary is worse than a code the caller has not seen
 * before.
 */
const AGENT_FACING_CODES = new Set([
    'READ_ONLY_VIOLATION',
    'SQL_ERROR',
    'INVALID_ARGUMENT',
    'QUERY_TIMEOUT',
    'CONFIGURATION_ERROR',
    'INTERNAL_ERROR'
]);

const INTERNAL_ADVICE =
    'This is a fault in the server, not in your request: rewriting the query will not help. ' +
    'Report what you were trying to do rather than retrying';

/** Converts any thrown value into the MCP tool result the agent sees. */
export function toToolResult(err) {
    const code = AGENT_FACING_CODES.has(err?.code) ? err.code : 'INTERNAL_ERROR';

    let advice = null;
    if (err?.remedy) {
        advice = remedyAdvice(err);
    } else if (code === 'INTERNAL_ERROR') {
        advice = INTERNAL_ADVICE;
    }
    const message = advice ? `${err.message}. ${advice}` : String(err?.message ?? err);

    return {
        content: [{ type: 'text', text: `${code}: ${sanitize(message)}` }],
        isError: true
    };
}
