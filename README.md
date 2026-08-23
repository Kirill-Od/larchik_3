# shop-db MCP server

A read-only [Model Context Protocol](https://modelcontextprotocol.io) server that lets an
AI agent explore and analyse an SQLite online-shop database (`shop.db`) over **stdio**.

The agent gets six tools: three schema-agnostic ones that work on any SQLite file
(`list_tables`, `describe_table`, `run_sql_query`) and three specialised analytics tools
that appear only when the database has the shop schema. Nothing the agent can send will
change the database — the guarantee is enforced in five independent layers, each of
which catches something the others cannot.

**Contents:** [1. Install](#1-install) · [2. Configure](#2-configure) · [3. Run](#3-run) ·
[4. Connect to an agent](#4-connect-to-an-agent) · [The six tools](#the-six-tools) ·
[Read-only guarantee](#read-only-guarantee) · [Tests](#tests) · [Docker](#docker) ·
[Known data limitations](#known-data-limitations) ·
[The eight homework questions](#the-eight-homework-questions) ·
[Known technical limitations](#known-technical-limitations)

---

## Requirements

| | |
|---|---|
| Node.js | **>= 20** (`engines` in `package.json`). Developed and tested on **v22.22.0**. |
| Platform | Any that Node runs on. See the note on the native build below. |
| Database | `shop.db`, committed to this repository. Nothing else to download. |

### About the native build

The server uses [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), which is a
**native addon**. `npm install` downloads a prebuilt binary for common platform / Node
combinations. Where no prebuild matches, npm falls back to compiling it with `node-gyp`,
which needs a C++ toolchain on the machine:

- **macOS** — `xcode-select --install`
- **Debian / Ubuntu** — `sudo apt-get install -y python3 make g++`
- **Windows** — the "Desktop development with C++" workload from Visual Studio Build Tools

If you would rather not deal with that at all, use the [Docker](#docker) image: the build
stage carries the toolchain so your machine does not have to.

---

## 1. Install

```bash
git clone <this-repo> shop-db-mcp
cd shop-db-mcp
npm ci          # or: npm install
```

Verify the install before going any further:

```bash
npm test
```

A green suite means the server starts, the tools are visible, and the read-only guarantee
holds on your machine.

---

## 2. Configure

There is exactly one setting.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SHOP_DB_PATH` | no | `shop.db` in the project root | Filesystem path to the SQLite database to serve. |

If you are happy serving the `shop.db` that ships with the repository, **you can skip this
section entirely** — the default already points at it.

### A relative path resolves against the project root, not your working directory

This is the one thing about this server that is not what most operators assume, so it is
worth stating plainly:

> If `SHOP_DB_PATH` is **relative**, it is resolved against **the project root** — the
> directory containing `package.json` — and **never** against the current working
> directory of whatever spawned the server.

The reason is that an MCP client spawns the server as a child process from an arbitrary
directory: your editor's workspace root, your home directory, `/`, or a temp directory,
depending on the client. A path resolved against `process.cwd()` would therefore mean a
different file for every client, and the same config would work in one agent and fail in
the next. Resolving against the project root — derived from `import.meta.url`, so it is
correct however the server was launched — makes the config portable. It also satisfies the
requirement that no absolute path be baked into the source.

So:

```bash
SHOP_DB_PATH=shop.db                     # -> <project root>/shop.db
SHOP_DB_PATH=data/other.db               # -> <project root>/data/other.db
SHOP_DB_PATH=/srv/data/shop.db           # -> exactly that, absolute paths are used as-is
SHOP_DB_PATH=/shop.db                    # -> exactly that (ordinary inside a container)
```

**Recommendation: put an absolute path in your client config.** It is unambiguous, it does
not depend on knowing this convention, and it keeps working if you ever move the server
code. The relative form is a convenience for the bundled database, not the general case.

### If the database cannot be opened

The server still starts and still completes the MCP handshake, and every tool call then
returns an error naming `SHOP_DB_PATH`. This is deliberate: an agent that can tell you
"`SHOP_DB_PATH` points at a file that does not exist" is far more useful than a process
that dies before the handshake and leaves the client showing only "server failed to start".
The underlying reason is also written once to stderr for the operator. The three
specialised analytics tools are absent in that state, since the probe that registers them
cannot read the schema — seeing only three tools in your client is itself the symptom.

---

## 3. Run

```bash
npm start
# or, equivalently
node src/index.js
```

**You will normally never run this by hand** — the MCP client spawns it for you. Running it
directly is a smoke test.

### What correct output looks like

```
shop-db MCP server ready on stdio (database: /path/to/shop-db-mcp/shop.db)
```

That line is on **stderr**. The process then sits there waiting, apparently doing nothing.
That is success — it is blocked reading JSON-RPC requests from stdin. Press `Ctrl+D` (or
`Ctrl+C`) to stop it.

**Nothing but JSON-RPC ever goes to stdout.** stdout *is* the protocol channel: a single
stray `console.log` corrupts a frame and the client sees a dead server. The first statement
in `src/index.js` reroutes `console.log`, `info`, `debug`, `dir` and `table` to stderr so
that this cannot happen by accident. All diagnostics — the ready line, error detail —
go to stderr, where your client will show them in its MCP log.

You can check the handshake by hand:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' | node src/index.js
```

A single JSON-RPC response on stdout, the ready line on stderr, and nothing else.

---

## 4. Connect to an agent

### Claude Code

`.mcp.json` in the project root is already configured. Start Claude Code **from the project
root** and approve the server when prompted:

```bash
cd shop-db-mcp
claude
```

```json
{
  "mcpServers": {
    "shop-db": {
      "command": "node",
      "args": ["${PWD}/src/index.js"],
      "env": {
        "SHOP_DB_PATH": "${PWD}/shop.db"
      }
    }
  }
}
```

`${PWD}` is expanded by Claude Code, so this file is machine-independent. Check it worked
with `/mcp` — you should see `shop-db` connected with six tools. If your client does not
expand `${PWD}`, or you start Claude Code from a subdirectory, replace both occurrences
with the absolute path to your clone.

### Any other MCP client (the generic form)

`mcp.config.example.json` is the portable version:

```json
{
  "mcpServers": {
    "shop-db": {
      "command": "node",
      "args": ["<PROJECT_ROOT>/src/index.js"],
      "env": {
        "SHOP_DB_PATH": "<PROJECT_ROOT>/shop.db"
      }
    }
  }
}
```

Copy that block into your client's MCP configuration and **replace `<PROJECT_ROOT>` with
the absolute path to your clone** (both occurrences). For example
`/home/you/shop-db-mcp/src/index.js`.

This exact file is executed by `test/config-example.test.js`, which substitutes the
placeholder, spawns precisely the `command`, `args` and `env` it declares from an unrelated
working directory, and completes a `listTools` handshake plus a real tool call. The
documented configuration therefore cannot silently rot.

Client-specific notes:

- **Claude Desktop** — same JSON, in
  `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or
  `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Restart the app afterwards.
- **Cursor / Windsurf / Cline / Continue** — same `mcpServers` shape, in each tool's own
  MCP settings file.
- **`command`** — if `node` is not on your client's `PATH` (GUI apps often have a minimal
  one), replace it with the absolute path from `which node`.

### Checking it worked

Ask the agent:

> Show me all available tables and explain what information each table contains.

It should call `list_tables`, then `describe_table` for each of the four tables, and come
back with customers (235 rows), products (50), orders (960), order_items (2429). Part of
that is generated — see [Known data limitations](#known-data-limitations) for exactly which
part and why.

### Verified end to end with a live agent

Beyond the automated suite, the server was driven by a real agent (headless Claude Code
connecting through `.mcp.json`) rather than only by test harnesses. Three results worth
reproducing, because each demonstrates something a passing test cannot.

**This run predates `scripts/seed-extended-data.mjs`**, so it was made against the original
150-customer, 750-order dataset. The refusal is unaffected by the seeding and reproduces
identically today; the two figures the agent quoted are pre-seed figures and are marked
where they have since moved.

**It refuses the destructive request from the assignment.** Asked to delete cancelled
orders, the agent reported back verbatim:

```
READ_ONLY_VIOLATION: read-only guard: DELETE is not permitted on a read-only
connection. Read the same rows instead: SELECT * FROM orders WHERE status = 'cancelled'
```

`shop.db` hashed identically before and after.

**It answered the 2025 question honestly instead of inventing a figure.** Asked cold about
2025 revenue, with no hint that the data might not contain it:

> There is no 2025 data. Every order falls in 2026 — 2026-02-17 to 2026-08-22. Revenue for
> 2025 is therefore zero, not an unknown.

That distinction — zero rather than unknown — is the behaviour this design exists to
produce, and it is the reason the seeding that followed was done in the open: the same
question now returns **8 990 280.00**, and this README says where those orders came from
rather than letting them pass as part of the provided dataset.

**It found a tie in the data on its own.** Asked who placed the most orders, it returned
София Яковлев with 15 and volunteered that Виктория Макаров and Мария Иванов are tied at
11 behind her — a detail nobody had put in front of it. She still leads after the seeding,
now with 16 orders excluding cancelled.

### In a container

The image was built and driven the same way, with the documented command:

```bash
docker build -t shop-db-mcp .
docker run -i --rm shop-db-mcp
```

All six tools appear, `SELECT COUNT(*) FROM orders WHERE status <> 'cancelled'` returned
648 — 750 − 102 in the pre-seed database; against the database as committed today the same
query returns **831** — and the `DELETE` above is refused identically. The `-t` warning below is not folklore:
run with `-it` and the TTY echoes your own request back down the stream, so the client
parses its own `initialize` as if it were the server's reply.

---

## The six tools

The first three work on **any** SQLite database. The last three are specialised to the shop
schema and are registered only if a boot-time probe finds the columns they need — on a
different database they simply do not appear, and the agent falls back to SQL.

### `list_tables`

**Start here on any new question.** No parameters. Returns every table and view with its row
count and a one-line `name TYPE, name TYPE, …` column summary — enough to decide what is
worth looking at, cheap enough to call reflexively. SQLite's internal tables are omitted;
views are never counted (so their `row_count` is `null`), which keeps the call cheap no
matter how a view is defined.

### `describe_table`

**Use this before writing any SQL.** Takes `table_name`. Returns the real columns with type,
nullability, primary key and default; the foreign keys, which is how the agent finds the
`orders → order_items → products` join path without guessing; the indexes; the CHECK
constraints, which is where `orders.status`'s five allowed values are written down; and
**three real sample rows**, usually the fastest way to see what the data actually looks
like. Naming a table that does not exist returns an error listing the ones that do. The
description tells the agent explicitly: if the column you expected is not listed, the data
does not contain it — say so rather than substituting something else.

### `run_sql_query`

**The workhorse, for anything the specialised tools do not cover.** Takes `sql` plus
optional `limit` (1–1000, default 100) and `offset` (default 0). Full SQLite `SELECT`
syntax — joins, aggregates, window functions, CTEs. Returns
`{columns, rows, row_count, limit, offset, has_more, notes}`, with `rows` as an array of
objects keyed by column name. Paging is done by iterating the result, never by rewriting
the caller's SQL, so a `LIMIT` the agent wrote itself is left alone; when `has_more` is
true, `notes` spells out the exact next call. Exactly one statement per call, and it must
be a `SELECT`, `WITH … SELECT` or `VALUES`; everything else is refused.

### `top_customers_by_spend`

Ranks customers by money spent, in one call instead of a three-table join. Optional `limit`
(1–100, default 10) and `include_cancelled` (default **false**). Returns
`{name, email, total_spent, order_count}` per customer, highest first, plus a note saying
which cancelled-order basis produced the figures. Ranks by **money**, not by order count —
"who placed the most orders" is a different question and needs `run_sql_query`.

### `top_products_by_sales`

Ranks products by sales. Optional `limit`, `rank_by` (`"revenue"` — the default — or
`"units"`) and `include_cancelled`. **Both `units_sold` and `revenue` come back on every
row regardless of `rank_by`**, which only chooses the ordering. That is deliberate: in this
database the unit leader and the revenue leader are entirely different products (see
[below](#3-best-selling-is-ambiguous-and-the-two-readings-name-different-products)), so
returning only the ranked metric would let an agent answer "best-selling" without ever
noticing the question is ambiguous.

### `revenue_by_period`

Revenue bucketed by `group_by` (`"day"`, `"month"` or `"year"`), with optional `start_date`
/ `end_date` (`YYYY-MM-DD`, inclusive) and `include_cancelled`. Buckets are cut on
`orders.order_date` — the only column that records when a sale happened. Returns
`{group_by, buckets, include_cancelled, available_range, note}`. **An empty `buckets` list
is an answer, not an error**: it means revenue for that range is zero, and
`available_range` carries the earliest and latest order date actually present, formatted so
it can be passed straight back in. That is what lets an agent answer "zero, and here is the
period the data does cover" in a single turn instead of retrying.

---

## Read-only guarantee

The homework's test case is:

> Delete all cancelled orders.

The agent has no tool that could do that. If it tries anyway — by sending
`DELETE FROM orders WHERE status = 'cancelled'` to `run_sql_query` — the call comes back
as an error with the code `READ_ONLY_VIOLATION`, naming the construct it refused, restating
the rule, and handing back the read-only equivalent so the turn is not wasted:

```
READ_ONLY_VIOLATION: read-only guard: DELETE is not permitted on a read-only connection.
Read the same rows instead: SELECT * FROM orders WHERE status = 'cancelled'
```

The database file is untouched, byte for byte. The same happens for
`INSERT`, `UPDATE`, `DROP`, `ALTER`, `CREATE`, `REPLACE`, `TRUNCATE`, `ATTACH`, `DETACH`,
`PRAGMA`, `VACUUM`, `REINDEX`, `load_extension`, `ANALYZE`, the transaction verbs, and
multi-statement input.

Five independent enforcement layers, so that no single mistake is load-bearing, plus a
sixth that keeps the agent from proposing the call at all:

| | Layer | Stops |
|---|---|---|
| **L0** | The file is opened with `SQLITE_OPEN_READONLY` | Any write to `shop.db`, at the engine level, even if everything above were bypassed |
| **L1** | Only `db.prepare()` is ever used, never `db.exec()` | Multi-statement input — `prepare` accepts exactly one statement |
| **L2** | The statement is refused unless SQLite's own `stmt.readonly` is true | Mutations, with no string matching involved |
| **L3** | `assertReadOnly(sql)` — a real lexer, not a regex | `ATTACH` (which could read *other* databases on disk), `PRAGMA`, TEMP-schema DDL and `load_extension`, none of which L0–L2 catch; and it produces the explanatory refusal |
| **L4** | Row cap, response-size cap, per-cell cap, query deadline | Resource exhaustion |
| **L5** | `readOnlyHint` annotations, tool descriptions, server instructions | The agent proposing a destructive call in the first place |

**L3 lexes before it matches**, which is what separates it from a denylist regex. It strips
`--` and `/* */` comments, `'…'` string literals with their `''` escapes, and `"…"`, `[…]`
and `` `…` `` quoted identifiers, and only then inspects the surviving tokens. This is
correct in both directions:

- `WITH x AS (SELECT 1) DELETE FROM orders …` opens with `WITH` and would sail past any
  prefix check — `DELETE` survives lexing as a bare token and is refused.
- `SELECT * FROM products WHERE name = 'DROP TABLE orders'` is **allowed**, because the
  literal is gone before verbs are matched. So is `WHERE name = 'a;b'`, because a semicolon
  inside a literal is not a statement separator.

The opening token is an **allow-list** (`SELECT`, `WITH`, `VALUES`), so anything unforeseen
is refused by default rather than needing a denylist entry — which is what catches oddities
like `ANALYZE`, a statement that writes `sqlite_stat1` and appears on almost no denylist.

The adversarial set — every statement above, plus the bypass attempts that make a lexer
worth writing (nested block comments, which SQLite does *not* nest; unterminated literals;
a null byte; `EXPLAIN DELETE`; `SELECT 1; ; DELETE`; `pragma_table_info()` reached as a
table-valued function behind an allowed opener) — is covered by `test/sql-guard.test.js`,
and the refusals are asserted end-to-end through a live MCP client in
`test/errors.e2e.test.js`.

**`test/safety.e2e.test.js` is the capstone**, and it is the strongest evidence in the repo
for the read-only requirement. It copies `shop.db` to a temp directory, drives **45 attack
statements** through a live MCP client — plus two identifier-injection attempts aimed at
`describe_table`, which reaches `PRAGMA table_info` without going through the SQL guard at
all — and then asserts that:

- every one was refused, **and refused by the guard** rather than by some deeper layer, so
  the agent actually got an explanation it can act on;
- the copy's **SHA-256 and byte size are unchanged**;
- an `ATTACH` of an *existing* sibling database is refused and its rows never resolve — the
  real threat here is reading some *other* SQLite file on disk, not creating one;
- `sqlite_temp_master` is empty afterwards, proving no `CREATE TEMP TABLE` landed.

It also drives nine queries that must still be **allowed**, because a server that refuses
everything passes a refusal-only suite and still fails the homework.

### Errors that teach

Failures come back as tool errors carrying one of six stable machine-readable codes the
model can pattern-match, plus a message written to be actionable rather than merely
correct:

| Code | When | What the message adds |
|---|---|---|
| `READ_ONLY_VIOLATION` | The guard refused the statement | Names the construct found and restates the rule |
| `SQL_ERROR` | SQLite rejected the query | SQLite's own diagnostic (`no such column: city`), enriched with the columns or tables that *do* exist |
| `INVALID_ARGUMENT` | A parameter is out of range or malformed | States the accepted values |
| `QUERY_TIMEOUT` | The query ran past the deadline | Explains how to narrow it |
| `CONFIGURATION_ERROR` | The database could not be opened | Names `SHOP_DB_PATH` |
| `INTERNAL_ERROR` | A fault on the server's side, not in the request | Says so explicitly: *"rewriting the query will not help — report what you were trying to do rather than retrying"* |

Those six are the whole contract. Anything unrecognised — a raw driver code such as
`SQLITE_NOTADB`, or a genuine bug in this server — becomes `INTERNAL_ERROR` rather than
being folded into `SQL_ERROR`. That distinction is worth the extra code: labelling a
server-side fault as a SQL error tells the agent its *query* was wrong, so it rewrites,
fails identically, and rewrites again until its turns are gone. A code the agent has not
seen before is far cheaper than one that points it at the wrong side of the boundary.

No stack traces and no filesystem paths ever leave the process. All six tools funnel their
failures through one function, so sanitising cannot depend on which tool failed: `at …`
stack frames are stripped, and anything filesystem-shaped becomes `<database>`.

The path rule is deliberately **not** an allow-list of the characters a path component may
contain. That shape of rule leaks on every character nobody thought to enumerate — a
second space, an apostrophe, a bracket, Cyrillic, CJK. Instead it matches from a path
anchor to a terminator that cannot occur mid-path, so a component may contain anything at
all:

```
/home/user/Документы/моя папка/shop.db   ->  <database>
/a b c d/e f/shop.db                       ->  <database>
C:\Users\Kirio\My Documents\shop.db        ->  <database>
no such column: city                       ->  unchanged
near "/": syntax error                     ->  unchanged
2026/08/23 and a/b                         ->  unchanged
```

**The trade-off, which you will notice:** the match is greedy to the end of the line, so
prose *after* a path is absorbed with it — `tried /tmp/a/shop.db, then gave up` comes back
as `tried <database>`. That is the deliberate direction to fail in. Losing a few words of a
diagnostic is recoverable; leaking a directory name out of the process is not.

Operator-facing detail, such as the reason the database could not be opened, also goes to
stderr, where your client shows it in its MCP log and the agent never sees it.

---

## Tests

```bash
npm test
```

`node --test test/*.test.js`, no test framework dependency. The suite covers the SQL guard
(including comment nesting, unterminated literals, null bytes, `pragma_*` table-valued
functions and every bypass we could think of), pagination boundaries, value serialisation,
error shape and sanitisation, the analytics results against known ground truth, and a set
of end-to-end tests that spawn `src/index.js` as a child process and drive it through the
SDK's own stdio client — **the same path a real agent takes**.

---

## Docker

Useful when you do not want a C++ toolchain on your machine: the build stage compiles
`better-sqlite3` and the runtime image ships without a compiler.

```bash
docker build -t shop-db-mcp .
docker run -i --rm shop-db-mcp
```

### Never pass `-t`

Run with **`-i`** and **never `-t`**. A TTY turns on line editing, echo and newline
translation, all of which corrupt the JSON-RPC framing on stdin/stdout — the client will
see a server that connects and then talks nonsense. `-i` alone is what you want: the
container's stdin/stdout *are* the protocol channel.

`--rm` matters too, because the client starts a fresh container for every session.

### Client config for the container

```json
{
  "mcpServers": {
    "shop-db": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "shop-db-mcp"]
    }
  }
}
```

The image bakes `shop.db` in at `/shop.db` and sets `SHOP_DB_PATH=/shop.db`. An absolute
path at the filesystem root looks unusual on a laptop but is entirely ordinary inside a
container, where the whole filesystem belongs to this one process. To serve a different
database, mount it over that path read-only:

```bash
docker run -i --rm -v /host/path/shop.db:/shop.db:ro shop-db-mcp
```

---

## Known data limitations

Read this before trusting any figure below. **Part of this database is generated**, and the
two paragraphs after the next heading say exactly which part — nothing here is presented as
having come with the assignment when it did not.

### 0. Which rows are provided and which are generated

The dataset that shipped with the assignment could not answer three of its own eight
questions: it had no geography column at all (tasks 2 and 3) and every one of its 750
orders fell in 2026 (task 7). The owner chose to extend the data rather than answer "the
schema cannot say" three times. That extension is one committed script,
[`scripts/seed-extended-data.mjs`](scripts/seed-extended-data.mjs), and it is the only
thing that has ever written to `shop.db`.

| Rows | Origin |
|---|---|
| `products`, all 50 | **Provided**, untouched |
| `customers` 1–150 | **Provided**, untouched apart from `country` below |
| `customers.country` | **Added** as a new column. The 150 provided customers all have Russian names and `+79…` phones, so they are backfilled to `Russia` — a reading of the provided data, not an invention |
| `customers` 151–235 | **Generated** — 85 customers from seven other countries |
| `orders` 1–750, all dated **2026**, and their 1900 `order_items` | **Provided**, untouched |
| `orders` 751–960, all dated **2025**, and their 529 `order_items` | **Generated** |

Two predicates separate the halves cleanly: `customers.id > 150` and
`orders.order_date < '2026-01-01'`. No provided row was modified and no 2026 order was
touched, so every figure this project ever measured about 2026 is still exactly what the
provided data says.

The script is deterministic — a fixed PRNG seed, explicit primary keys, and a
delete-then-insert of exactly those two groups — so `node scripts/seed-extended-data.mjs`
can be re-run and reproduces the same rows, and the numbers quoted in this README stay
true. It re-checks fourteen invariants on every run and exits non-zero if any fails, and
`test/data-invariants.test.js` re-runs that same list against the committed `shop.db` — so
they are a property of the file in the repository, not just of the run that produced it. It
also refuses to touch any database it cannot identify as this one, and does its deletes and
inserts in a single transaction, so an interrupted run leaves the file exactly as it was.

Two coherence rules were followed, because incoherent filler is worse than the honest gap
it replaces:

- **Name, phone country code, email domain and country agree on every row.** A German
  customer is `Ben Weber`, `+49151…`, `ben.weber143@freenet.de`, `Germany`. A Russian name
  against a `+79` phone and `Brazil` would be spotted instantly.
- **No generated order predates what it depends on.** In the provided data the catalogue
  begins on 2025-08-24 (only 5 of 50 products exist before September) and the earliest
  customer registered on 2025-08-22, so the generated orders start on 2025-09-01, each one
  drawing only from products already created on its date and belonging to a customer
  already registered on its date. That is why 2025 revenue lives in September–December and
  not in January.

### 1. Geography exists at country level and no finer

`customers.country` is the only geography column. There is still no `city`, `address` or
`region`, so `SELECT city FROM customers` fails with `no such column: city` enriched with
the real column list — the same self-correcting refusal that used to catch `country`.

| Country | Customers | Origin |
|---|---|---|
| Russia | 150 | provided |
| Germany | 24 | generated |
| France | 16 | generated |
| United Kingdom | 13 | generated |
| Italy | 11 | generated |
| Spain | 9 | generated |
| Poland | 7 | generated |
| Netherlands | 5 | generated |

235 in total, no NULLs, and no tie anywhere near the top: Russia leads Germany 150 to 24,
so homework task 3 has one unambiguous answer.

### 2. Orders span 2025-09 to 2026-08 with a gap in the middle — and the date trap remains

`orders.order_date` now runs **2025-09-01 11:19:14 to 2026-08-22 17:06:30**. It is not
continuous: the generated orders stop on 2025-12-31 and the provided ones begin on
2026-02-17, so **January 2026 has no orders at all** and a monthly breakdown skips it
rather than showing a zero row.

The trap that motivated `revenue_by_period` is unchanged — two of the three date columns in
this database are not sales dates:

| Column | Range | What it means |
|---|---|---|
| `orders.order_date` | 2025-09-01 → 2026-08-22 | when a sale happened |
| `customers.created_at` | 2025-08-22 → 2026-02-17 | when a customer registered |
| `products.created_at` | 2025-08-24 → 2025-11-19 | when a product was added to the catalogue |

An agent that joins on the wrong column still reports revenue no sale ever produced.
`revenue_by_period` says which column it buckets on, and an empty range (2024, say) comes
back with the actual available span attached rather than as an error.

### 3. "Best-selling" is ambiguous and the two readings name different products

On the default basis (cancelled orders excluded):

| Ranking | Leader | Units | Revenue |
|---|---|---|---|
| **By revenue** | Ноутбук UltraBook 15 | 98 | 8 819 020.00 |
| **By units** | Планшет Tab 10 | 123 | 4 303 770.00 |

Top five each way:

| # | By revenue | Units | Revenue | | By units | Units | Revenue |
|---|---|---|---|---|---|---|---|
| 1 | Ноутбук UltraBook 15 | 98 | 8 819 020.00 | | Планшет Tab 10 | 123 | 4 303 770.00 |
| 2 | Планшет Tab 10 | 123 | 4 303 770.00 | | Блендер погружной 800W | 117 | 373 230.00 |
| 3 | Смартфон Galaxy S21 | 71 | 4 259 290.00 | | Коврик для йоги Anti-slip | 111 | 165 390.00 |
| 4 | Монитор 27' 4K | 86 | 2 407 140.00 | | Фен профессиональный | 110 | 603 900.00 |
| 5 | Кофемашина Espresso | 91 | 2 274 090.00 | | Подставка для ноутбука | 102 | 182 580.00 |

Ranking by units puts Планшет Tab 10 first on 123 units for 4 303 770.00 — less than half
what Ноутбук UltraBook 15 earns on 25 *fewer* units. Below it the two readings diverge much
harder: the second and third unit sellers move 117 and 111 units for 373 230.00 and
165 390.00, a twenty-third and a fifty-third of the revenue leader's total. This is why
`top_products_by_sales` returns both metrics on every row and makes `rank_by` an explicit
choice: a good answer names which reading it used.

### 4. Cancelled orders change the answers, so every figure must state its basis

**129 of the 960 orders have `status = 'cancelled'`** (the other statuses are `completed`
445, `shipped` 166, `processing` 113, `new` 107). Whether they count as revenue is a
business question the data cannot settle, so the server does not settle it either: the
analytics tools take `include_cancelled`, defaulting to **false**, and every result carries
a note saying which basis produced it.

It genuinely matters:

| | Excluding cancelled | Including cancelled |
|---|---|---|
| Total revenue | 37 124 430.00 | 43 698 190.00 |
| 2025 revenue | 8 990 280.00 | 10 906 130.00 |
| Top spender | Екатерина Харитонов, 859 460.00 | Екатерина Харитонов, 885 420.00 |
| 2nd biggest spender | Дмитрий Харитонов, 701 780.00 | Наталья Петрова, 876 900.00 |
| 3rd biggest spender | Наталья Петрова, 690 950.00 | Дмитрий Харитонов, 785 750.00 |
| 2nd best-selling product by revenue | Планшет Tab 10 | Смартфон Galaxy S21 |

Note the middle rows: the *ranking itself* changes, not just the totals.

### 5. A bare-year date literal silently matches nothing

This one is sharp enough to deserve its own entry, and the seeding is what made it
observable. `orders.order_date` is declared `DATETIME`, and SQLite gives that declaration
**NUMERIC affinity**. Compare it against a literal that looks like a number and the literal
is coerced to an integer — and in SQLite's type ordering every TEXT value sorts *after*
every number, so the comparison does not mean what it reads as. Measured on the committed
database:

| Query | Rows | Correct answer |
|---|---|---|
| `WHERE order_date >= '2026'` | **960** | 750 |
| `WHERE order_date < '2026'` | **0** | 210 |
| `WHERE order_date >= '2026-01-01'` | 750 | 750 |
| `WHERE order_date < '2026-01-01'` | 210 | 210 |

The full-length literal is fine because `'2026-01-01'` cannot be read as a number, so both
sides stay TEXT. The bare year is not: `SELECT SUM(total_amount) FROM orders WHERE
order_date < '2026'` returns nothing at all and reads as *"2025 revenue is zero"* — the
same confident, sourced, wrong answer that this whole design exists to prevent, arrived at
by a different route. `customers.created_at` behaves identically.

Before the seeding this was unobservable: every order was 2026, so the wrong query and the
right one agreed. It is a `run_sql_query` hazard only — all three analytics tools wrap the
column in `date(...)`, so they were never exposed. `run_sql_query`'s description now carries
the warning, which is where an agent reads it in time to matter; the fixes are a full date
literal, `date(order_date)`, or `strftime('%Y', order_date)`.

### One thing that is not a trap

`orders.total_amount` equals `SUM(order_items.quantity * unit_price)` for all 960 orders,
every order has at least one item, and every `order_items.unit_price` matches the product's
current price. That was true of the 750 provided orders and the seeding script preserves it
by construction — it computes each total from the items it just wrote and reads every
`unit_price` off the product row. So aggregating `orders` and aggregating `order_items` give
the same revenue, and there is no hidden discrepancy to fall into.

---

## The eight homework questions

Ground truth measured directly against the committed `shop.db`, which includes the
generated rows described [above](#0-which-rows-are-provided-and-which-are-generated).
**Figures exclude cancelled orders unless stated**, matching the tools' default.

| # | Question | The answer this database gives |
|---|---|---|
| 1 | Show me all available tables and explain what each contains | **4 tables**: `customers` (235 rows — people, with `country`), `products` (50 — name, category, price, stock), `orders` (960 — one row per order, with `customer_id`, `order_date`, `status`, `total_amount`), `order_items` (2429 — the line items linking orders to products with quantity and unit price) |
| 2 | How many customers are from Germany? | **24.** Germany is the largest of the seven non-Russian countries — see the [country table](#1-geography-exists-at-country-level-and-no-finer). All 24 are generated rows |
| 3 | Which country has the most customers? | **Russia, with 150 of 235.** Germany is second with 24, France third with 16. No tie anywhere in the ranking |
| 4 | Who spent the most money? | **Екатерина Харитонов** — `ekaterina.kharitonov777@gmail.com` — **859 460.00** across 11 orders excluding cancelled (**885 420.00**, 12 orders, including). First on either basis |
| 5 | Top 5 best-selling products | **Ambiguous by design — both rankings are in the table [above](#3-best-selling-is-ambiguous-and-the-two-readings-name-different-products).** By revenue: Ноутбук UltraBook 15 (98 units, 8 819 020.00). By units: Планшет Tab 10 (123 units, 4 303 770.00) |
| 6 | Top 3 product categories by revenue | **Электроника** 23 011 170.00, **Бытовая техника** 7 237 660.00, **Одежда и обувь** 3 736 320.00. (Including cancelled: 27 529 610.00 / 8 276 500.00 / 4 211 080.00 — same order.) Then Спорт и отдых 2 059 700.00 and Книги и канцелярия 1 079 580.00 |
| 7 | How much revenue in 2025? | **8 990 280.00** from 183 orders (**10 906 130.00** from 210 including cancelled). All of it falls in September–December 2025 and all of it is generated; 2026 contributes 28 134 150.00 |
| 8 | Which customer placed the most orders? | **София Яковлев** — `sofiya.yakovlev284@yandex.ru` — **16** orders excluding cancelled, **17** including. First on either basis. Runners-up: Полина Петрова with 13 (15 including), then Мария Иванов with 12 (13) |
| — | *Delete all cancelled orders* | **Refused.** `READ_ONLY_VIOLATION`; the file is byte-identical afterwards — see [Read-only guarantee](#read-only-guarantee) |

---

## Known technical limitations

Stated rather than glossed over.

### The query deadline only interrupts a plan between rows

`run_sql_query` carries a deadline, but it is checked **between rows as they are iterated**.
That bounds a query that streams rows slowly — a correlated subquery over a large join, for
example. It **cannot** stop a plan that computes its entire result before yielding row one:
a bare `COUNT(*)` or `SUM` over a large join is the worst case, and `ORDER BY`, `GROUP BY`,
`DISTINCT` and `UNION` over a large join behave the same way. Such a query runs to
completion however long that takes, and because `better-sqlite3` is synchronous the server
cannot answer anything else meanwhile.

This is a real limitation, not a tuning problem. `better-sqlite3` exposes neither an
interrupt nor a progress handler (verified: neither is on the `Database` prototype), so
there is no in-process way to cancel a running statement. A worker thread is the only real
fix and is out of scope here. `run_sql_query`'s own description tells the agent to filter
before joining rather than to rely on the cut-off. In practice, on a database of this size
nothing comes close.

### The caps bound what leaves the process, not what is allocated inside it

`SELECT randomblob(200000000)` is a legitimate read. It passes the guard correctly, and the
output cap then truncates the result to a marker — but only *after* SQLite has allocated
roughly 200 MB to build the value. The row cap, the response cap and the per-cell cap all
bound what is serialised out to the agent; none of them bounds peak memory inside the
process. SQLite's own `SQLITE_MAX_LENGTH` is the only ceiling, near 1 GB per value.

This is left as a residual rather than fixed, because bounding it means predicting which
scalar functions allocate, and a wrong guess refuses legitimate SQL at a security boundary.

### One barrier in the capstone is an accident, not a layer

Worth knowing if you change the query code. The capstone measured that `ATTACH` and every
DDL statement fail *even with the SQL guard disabled* — but not because something is
guarding them. `runQuery` reaches a statement through `columns()` and `iterate()`, and both
throw for a statement that returns no rows, which is every `ATTACH` and every DDL. That is
a property of the paging code, and it would evaporate the moment anyone added a `.run()`
path.

`DELETE … RETURNING` is the one write shape that *does* return rows, so it is the only one
that gets past that accident — and the guard is what stops it. Do not read the capstone's
green as evidence that the guard is redundant; read it as evidence that the guard is the
only thing standing between a `.run()` path and a modified database.

### Also out of scope

- Write access of any kind, including a confirm-first mutation path.
- Bounding in-process memory allocation, per the residual above.
- MCP Resources and Prompts — tools alone cover every requirement, and resource support is
  uneven across agent harnesses.
- HTTP / SSE transport. stdio only, as specified.
- Auth, multi-tenancy, connection pooling, result caching.

---

## Project layout

```
src/
  index.js       entry point: reroutes console, resolves config, opens the DB, connects
                 stdio. The only module that touches process, stdio or exits.
  config.js      resolveDbPath(env, moduleUrl) — pure, never consults process.cwd()
  db.js          openDatabase (readonly) and runQuery (guard, prepare, paginate, cap)
  sql-guard.js   assertReadOnly(sql) — the lexer and the allow-list. No database handle.
  introspect.js  listTables, describeTable
  analytics.js   probeCapabilities and the three specialised tools
  errors.js      error types with stable codes, and the sanitizer
  tools.js       tool registration. Every tool description lives here. No SQL.
test/            node:test suites, unit and end-to-end
scripts/
  seed-extended-data.mjs   the one script that has ever written to shop.db: adds
                 customers.country, 85 non-Russian customers and 210 orders dated 2025.
                 Deterministic and re-runnable; see "Known data limitations"
shop.db          the database (committed, as the homework requires)
Dockerfile       node:22-slim, build stage for the native compile
.mcp.json        Claude Code connection config
mcp.config.example.json   the generic client config, executed by the test suite
```
