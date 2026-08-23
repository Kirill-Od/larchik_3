# MCP Server for shop.db — Plan

## 1. Goal

A Node.js MCP server that an AI agent connects to over stdio and uses to answer
analytical questions about an SQLite online-shop database, without ever being able to
modify it. When this is done, `node src/index.js` speaks MCP over stdin/stdout; a real
agent sees six tools with descriptions that teach it when and how to use each; it can
discover the schema unaided, write and run its own SQL, page through large results, and
recover from its own SQL mistakes because the errors tell it what to fix. Asking the
agent to "delete all cancelled orders" produces a refusal that explains the rule and
offers the read-only equivalent, and the database file is byte-identical afterwards.
The repo ships README, package.json, source, a runnable client-config example, a
Dockerfile, and shop.db, with a `node --test` suite covering the whole surface.

## 2. Constraints

From the specification:
- Transport is **stdio** only. The client spawns the process; no HTTP server, no ports.
- Must use an official MCP SDK and SQLite.
- Read-only. INSERT/UPDATE/DELETE/DROP/ALTER/CREATE and any other mutation must be refused.
- No absolute paths in code. DB path from configuration/environment or resolved
  relative to the project.
- Errors handled properly; no stack traces surfaced to the user.
- Deliverables: README (install → configure → run → connect), package.json, source,
  configuration example, shop.db in the repo.
- Grading is by connecting a **real agent**, not by reading source.

Decided before planning (not revisited here):
- Node.js, `@modelcontextprotocol/sdk`, `better-sqlite3`.
- Tests with the built-in `node:test` runner only.
- `git init` + local commits; no remote, no PR.
- `SHOP_DB_PATH` env var, falling back to project-relative resolution.

Discovered while planning:
- **stdout is the protocol.** A single stray `console.log` corrupts the JSON-RPC frame
  and the agent sees a dead server. All logging goes to stderr.
- **`process.cwd()` is unusable.** MCP clients spawn the server from an arbitrary
  working directory. Project-relative resolution must derive from `import.meta.url`.
- **better-sqlite3 is synchronous.** A slow query blocks the entire event loop — the
  server cannot even answer a ping while one runs. This bounds what "timeout" can mean.
- **better-sqlite3 requires a native build.** Prebuilds exist for common platforms;
  where they do not, `npm install` invokes node-gyp. `engines` and README must say so,
  and the Dockerfile is the escape hatch.
- The grader may attach a *different* `shop.db`. Nothing may hardcode this schema.

## 3. Findings

Each was verified directly against `shop.db` with the `sqlite3` CLI.

**Superseded in part by the data extension (after the project was green).** The owner
decided to close the two gaps these findings are built on rather than keep answering
"the schema cannot say": `scripts/seed-extended-data.mjs` adds `customers.country`, 85
non-Russian customers and 210 orders dated 2025. Every *number* in F1, F2, F5, F6 and F7
below is therefore the pre-extension measurement, kept as the record of what the provided
data contained; the current figures live in README → "Known data limitations" and "The
eight homework questions". The *mechanisms* the findings prescribe all survive — the
schema is still discoverable, `no such column` is still enriched (`city` is the live case
now), an empty date range still returns the available span, and `include_cancelled` still
changes the ranking.

### F1 — There is no country column anywhere. Homework tasks 2 and 3 are unanswerable.

**Superseded: `customers.country` now exists and both tasks are answerable (Germany 24;
Russia leads with 150 of 235).** The "do not seed one" instruction below was the right call
while the data was untouched and was overruled deliberately, not forgotten; what replaced it
is a generated dataset that is labelled as generated everywhere it appears.

Evidence — the full schema is:

```
customers(id, first_name, last_name, email, phone, created_at)
products(id, name, category, price, stock_quantity, created_at)
orders(id, customer_id, order_date, status, total_amount)
order_items(id, order_id, product_id, quantity, unit_price)
```

No `country`, `city`, `address`, or any geography column exists on any table. All 150
customers have Russian names and `+79…` phone numbers.

Response: **do not invent a country column and do not seed one.** The server's job is
to make the truth *discoverable* so the agent answers honestly instead of hallucinating
"Germany: 12". Three mechanisms carry this:
1. `describe_table` returns the real column list **plus 3 sample rows**, so the agent
   sees `+79…` phones and concludes there is no geography data.
2. `SELECT country FROM customers` returns an error that *lists the six real columns* —
   one failed call becomes a self-correcting one.
3. The server's `instructions` string tells the agent: if the schema cannot answer the
   question, say so and state what is missing, rather than guessing.
4. README documents the expected good answer for tasks 2 and 3, so a grader reading it
   sees the honest answer was designed for, not a bug.

### F2 — No orders exist in 2025. The answer to homework task 7 is zero.

**Superseded: 2025 revenue is 8 990 280.00 across 183 non-cancelled orders.** `order_date`
now spans 2025-09-01 to 2026-08-22. The empty-range mechanism still matters and is still
tested — 2024 is the year with no orders now.

Evidence: `MIN(order_date)=2026-02-17 18:53:30`, `MAX(order_date)=2026-08-22 17:06:30`.
Grouped by year, `orders` has exactly one bucket: 2026, 750 orders, 32 792 060.00 total.
2025 appears only in `customers.created_at` (2025-08-22 → 2026-02-17) and
`products.created_at` (2025-08-24 → 2025-11-19) — a trap the agent can fall into by
joining on the wrong date column.

Response: same principle. `describe_table('orders')` sample rows show 2026 dates;
`revenue_by_period` returns an explicit empty-range result with the actual available
date range attached (`"no orders in the requested range; data spans 2026-02-17 to
2026-08-22"`), which is the single most useful thing the server can hand the model.
README documents that 2025 revenue is 0 and why.

### F3 — The schema must not be hardcoded, so generic introspection is the backbone.

Because the grader may swap the DB, `list_tables` / `describe_table` / `run_sql_query`
read everything from `sqlite_master` and `PRAGMA table_info` at call time and work on
any SQLite file. The specialized analytics tools are a bonus layer that is
**registered only if a boot-time capability probe finds the columns they need**; on a
schema they do not fit, they simply do not appear in `listTools` and the agent falls
back to SQL. A specialized tool that crashes on someone else's database is strictly
worse than one that is absent.

### F4 — Opening the file read-only does not stop temp DDL, writable_schema, or cross-database reads.

**Corrected during the slice-3 review.** The original probe here ran under the `sqlite3`
CLI and reported that `ATTACH DATABASE '/tmp/evil_probe.db'` created a file on disk. That
does **not** reproduce through better-sqlite3, which is the path we actually execute:
SQLite opens an attached database with the parent connection's readonly flag, so a
nonexistent target is `SQLITE_CANTOPEN` and nothing is created. The corrected evidence,
measured against a `{readonly: true}` better-sqlite3 connection with the guard removed:

```
DELETE FROM orders WHERE status='cancelled';   -> refused by the engine: attempt to write a readonly database (8)
UPDATE products SET price=0;                   -> refused by the engine (8)
WITH x AS (SELECT 1) DELETE FROM orders ...;   -> refused by the engine (8)
PRAGMA writable_schema = ON;                   -> SUCCEEDED. stmt.readonly reports TRUE, so L1/L2 wave it through
CREATE TEMP TABLE t(x);                        -> SUCCEEDED, and the table is then visible in sqlite_temp_master
ATTACH DATABASE '<existing other.db>' AS sec;  -> SUCCEEDED, and SELECT * FROM sec.creds exfiltrated its rows
ATTACH DATABASE '<nonexistent>' AS e;          -> SQLITE_CANTOPEN, no file created (the original claim was wrong)
```

So the readonly flag protects *this database file* and, contrary to the original finding,
the filesystem too. What it does **not** stop is TEMP-schema DDL, `PRAGMA writable_schema`,
and — the one that matters most — **reading any other SQLite file on disk through ATTACH**.
The threat is exfiltration, not file creation.

**Corrected again by the task-12 capstone: "L3 is the only thing standing there" is too
strong for the *current* code path.** `runQuery` calls `statement.columns()` and
`statement.iterate()`, and better-sqlite3 throws on both for any statement returning no
rows — which is every ATTACH, every DDL, and every PRAGMA-set. So with L3 fully disabled
those attacks still fail, with `INTERNAL_ERROR: The columns() method is only for statements
that return data`. **That is an accident of the paging code, not a safety layer**, and it
would evaporate the day anyone adds a `.run()` path. It is the same class of mistake as the
original "no new files" claim, one level deeper: a barrier that looks like defence but is a
side effect. The capstone keeps the ATTACH and temp-table assertions as regression guards
for exactly that future change. L3 remains load-bearing; only the reason changed. Response: `ATTACH`, `DETACH`, all `PRAGMA`, and all DDL are blocked in the SQL
validator, and the safety suite must assert the *reachable* consequence — that an ATTACH of
an **existing** file is refused and a cross-database read never resolves. Asserting "no new
file appeared" tests something that cannot happen on this path and passes with the guard
entirely disabled.

### F5 — The dataset is internally consistent, so both revenue routes agree.

**Still true, on 960 orders rather than 750; the named spenders below have moved.** The
seeding script preserves the consistency by construction. Current top spender: Екатерина
Харитонов, 859 460.00 excluding cancelled.

`orders.total_amount` equals `SUM(order_items.quantity * unit_price)` for all 750 orders
(0 mismatches); every order has items; every `order_items.unit_price` equals the current
`products.price`. Consequence: the agent gets the same revenue whether it aggregates
`orders` or `order_items`, so there is no hidden trap in task 6. The one real ambiguity
is **whether cancelled orders count as revenue** (102 of 750 are `cancelled`), and it
changes the answer to task 4:

| Question | Including cancelled | Excluding cancelled |
|---|---|---|
| Top spender | Дмитрий Харитонов, 785 750.00 | Дмитрий Харитонов, 701 780.00 |
| 2nd | София Федоров, 713 000.00 | София Федоров, 636 790.00 |
| 3rd | Алексей Новиков, 648 980.00 | Дмитрий Андреев, 603 380.00 |

Response: the server does not pick for the agent. `describe_table('orders')` reports the
`status` CHECK constraint's five allowed values, and the analytics tools take an explicit
`include_cancelled` parameter defaulting to `false` whose description says what it changes.
The agent is then able to state its assumption, which is the correct behaviour.

### F6 — "Best-selling" is ambiguous and the two readings give different answers.

**Still true, with different products: revenue leader Ноутбук UltraBook 15 (98 units,
8 819 020.00), unit leader Планшет Tab 10 (123 units, 4 303 770.00).**

**Corrected in slice 6 — the original numbers were the include-cancelled basis, and the
named products were wrong.** Re-measured directly, and confirmed independently by the
coordinator. On the **default** basis (`include_cancelled = false`):

| ranking | leader | units | revenue |
|---|---|---|---|
| by revenue | **Ноутбук UltraBook 15** | 73 | 6 569 270.00 |
| by units | **Эспандер плечевой** | 93 | 110 670.00 |

*Планшет Tab 10* is **third** by revenue (83 units, 2 904 170.00); the plan's original
"94 units, 3 289 060.00" was its include-cancelled figure, and it does not lead on that
basis either. *Увлажнитель воздуха AirFresh* leads by units only when cancelled orders are
counted (109); under the default it is second with 92, behind Эспандер плечевой.

The finding's point survives and is in fact stronger than first stated: on the default
basis the revenue leader and the unit leader are entirely different products, and their
figures differ by a factor of sixty. Response:
`top_products_by_sales` returns **both** `units_sold` and `revenue` on every row and
takes a `rank_by` parameter — which is what homework task 5 asks for anyway.

### F7 — Ground truth for the remaining tasks (for README and for assertions).

**Superseded wholesale — these are the pre-extension figures.** Current ground truth for
all eight questions is the table in README → "The eight homework questions".

- Task 1: 4 tables — customers (150), products (50), orders (750), order_items (1900).
- Task 6, top-3 categories by revenue — **the figures below are the INCLUDING-cancelled
  basis, which the original finding failed to label** (corrected in slice 6): Электроника
  19 999 620.00, Бытовая техника 6 426 360.00, Одежда и обувь 3 446 960.00. On the default
  EXCLUDING basis: 17 060 760.00 / 5 506 570.00 / 3 085 470.00. The ordering is identical
  either way. (5 categories, 10 products each.) Total revenue 28 134 150.00 excl,
  32 792 060.00 incl.
- Task 8, most orders: София Яковлев (sofiya.yakovlev284@yandex.ru) — **16 orders
  including cancelled, 15 excluding**; she leads on either basis. Then Мария Иванов with
  12. Note the two bases differ here too, so the answer must state which one it used.

### F8 — The SDK has forked into v1 and v2; they are not source-compatible.

`@modelcontextprotocol/sdk@1.30.0` is npm `latest` and not deprecated. A v2 exists as
nine separate packages (`@modelcontextprotocol/server@2.0.0` et al., published
2026-07-28) whose `registerTool` takes `inputSchema: z.object({…})`.
**v1 takes a raw ZodRawShape** — `inputSchema: { weightKg: z.number() }`, no `z.object`
wrapper. *Corrected during task 1 against the installed package:* 1.30.0's signature is
`InputArgs extends undefined | ZodRawShapeCompat | AnySchema` and `normalizeObjectSchema`
wraps a bare shape, so it accepts **either** form — the claim that `z.object()` is rejected
was wrong. Raw shape remains what we use; only the impossibility claim was overstated.

Response: build on **v1** (`@modelcontextprotocol/sdk@^1.30.0`). Every agent harness in
circulation has been exercised against it, and criterion 1 of the grading is simply
"the server starts and the agent sees the tools". Task 1 exists partly to pin this down
empirically before any other code is written. Confirmed v1 shapes:

- `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'`
- `import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'`
- `new McpServer({name, version}, { instructions: '…' })` — `instructions` is a real
  `ServerOptions` field, returned in the initialize result.
- `registerTool(name, {title, description, inputSchema, outputSchema, annotations}, handler)`
- handler returns `{content: [{type:'text', text}], structuredContent?}`; failures return
  `{content: […], isError: true}`.
- Tests drive the server through `StdioClientTransport` from
  `@modelcontextprotocol/sdk/client/stdio.js`, which spawns it as a child process —
  the same path the grader uses.

## 4. Architecture

```
src/
  index.js       entry point. Redirects console.log→stderr, resolves config, opens the
                 DB, builds the server, connects StdioServerTransport. The ONLY module
                 that touches process, stdio, or exits.
  config.js      resolveDbPath(env, moduleUrl) -> string.  Pure, no I/O.
  db.js          openDatabase(path) -> handle
                 runQuery(handle, sql, {limit, offset, deadlineMs}) -> result envelope
  sql-guard.js   assertReadOnly(sql) -> void | throws ReadOnlyViolation.  Pure, no DB.
  introspect.js  listTables(handle), describeTable(handle, name)
  analytics.js   probeCapabilities(handle) -> {hasShopSchema}
                 topCustomersBySpend / topProductsBySales / revenueByPeriod
  errors.js      AppError subclasses + toToolResult(err) sanitizer
  tools.js       registerTools(server, ctx). Core tool descriptions live here.
                 AMENDED in slice 6: a module that owns a family of tools owns their
                 descriptions too (analytics.js holds its own three), because keeping a
                 description beside the SQL it documents is worth more than one file to
                 skim. The rule that survives unchanged is the one with a rationale:
                 tools.js contains NO SQL. Cost accepted: house-style consistency across
                 the six must be checked deliberately, since it is graded.
test/
  helpers.js     makeFixtureDb(), copyShopDb(), startServer() (MCP client over stdio)
  *.test.js
```

**Boundaries.** `sql-guard.js` never sees a database handle; `db.js` never sees an MCP
type; `tools.js` never contains SQL. Everything is testable without a subprocess except
the e2e tests, which deliberately use one.

**The only SQLite entry point is `db.prepare()`.** `db.exec()`, `db.function()`,
`db.aggregate()`, `db.loadExtension()`, and `db.table()` are banned **throughout `src/`** —
the boundary that touches the real read-only database. Test fixtures build throwaway
read-write databases where none of the rationale applies and may use `db.exec()`; the
grep that enforces this rule is therefore scoped to `src/`. The ban exists because
`exec()` is the one API that executes multiple statements, and the rest make
`stmt.readonly` unreliable by introducing custom SQL functions. The enforcement grep must be
anchored on `db\.` — a naive pattern false-positives on `RegExp.prototype.exec`, which
`introspect.js` uses legitimately.

### Public surface: the six tools

The homework grades tool *design*, and every description must answer four questions:
**when to reach for this, what to pass, what comes back, and what it will not do.**
The house style for all six: first line is a single imperative sentence naming the use
case; then WHEN TO USE / RETURNS / LIMITS blocks; parameter semantics on the Zod fields
themselves, not in prose. Every tool carries
`annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false}`.

**Core, schema-agnostic — always registered.**

1. **`list_tables`** — no parameters.
   *Description must convey:* call this first, before anything else, on any new
   question; returns every table and view with its row count and a one-line column
   summary; this is a cheap orientation call, not a data call — follow it with
   `describe_table` for the tables that look relevant.

2. **`describe_table`** — `table_name: string`.
   *Must convey:* returns columns with type/nullability/primary-key/default, foreign
   keys (so the agent can find the orders→order_items→products path without guessing),
   indexes, CHECK constraints (this is how `status` becomes discoverable), and **3
   sample rows**. Must say explicitly: *use this to confirm a column exists before
   writing SQL against it; if the column you expected is not listed, the data does not
   contain it.* This sentence is the direct countermeasure to F1 and F2.
   Unknown table → error listing the valid table names.

3. **`run_sql_query`** — `sql: string`, `limit?: 1..1000 = 100`, `offset?: >=0 = 0`.
   The workhorse. *Must convey:*
   - **When:** any question the specialized tools do not cover; joins, aggregates,
     filters, window functions — full SQLite SELECT is available.
   - **What to pass:** exactly one `SELECT` or `WITH…SELECT` statement. Do not append
     your own LIMIT; use the `limit`/`offset` parameters, which page without rewriting
     your SQL.
   - **Returns:** `{columns, rows, row_count, limit, offset, has_more, notes}`.
   - **Limits (stated, not implied):** hard cap of 1000 rows per call; the database is
     **read-only** and INSERT/UPDATE/DELETE/DROP/ALTER/CREATE/PRAGMA/ATTACH and
     multi-statement input are refused — *prefer an aggregate over paging through
     thousands of rows*; individual cell values over 4 KB are truncated.

**Specialized, registered only when `probeCapabilities` matches (bonus layer, F3).**

4. **`top_customers_by_spend`** — `limit?=10`, `include_cancelled?=false`.
   Returns name, email, total_spent, order_count. *Must convey:* answers "who spent the
   most" in one call instead of a three-table join; `include_cancelled` changes the
   answer (F5) and the description says so.
5. **`top_products_by_sales`** — `limit?=10`, `rank_by?: 'units'|'revenue' = 'revenue'`,
   `include_cancelled?=false`. Returns name, category, units_sold, revenue on every row
   regardless of `rank_by`. *Must convey:* "best-selling" is ambiguous, so both metrics
   are always returned — pick `rank_by` deliberately (F6).
6. **`revenue_by_period`** — `group_by: 'day'|'month'|'year'`, `start_date?`,
   `end_date?`, `include_cancelled?=false`. Returns per-bucket revenue, order count,
   items sold. *Must convey:* an empty result means there were no orders in that range,
   **not** an error — and the response carries the actual min/max order date so the next
   call can be right (F2).

**Server `instructions`** (sent once at initialize, schema-agnostic):
this database is strictly read-only; start with `list_tables`, then `describe_table` for
the tables you need; verify a column exists before querying it; if the schema cannot
answer the question, say plainly what is missing rather than guessing; results are
capped — prefer aggregates to paging.

### The read-only safety model, in layers

| # | Layer | Stops |
|---|---|---|
| L0 | `new Database(path, {readonly: true})` — SQLITE_OPEN_READONLY | Any write to shop.db, at the engine level, even if every layer above is bypassed |
| L1 | `db.prepare()` only, never `db.exec()` | Multi-statement input: `prepare` accepts exactly one statement |
| L2 | Refuse unless `stmt.readonly === true` (`sqlite3_stmt_readonly`) | Mutations, without any string matching. Held valid because no custom SQL functions are ever registered. **Not universal — corrected in slice 3:** `sqlite3_stmt_readonly` reports `true` for `load_extension()`, which loads an arbitrary shared library, so L2 does not catch it and L3 must |
| L3 | `assertReadOnly(sql)` — a real tokenizer, see below | ATTACH/PRAGMA/TEMP DDL, which L0–L2 do **not** stop (F4); and it produces the *explanatory* refusal |
| L4 | Row cap, cell cap, per-row deadline | Resource exhaustion |
| L5 | `annotations.readOnlyHint`, description text, server instructions | The agent proposing a destructive call in the first place |

**L3 is not a regex.** It first *lexes*: strips `--` line comments, `/* */` block
comments, `'…'` string literals (honouring `''` escapes), and `"…"` / `[…]` / `` `…` ``
quoted identifiers. Only then does it decide, on the surviving token stream:
- the first significant token must be `SELECT`, `WITH`, or `VALUES` — an allow-list, so
  anything unanticipated is refused by default rather than needing a denylist entry;
- no `;` may appear outside a literal except a single trailing one;
- no bare token anywhere may match the forbidden verb set — INSERT, UPDATE, DELETE,
  DROP, ALTER, CREATE, REPLACE, TRUNCATE, ATTACH, DETACH, PRAGMA, VACUUM, REINDEX,
  BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE.

Lexing first is what makes this correct in both directions. `WITH x AS (SELECT 1) DELETE
FROM orders` opens with `WITH` and would pass a naive prefix check, but `DELETE` survives
as a bare token and is caught. Conversely `SELECT * FROM products WHERE name = 'DROP
TABLE orders'` must be **allowed** — the literal is gone before verb matching — and
`WHERE name = 'a;b'` must be allowed, because a semicolon inside a literal is not a
statement separator. A regex gets both of those wrong.

### Errors that teach

Three shapes, each with a stable `code` the model can pattern-match:

- **`READ_ONLY_VIOLATION`** — names the construct found, restates the rule in one line,
  and offers the read-only equivalent. For `DELETE FROM orders WHERE status='cancelled'`
  the refusal ends with `SELECT * FROM orders WHERE status = 'cancelled'` so the turn is
  still productive. A refusal that only says "denied" wastes the agent's turn.
- **`SQL_ERROR`** — SQLite's own message passed through (they are genuinely good: *no
  such column: country*) **plus enrichment**: on "no such column" append the real column
  list for the tables named in the query; on "no such table" append the real table list.
  This is what converts F1 from a hallucination into an honest answer.
- **`INVALID_ARGUMENT`** — limit out of range, unknown `group_by`, bad date format;
  states the accepted values.

Sanitization is unconditional and applies to all three: no `err.stack`, no `at ` frames,
and any absolute filesystem path is replaced with `<database>` before the message
leaves the process. Full detail goes to stderr, where the operator can see it and the
agent cannot.

### Pagination

`run_sql_query` **never rewrites the agent's SQL.** Appending `LIMIT n OFFSET m` breaks
compound SELECTs, collides with a LIMIT the agent already wrote, and is a string-splicing
surface next to a security boundary. Instead it uses `stmt.iterate()`: skip `offset`
rows, collect `limit` rows, then pull one more row to determine `has_more` exactly. When
`has_more` is true, `notes` carries the literal next call — *"more rows available; call
again with offset=100, or use an aggregate"* — because telling the model the exact next
call is what makes pagination actually get used.

The same loop carries the deadline check (L4). Because better-sqlite3 is synchronous, a
timer cannot interrupt a running query; checking elapsed time between iterated rows is
the only cancellation point available without a worker thread. It bounds the realistic
worst case — a runaway cross join streams rows immediately — but not a query that
materializes before its first row (a huge ORDER BY). That residual is documented, not
solved.

## 5. Design decisions

- **Generic introspection + generic SQL is the backbone; specialized tools are a probed
  bonus layer.** → The grader may attach a different shop.db (F3), and the homework says
  design quality is what is graded, not tool count. *Rejected:* a tool per homework
  question — it scores the eight known questions and fails the ninth.
- **Build on SDK v1, not v2.** → v1 is npm `latest` and is what every shipped agent
  harness has been tested against; grading criterion 1 is "it starts and the tools are
  visible" (F8). *Rejected:* v2's nine packages — newer, but an untested integration
  surface for zero functional gain here.
- **Allow-list the first token; denylist verbs only as a second check.** → Unknown
  constructs are refused by default. *Rejected:* denylist alone — it fails open on
  anything not enumerated.
- **Lex before matching.** → Correctness in both directions: comments and literals
  cannot smuggle a verb in, and a literal containing "DROP TABLE" is not a false
  positive. *Rejected:* regex on the raw string — provably wrong on both.
- **Block all PRAGMA, including read-only ones like `table_info`.** → `describe_table`
  already covers the legitimate need, and a partial PRAGMA allow-list invites parser
  games at the security boundary for no capability gain. *Rejected:* allow read-only
  pragmas.
- **Paginate by iterating, never by rewriting SQL.** → No collision with the agent's own
  LIMIT, no string splicing next to the guard, and exact `has_more`. *Rejected:*
  wrapping in `SELECT * FROM (…) LIMIT ? OFFSET ?` — breaks on compound SELECTs.
- **Rows as an array of objects, not columns+row-arrays.** → Models read
  `{"name":…,"revenue":…}` more reliably than positional arrays, and the 1000-row cap
  bounds the token cost anyway. *Rejected:* the compact form — cheaper, but reliability
  with a real agent is the actual grading criterion.
- **No `outputSchema` on `run_sql_query`; `outputSchema` on the three analytics tools.**
  → Query result shape is arbitrary by definition; the analytics shapes are fixed and
  benefit from validated `structuredContent`.
- **Missing DB: start successfully, fail per-call with an actionable message.** → An
  agent that can report "SHOP_DB_PATH points at nothing" is more useful than a process
  that dies before the handshake and shows the grader only "server failed to start".
  *Rejected:* `process.exit(1)` at boot. **Open — see §8.**
- **`console.log = console.error` as the first statement in `index.js`.** → One line that
  permanently forecloses the single most common way an MCP stdio server breaks.
- **Analytics tools default `include_cancelled: false`, and say so.** → F5 shows it
  changes the answer; the parameter makes the agent state its assumption rather than
  inherit ours silently.

## 6. Test strategy

Runner: `node --test` (`node:test` + `node:assert/strict`), `npm test`.

**Boundaries under test.** Unit tests call the exported module functions —
`assertReadOnly(sql)`, `runQuery(handle, …)`, `listTables(handle)` — passing a handle in
rather than reaching into module state, so the internals can be rewritten freely.
End-to-end tests drive the built server through the SDK's own `StdioClientTransport`,
spawning `src/index.js` as a child process: **the same path the grader uses.** A bug
that only appears across the process boundary is exactly the bug that loses marks.

**Fixtures.** `makeFixtureDb()` builds a small temp database per test so behaviour tests
do not depend on shop.db's contents. A separate small set of tests runs against the real
shop.db and asserts the F5/F6/F7 ground-truth numbers — that is what proves the eight
homework questions are answerable. Destructive tests **always run against a temp copy**,
never the committed file.

Note on `StdioClientTransport`: passing `env` replaces the child environment wholesale,
so the helper must merge `getDefaultEnvironment()` with `SHOP_DB_PATH` or the child
loses `PATH`.

**The adversarial list.** These are the tests that matter most; each asserts a refusal
*and* the refusal's shape.

Refused — plain mutations:
1. `DELETE FROM orders WHERE status='cancelled'` (the literal homework case)
2. `INSERT INTO customers (first_name) VALUES ('x')`
3. `UPDATE products SET price = 0`
4. `DROP TABLE orders`
5. `ALTER TABLE orders ADD COLUMN x TEXT`
6. `CREATE TABLE t (x)` and `CREATE TEMP TABLE t (x)` — the TEMP form succeeds on a
   readonly connection (F4), so L3 is the only thing stopping it

Refused — bypass attempts:
7. `SELECT 1; DELETE FROM orders` — two statements
8. `SELECT 1; ; DELETE FROM orders` — empty statement between
9. `-- harmless\nDELETE FROM orders` — comment before the verb
10. `/* SELECT */ DELETE FROM orders` — a fake SELECT inside a comment must not satisfy
    the opener check
11. `SELECT 1 -- ;\nDELETE FROM orders` — comment hiding the separator
12. `WITH x AS (SELECT 1) DELETE FROM orders WHERE id IN (SELECT * FROM x)` — CTE
    wrapping a write; opens with `WITH` and passes any prefix check
13. `PRAGMA writable_schema = ON`
14. `PRAGMA table_info(orders)` — blocked deliberately, refusal points at `describe_table`
15. `ATTACH DATABASE '<tmp>/other.db' AS sec` where **other.db exists and holds a row** —
    the test asserts the refusal AND that `SELECT * FROM sec.creds` never resolves. Do NOT
    assert "no file was created": corrected F4 shows that is impossible on this path and
    the assertion passes with the guard disabled
16. `DETACH DATABASE e`
17. `VACUUM`, `REINDEX`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT s`
18. `UPDATE sqlite_master SET sql = '…'`
19. `EXPLAIN DELETE FROM orders` — `EXPLAIN` is not an allowed opener
20. `dElEtE   from\torders` — case and whitespace insensitivity
21. `Delete all cancelled orders.` — natural language in the `sql` field; the refusal
    must tell the model to write SQL, since a real agent will try this

Discovered during slice 3 and added to the required set — the plan's original 26 missed
these, and the first is the most dangerous case found anywhere in the project:

27. `/* /* */ DELETE FROM orders */` — **block comments do not nest in SQLite** (verified
    against 3.53.4: the engine reads this as `DELETE FROM orders */`). A lexer that nested
    them would see one comment and pass the DELETE straight through.
28. Unterminated `/*`, `'`, `"`, `[` — SQLite accepts an unterminated `/*` as a comment to
    EOF but rejects an unterminated quote. The guard fails closed on all four.
29. `SELECT 1 \0; DROP TABLE x` — a null byte. SQLite prepares this as `SELECT 1 `,
    truncating at the NUL with `readonly=true`. Guard and engine must never disagree about
    where a statement ends, so NUL is refused outright.
30. `load_extension('evil.so')` — loads an arbitrary shared library and
    `sqlite3_stmt_readonly` reports **true**, so L2 misses it entirely. On the verb list.
31. `ANALYZE` — writes `sqlite_stat1` and appears in no conventional denylist. The concrete
    demonstration that the opener allow-list, not the denylist, is what carries the safety.
32. `SELECT 1;;` — accepted by better-sqlite3's `prepare` with `readonly=true`; refused here.
33. A leading BOM (SQLite accepts it, so refusing would reject a query the engine runs)
    versus NBSP (a SQLite syntax error). JS `\s` is a strict superset of SQLite's five
    whitespace bytes, so the guard always sees at least what SQLite sees.
34. Blob literals `X'…'` must not desynchronize quote pairing for the literal that follows.
36. `SELECT * FROM pragma_table_info('orders')` and `SELECT * FROM pragma_optimize` —
    SQLite's `pragma_*` **table-valued functions** reach pragma behaviour through an
    ordinary identifier behind an allowed opener, so the opener allow-list does not see
    them. Found in the slice-3 review, which probed all 66 pragmas in three forms: every
    one was allowed. No breach was demonstrated (zero mutations across 198 statements),
    but `pragma_optimize` reaches the engine and attempts a write, stopped only by L0, and
    `pragma_table_info` returns exactly what case 14 refuses. Match a `PRAGMA_` prefix in
    the verb scan.
35. Input length cap (100 000 chars), bounding worst-case guard cost on a synchronous
    server. A 4 000-element `IN` list still passes.

**Two keyword collisions the original verb list would have broken.** `END` closes a `CASE`
expression, which analytical SQL is built on, so the scan pairs it against `CASE` depth: an
`END` closing an open `CASE` is expression syntax, an unpaired one is the transaction verb.
`REPLACE` is both `REPLACE INTO` and one of SQLite's most common scalar functions, so
`REPLACE` followed by `(` is the function and anything else is the statement. Dropping
either from the verb set would be a real weakening; keeping either unconditionally would
refuse ordinary queries.

Beyond the original 36, added by the task-12 capstone:

37. **`DELETE FROM orders WHERE id = 1 RETURNING *`** (and the `INSERT … RETURNING` /
    `UPDATE … RETURNING` forms). This is **the one write shape that returns rows**, so it
    is the only one that survives the accidental `columns()` barrier described in F4 —
    the shortest path from a disabled guard to a modified database file. Verified: with L3
    and L2 removed, the capstone's SHA-256 assertion goes red on this statement and no
    other. Its absence from the original list was the most consequential gap in it.
38. `SELECT randomblob(200000000)` — passes the guard legitimately (it is a read) and makes
    the server allocate ~200 MB before L4 truncates the *output* to a marker. Bounded near
    1 GB per value by SQLITE_MAX_LENGTH. **L4 caps what leaves the process, not what is
    allocated inside it.** Documented as a residual in §7 rather than fixed: bounding it
    means predicting which scalar functions allocate, which is whack-a-mole at a boundary
    where a wrong guess refuses legitimate SQL.

Allowed — the false-positive guards, which are what distinguish a lexer from a regex:
22. `SELECT * FROM products WHERE name = 'DROP TABLE orders'`
23. `SELECT * FROM products WHERE name = 'a;b'`
24. `SELECT 1;` — one trailing semicolon
25. `WITH x AS (SELECT 1 AS n) SELECT n FROM x`
26. `SELECT "delete" FROM (SELECT 1 AS "delete")` — a quoted identifier is not a verb

Capstone (task 12): copy shop.db to a temp dir, point `SHOP_DB_PATH` at the copy, drive
**all** of 1–21 through a live MCP client, then assert every call returned `isError` and the
copy's SHA-256 and size are unchanged. Per corrected F4, "no new files appeared" is a
**vacuous** assertion on this path — keep it only as a cheap extra, and add the two that are
not vacuous: an ATTACH of an existing sibling database is refused, and `sqlite_temp_master`
is empty afterwards (proving no `CREATE TEMP TABLE` landed).
This is the single test that proves requirement §4 of the homework end to end.

**Other required coverage.** Pagination boundaries (0 rows / 1 row / exactly `limit` /
`limit`+1 / `offset` past the end); `limit: 0` and `limit: 5000` rejected;
BLOB / BigInt / NULL / float serialization; oversized cell truncation; the runaway-query
deadline; error-message sanitization (no `/`-rooted path, no `at ` frame — asserted on
every error the suite produces, not just one); `listTools` shape (every tool has
`readOnlyHint`, a description mentioning its limits); analytics tools absent when the
probe fails; missing-DB startup.

**Not tested:** better-sqlite3's own SQL semantics, the SDK's framing, `package.json`
constants.

## 7. Out of scope

- Write access of any kind, including a "confirm first" mutation path.
- MCP Resources and Prompts. Tools alone cover every grading criterion, and resource
  support is uneven across agent harnesses.
- HTTP / SSE transport. stdio only, per the spec.
- Auth, multi-tenancy, connection pooling, query result caching.
- Generating shop.db from SQL — the binary is committed, which the spec permits.
- Bounding in-process memory allocation. `SELECT randomblob(2e8)` allocates ~200 MB before
  the output cap applies (§6 case 38); SQLITE_MAX_LENGTH bounds it near 1 GB per value.
  Predicting which scalar functions allocate is whack-a-mole at a security boundary.
- True query cancellation via a worker thread. The per-row deadline is the documented
  approximation; the residual (a query that materializes before its first row) is stated
  in the README rather than solved.
- Publishing to npm; opening a pull request.

## 8. Open decisions for the user

1. **Missing-database behaviour** — start and return an actionable per-call error
   (planned), or `process.exit(1)` at boot. Affects grading criterion 1 either way.
2. **README candour** — the plan documents F1/F2 openly under "Known data limitations",
   including that 2025 revenue is 0 and that tasks 2–3 are unanswerable. This is the
   right engineering call and it signals the honest answers were designed for. Confirm
   that is the tone you want in a graded submission.
3. **SDK v1 vs v2** (F8) — plan says v1; say so if you would rather ship on v2.
