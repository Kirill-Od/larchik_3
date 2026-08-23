/**
 * L3 of the read-only model. Pure: it takes a SQL string and either returns or throws,
 * and never sees a database handle. It exists because L0-L2 are not sufficient. Measured
 * against a better-sqlite3 connection opened SQLITE_OPEN_READONLY, with the guard removed
 * (see plan F4, and the tests that re-measure it):
 *
 *   ATTACH DATABASE '<an existing .db>'  succeeds, and its rows can then be read across
 *                                        the attachment — exfiltration of any SQLite file
 *                                        the process can open. stmt.readonly is TRUE.
 *   PRAGMA writable_schema = ON          succeeds. stmt.readonly is TRUE, so L1 and L2
 *                                        wave it through as well.
 *   CREATE TEMP TABLE t(x)               succeeds, and the table is then visible in
 *                                        sqlite_temp_master. stmt.readonly is FALSE here,
 *                                        so L2 does catch this one.
 *
 * ATTACH of a *nonexistent* file creates nothing: SQLite opens an attached database with
 * the parent connection's readonly flag, so it is SQLITE_CANTOPEN. The threat is reading
 * another database, not writing a new one.
 *
 * One honest qualification on ATTACH, from the task-12 capstone reverting one layer at a
 * time. With this guard no-op'd the exfiltration *still* fails today — but not because
 * anything guards it: runQuery reaches a statement only through columns() and iterate(),
 * and better-sqlite3 throws on both for a statement that returns no rows, which is every
 * ATTACH, every DDL and every PRAGMA-set ("The columns() method is only for statements
 * that return data"). That is an accident of the paging code, not a layer, and it must not
 * be relied on: it evaporates the first time anyone adds a .run() path for statements that
 * return nothing, and it never covered the one write shape that does return rows —
 * DELETE/INSERT/UPDATE ... RETURNING, measured with reader true. L3 is what is still
 * standing on that day, and the capstone keeps its ATTACH and sqlite_temp_master
 * assertions as the regression guard for exactly that change.
 *
 * It is a lexer, not a regex, and that is load-bearing in both directions: a comment or a
 * string literal must not be able to smuggle a verb in, and a literal that merely
 * *contains* "DROP TABLE" must not be refused. A regex is provably wrong on both.
 */

const MAX_SQL_LENGTH = 100_000;
const MAX_CONSTRUCT_CHARS = 32;
const MAX_STATEMENT_CHARS = 200;

const MESSAGES = {
    EMPTY_INPUT: () => 'no SQL statement was provided',
    MULTIPLE_STATEMENTS: () => 'only one statement may be sent per call',
    DISALLOWED_OPENER: c => `a statement opening with ${c} is not permitted`,
    FORBIDDEN_VERB: c => `${c} is not permitted on a read-only connection`,
    NOT_SQL: () => 'the sql argument is not a SQL statement',
    UNTERMINATED_TOKEN: c => `unterminated ${c}`,
    ILLEGAL_CHARACTER: c => `${c} is not allowed in a SQL statement`,
    TOO_LONG: c => `the statement is longer than ${c} characters`
};

/**
 * Thrown when a statement is not an unambiguously read-only single SELECT.
 *
 * `code` is stable for callers that pattern-match; `reason` and `remedy` distinguish the
 * cases whose fixes differ, so the message layer (task 10) can tell the model what to do
 * instead of merely that it was denied. `statement` is a normalized rendering of the
 * surviving tokens — capped, because nothing unbounded from the caller may reach a log or
 * a message — and it is what lets task 10 offer the read-only equivalent of a write.
 */
export class ReadOnlyViolation extends Error {
    constructor({ reason, construct, remedy, statement = '', statementTruncated = false }) {
        super(`read-only guard: ${MESSAGES[reason](construct)}`);
        this.name = 'ReadOnlyViolation';
        this.code = 'READ_ONLY_VIOLATION';
        this.reason = reason;
        this.construct = construct;
        this.remedy = remedy;
        this.statement = statement;
        this.statementTruncated = statementTruncated;
    }
}

// -----------------------------------------------------------------------------
// Lexing
// -----------------------------------------------------------------------------

// JS \s is a strict superset of the five characters SQLite treats as whitespace, and it
// already covers the BOM. Splitting on more than SQLite does can only ever break a token
// into smaller pieces, so the guard sees at least the tokens SQLite sees, never fewer.
const WHITESPACE = /\s/u;
const OPERATOR = /[-+*/%<>=~&|!]/;
const PUNCTUATION = new Set(['(', ')', '[', ']', ',', ';', '.', '?']);

const QUOTES = new Map([
    ["'", { closer: "'", doubling: true, name: 'string literal' }],
    ['"', { closer: '"', doubling: true, name: 'quoted identifier' }],
    ['`', { closer: '`', doubling: true, name: 'quoted identifier' }],
    ['[', { closer: ']', doubling: false, name: 'quoted identifier' }]
]);

function unterminated(name) {
    return new ReadOnlyViolation({
        reason: 'UNTERMINATED_TOKEN',
        construct: name,
        remedy: 'FIX_SYNTAX'
    });
}

/** Index just past the closing quote, or a refusal if the text runs out first. */
function scanQuoted(sql, start) {
    const { closer, doubling, name } = QUOTES.get(sql[start]);
    for (let i = start + 1; i < sql.length; i++) {
        if (sql[i] !== closer) continue;
        if (doubling && sql[i + 1] === closer) {
            i++;
            continue;
        }
        return i + 1;
    }
    throw unterminated(name);
}

/**
 * The significant tokens: comments produce none, and quoted text produces one opaque
 * token that the verb scan never looks inside. Tokens keep their original text so a
 * refusal can render the statement back for the message layer.
 */
function lex(sql) {
    const tokens = [];
    let i = 0;

    while (i < sql.length) {
        const ch = sql[i];

        if (WHITESPACE.test(ch)) {
            i++;
        } else if (ch === '-' && sql[i + 1] === '-') {
            const newline = sql.indexOf('\n', i);
            i = newline === -1 ? sql.length : newline + 1;
        } else if (ch === '/' && sql[i + 1] === '*') {
            // SQLite does not nest block comments — the first `*/` ends it, verified
            // against 3.53.4. A lexer that nested them would read
            // `/* /* */ DELETE FROM orders */` as one comment and wave the DELETE
            // through, while SQLite executes it.
            const close = sql.indexOf('*/', i + 2);
            if (close === -1) throw unterminated('block comment');
            i = close + 2;
        } else if (QUOTES.has(ch)) {
            const end = scanQuoted(sql, i);
            tokens.push({ word: false, text: sql.slice(i, end) });
            i = end;
        } else if (PUNCTUATION.has(ch)) {
            tokens.push({ word: false, text: ch });
            i++;
        } else if (OPERATOR.test(ch)) {
            let end = i + 1;
            while (end < sql.length && OPERATOR.test(sql[end])) end++;
            tokens.push({ word: false, text: sql.slice(i, end) });
            i = end;
        } else {
            // Everything unclassified continues a word, so a token the lexer has no rule
            // for still ends up whole rather than being silently dropped.
            let end = i + 1;
            while (
                end < sql.length &&
                !WHITESPACE.test(sql[end]) &&
                !QUOTES.has(sql[end]) &&
                !PUNCTUATION.has(sql[end]) &&
                !OPERATOR.test(sql[end])
            ) {
                end++;
            }
            tokens.push({ word: true, text: sql.slice(i, end) });
            i = end;
        }
    }
    return tokens;
}

// -----------------------------------------------------------------------------
// Rendering a refusal back to the caller
// -----------------------------------------------------------------------------

const NO_SPACE_BEFORE = new Set([',', ')', ']', ';', '.']);
const NO_SPACE_AFTER = new Set(['(', '[', '.']);

/** Re-joins the lexed tokens as valid, normalized SQL, capped at MAX_STATEMENT_CHARS. */
function renderStatement(tokens) {
    let statement = '';
    let previous = null;

    for (const token of tokens) {
        const glued =
            previous === null || NO_SPACE_BEFORE.has(token.text) || NO_SPACE_AFTER.has(previous);
        const grown = `${statement}${glued ? '' : ' '}${token.text}`;
        if (grown.length > MAX_STATEMENT_CHARS) {
            return { statement: `${statement}…`, statementTruncated: true };
        }
        statement = grown;
        previous = token.text;
    }
    return { statement, statementTruncated: false };
}

// -----------------------------------------------------------------------------
// The rules
// -----------------------------------------------------------------------------

/**
 * An allow-list, not a denylist: a construct nobody anticipated is refused by default
 * rather than needing an entry added for it. `ANALYZE` is the illustration — it writes to
 * sqlite_stat1 and appears in no list of "dangerous" verbs.
 */
const ALLOWED_OPENERS = new Set(['SELECT', 'WITH', 'VALUES']);

/**
 * Applied to every bare word anywhere in the statement, not just the first, because
 * `WITH x AS (SELECT 1) DELETE FROM orders` passes any opener check. Quoted text is not
 * scanned, so `SELECT "delete"` is untouched.
 *
 * load_extension is not a statement verb but a function that loads an arbitrary shared
 * library; measured on this build, sqlite3_stmt_readonly reports true for it, so L2 does
 * not catch it.
 */
const FORBIDDEN_VERBS = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'REPLACE', 'TRUNCATE',
    'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'BEGIN', 'COMMIT', 'END',
    'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'LOAD_EXTENSION'
]);

/**
 * SQLite also exposes every pragma as a table-valued function — `SELECT * FROM
 * pragma_table_info('orders')` — which is an ordinary identifier behind an allowed opener,
 * so neither the opener allow-list nor the PRAGMA verb sees it. Matching the prefix costs
 * the bare identifiers that start with it (`pragma_notes` as a table name is refused; the
 * quoted spelling still works), which is the direction to fail in: the guard holds no
 * schema and cannot tell such a table from the function.
 */
const PRAGMA_FUNCTION_PREFIX = 'PRAGMA_';

/** PRAGMA is legitimate intent with the wrong tool, so its remedy is a different tool. */
const REMEDIES = { PRAGMA: 'USE_DESCRIBE_TABLE' };

/**
 * Words that essentially never appear in an English sentence about data. Used only to
 * choose between two refusal *messages* — it can never turn a refusal into an
 * acceptance — because "DELETE is forbidden" is the wrong thing to tell an agent that
 * put the user's sentence in the sql field. What it needs to hear is "write SQL".
 */
const SQL_STRUCTURE = new Set([
    'SELECT', 'FROM', 'WHERE', 'INTO', 'SET', 'TABLE', 'JOIN', 'VALUES', 'DATABASE',
    'INDEX', 'VIEW', 'TRIGGER', 'UNION', 'HAVING', 'LIMIT', 'OFFSET', 'DISTINCT',
    'INNER', 'OUTER', 'LEFT', 'RIGHT', 'ON', 'AS', 'GROUP', 'ORDER', 'BY', 'COLUMN',
    'EXISTS', 'CASE', 'WHEN', 'PRAGMA'
]);
const PROSE_PUNCTUATION = new Set(['.', ',', '?', '!']);

function looksLikeProse(tokens) {
    const words = tokens.filter(token => token.word);
    if (words.length < 3) return false;
    if (tokens.some(token => !token.word && !PROSE_PUNCTUATION.has(token.text))) return false;
    return !words.some(token => SQL_STRUCTURE.has(token.text.toUpperCase()));
}

function refuse(tokens, { reason, construct, remedy }) {
    const prose = looksLikeProse(tokens);
    throw new ReadOnlyViolation({
        reason: prose ? 'NOT_SQL' : reason,
        construct: prose ? null : construct.slice(0, MAX_CONSTRUCT_CHARS),
        remedy: prose ? 'WRITE_SQL' : remedy,
        ...renderStatement(tokens)
    });
}

/**
 * Every bare word, with two keywords that collide with ordinary expression syntax:
 *
 * END is a synonym for COMMIT *and* the closing keyword of a CASE expression, which
 * analytical SQL is full of. Dropping it from the list would be a real weakening;
 * keeping it unconditionally would refuse legitimate queries. Pairing resolves it — an
 * END that closes an open CASE is expression syntax, an unpaired one is the verb.
 *
 * REPLACE is a write statement (`REPLACE INTO`) and also one of SQLite's most-used scalar
 * functions. A call is followed by `(`; the statement form is followed by `INTO`.
 */
function assertNoForbiddenVerb(tokens) {
    let caseDepth = 0;

    for (let i = 0; i < tokens.length; i++) {
        if (!tokens[i].word) continue;
        const verb = tokens[i].text.toUpperCase();
        const pragmaFunction = verb.startsWith(PRAGMA_FUNCTION_PREFIX);

        if (verb === 'CASE') {
            caseDepth++;
        } else if (verb === 'END' && caseDepth > 0) {
            caseDepth--;
        } else if (verb === 'REPLACE' && tokens[i + 1]?.text === '(') {
            continue;
        } else if (FORBIDDEN_VERBS.has(verb) || pragmaFunction) {
            // pragma_table_info and PRAGMA table_info are the same request, so the
            // function forms carry the same remedy as the statement.
            refuse(tokens, {
                reason: 'FORBIDDEN_VERB',
                construct: verb,
                remedy: (pragmaFunction ? REMEDIES.PRAGMA : REMEDIES[verb]) ?? 'USE_SELECT'
            });
        }
    }
}

export function assertReadOnly(sql) {
    // Before anything reads sql.length: the contract is that this function returns or
    // throws ReadOnlyViolation, and internal callers such as runQuery are not behind the
    // tool boundary's z.string().
    if (typeof sql !== 'string') {
        throw new ReadOnlyViolation({
            reason: 'NOT_SQL',
            construct: null,
            remedy: 'WRITE_SQL'
        });
    }

    if (sql.length > MAX_SQL_LENGTH) {
        throw new ReadOnlyViolation({
            reason: 'TOO_LONG',
            construct: String(MAX_SQL_LENGTH),
            remedy: 'SHORTEN'
        });
    }

    // SQLite truncates its statement text at a NUL — `SELECT 1 \0; DROP TABLE x` prepares
    // as `SELECT 1 `. Refusing outright is the only way the guard and the engine are
    // guaranteed to agree about where the statement ends.
    if (sql.includes('\0')) {
        throw new ReadOnlyViolation({
            reason: 'ILLEGAL_CHARACTER',
            construct: 'a null byte',
            remedy: 'FIX_SYNTAX'
        });
    }

    const tokens = lex(sql);

    if (tokens.length === 0) {
        throw new ReadOnlyViolation({
            reason: 'EMPTY_INPUT',
            construct: null,
            remedy: 'WRITE_SQL'
        });
    }

    // A semicolon anywhere but the very end means a second statement follows — including
    // `SELECT 1;;`, where what follows is empty. Deciding that an empty tail is harmless
    // would mean the guard has to reason about what comes after a separator, which is
    // exactly the reasoning this rule exists to avoid.
    const separator = tokens.findIndex(token => token.text === ';');
    if (separator !== -1 && separator !== tokens.length - 1) {
        refuse(tokens, {
            reason: 'MULTIPLE_STATEMENTS',
            construct: ';',
            remedy: 'SINGLE_STATEMENT'
        });
    }

    // Before the opener check, so that PRAGMA and the transaction verbs are reported as
    // the constructs they are and can carry their own remedy.
    assertNoForbiddenVerb(tokens);

    const opener = tokens[0].text.toUpperCase();
    if (!tokens[0].word || !ALLOWED_OPENERS.has(opener)) {
        refuse(tokens, {
            reason: 'DISALLOWED_OPENER',
            construct: opener,
            remedy: 'USE_SELECT'
        });
    }
}
