import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError, sanitize, toToolResult } from '../src/errors.js';

/**
 * Exact equality, not a substring check: an earlier version of this helper asserted that no
 * component of the path survived anywhere in the output, and "e f" from `/a b c d/e f/x.db`
 * matched inside the word "databas-e f-ile" in the carrier message. Comparing the whole
 * result against the one string it should be catches every leak and cannot false-positive.
 */
function assertFullyScrubbed(path) {
    assert.equal(sanitize(`open ${path}`), 'open <database>');
}

// Enumerating what a path component may contain is the bug: the interesting inputs are the
// ones not enumerated. These are the shapes an ASCII allow-list misses.
const LEAKY_PATHS = [
    '/tmp/my proj/shop.db',
    '/tmp/my great proj/shop.db',
    '/a b c d/e f/shop.db',
    '/home/user/Документы/моя папка/shop.db',
    '/tmp/日本 語/shop.db',
    "/tmp/anna's files/shop.db",
    '/tmp/proj (old)/shop.db',
    '/tmp/db@2/shop.db',
    '/shop.db',
    'C:\\Users\\Kirio\\My Documents\\shop.db',
    '\\\\server\\share\\shop.db'
];

for (const path of LEAKY_PATHS) {
    test(`sanitize leaves nothing of ${path}`, () => {
        assertFullyScrubbed(path);
    });
}

test('a path is scrubbed wherever it sits in the message', () => {
    // Leading, and quoted mid-message. The greedy match deliberately takes the trailing prose
    // with it in the first case: over-scrubbing a few words beats leaking a directory name.
    assert.equal(sanitize('/tmp/my proj/shop.db could not be read'), '<database>');
    assert.equal(sanitize('error: "/tmp/my proj/shop.db" is bad'), 'error: "<database>" is bad');
});

// Over-scrubbing would destroy the diagnostics that make SQL_ERROR worth forwarding at all.
const PRESERVED = [
    'no such column: country',
    'near "FROM": syntax error',
    'near "/": syntax error',
    'no such table: main.gone',
    'datatype mismatch on 2026/08/23',
    'unrecognized token: "http://example.com/foo/bar"',
    'SELECT a/b FROM t',
    'file is not a database'
];

for (const message of PRESERVED) {
    test(`sanitize leaves ${JSON.stringify(message)} alone`, () => {
        assert.equal(sanitize(message), message);
    });
}

test('sanitize removes stack frames', () => {
    const withFrames = 'boom\n    at Object.<anonymous> (thing.js:1:1)\n    at run (other.js:2:2)';
    const result = sanitize(withFrames);
    assert.equal(result, 'boom');
});

// The six documented codes are the whole vocabulary. A driver code such as SQLITE_NOTADB is
// not one of them: it carries engine internals and no remedy the agent can act on.
const VOCABULARY = new Set([
    'READ_ONLY_VIOLATION',
    'SQL_ERROR',
    'INVALID_ARGUMENT',
    'QUERY_TIMEOUT',
    'CONFIGURATION_ERROR',
    'INTERNAL_ERROR'
]);

test('a driver error code is never forwarded to the agent', () => {
    const driverError = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
    const text = toToolResult(driverError).content[0].text;

    const code = text.split(':')[0];
    assert.ok(VOCABULARY.has(code), `code ${code} is outside the documented vocabulary: ${text}`);
    assert.ok(!text.includes('SQLITE_'), `driver internals leaked: ${text}`);
});

/**
 * Reporting a server-side fault as SQL_ERROR tells the agent its query was wrong, so it
 * rewrites, fails identically, and rewrites again — the same wasted-turn shape as advising
 * "aggregate with COUNT/SUM" to a query that already was one. The code has to name the right
 * side of the boundary, and the advice has to say retrying will not help.
 */
test('an unexpected internal failure is not blamed on the query', () => {
    const bug = new TypeError('cannot read properties of undefined (reading \'prepare\')');
    const text = toToolResult(bug).content[0].text;

    assert.ok(text.startsWith('INTERNAL_ERROR: '), `wrong code: ${text}`);
    // Concrete clauses, asserted separately — an alternation here would be rescued by
    // whichever member is most generic.
    assert.match(text, /fault in the server/, text);
    assert.match(text, /rewriting the query will not help/, text);
});

test('an unrecognized driver code maps to INTERNAL_ERROR, not to a query fault', () => {
    const driverError = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
    const text = toToolResult(driverError).content[0].text;

    assert.ok(text.startsWith('INTERNAL_ERROR: '), `wrong code: ${text}`);
    assert.ok(!text.startsWith('SQL_ERROR'), 'a server fault must not be reported as a bad query');
});

test('the documented codes are passed through unchanged', () => {
    for (const code of VOCABULARY) {
        const text = toToolResult(new AppError(code, 'something')).content[0].text;
        assert.ok(text.startsWith(`${code}: `), text);
    }
});

test('sentence punctuation after a path stays outside the placeholder', () => {
    assert.equal(sanitize('could not open /tmp/a/shop.db.'), 'could not open <database>.');
    // Prose after a path IS deliberately swallowed — a comma is not a terminator, because a
    // comma can occur inside a path. Only punctuation at the very end of the match, or text
    // past a real terminator, stays outside.
    assert.equal(sanitize('tried /tmp/a/shop.db, then gave up'), 'tried <database>');
    assert.equal(sanitize('error: "/tmp/a/shop.db".'), 'error: "<database>".');
});
