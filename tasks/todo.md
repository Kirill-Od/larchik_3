# Todo

- [x] 1. Runnable stdio MCP server exposing `list_tables`
      Deliverable: package.json (type:module, engines node>=20, scripts start/test),
      @modelcontextprotocol/sdk@^1.30.0 + better-sqlite3 + zod installed; src/config.js
      resolving SHOP_DB_PATH then a project-relative path derived from import.meta.url
      (never process.cwd()); src/db.js opening readonly; src/introspect.js listTables;
      src/tools.js; src/index.js with `console.log = console.error` as its first
      statement; test/helpers.js startServer() driving StdioClientTransport with a merged
      getDefaultEnvironment(). Pin the v1 registerTool signature here: inputSchema is a
      raw ZodRawShape, not z.object().
      Test: test/server.e2e.test.js — spawn src/index.js as a child process, complete the
      MCP handshake, assert listTools() contains `list_tables`, and callTool returns
      customers/products/orders/order_items with row counts 150/50/750/1900.

- [x] 2. `describe_table` makes the schema fully discoverable
      Deliverable: introspect.describeTable — columns with type/nullable/PK/default,
      foreign keys, indexes, CHECK constraints, and 3 sample rows; registered as a tool.
      Test: describe_table('customers') returns exactly the 6 real columns and NO
      `country`, and its sample rows show `+79…` phones; describe_table('orders') exposes
      the status CHECK values; describe_table('nope') errors with the 4 valid table names
      in the message.

- [x] 3. SQL guard: allow-listed opener and single-statement rule
      Deliverable: src/sql-guard.js assertReadOnly(sql) throwing ReadOnlyViolation.
      Test: test/sql-guard.test.js — DELETE / INSERT / UPDATE / DROP / ALTER / CREATE /
      CREATE TEMP each refused; `SELECT 1` and `SELECT 1;` allowed;
      `SELECT 1; DELETE FROM orders` and `SELECT 1; ; DELETE FROM orders` refused.

- [x] 4. SQL guard: lex comments and string literals before matching verbs
      Deliverable: the tokenizer — strips `--` and `/* */` comments, `'…'` literals with
      `''` escapes, and `"…"` / `[…]` / backtick identifiers, then matches on what remains.
      Test: `-- x\nDELETE FROM orders`, `/* SELECT */ DELETE FROM orders`, and
      `SELECT 1 -- ;\nDELETE FROM orders` all refused, WHILE
      `SELECT * FROM products WHERE name = 'DROP TABLE orders'`,
      `SELECT * FROM products WHERE name = 'a;b'`, and
      `SELECT "delete" FROM (SELECT 1 AS "delete")` are all allowed.

- [x] 5. SQL guard: CTE-wrapped writes, PRAGMA, ATTACH, transaction verbs
      Deliverable: bare-token verb denylist applied across the whole lexed statement.
      Test: `WITH x AS (SELECT 1) DELETE FROM orders …` refused while
      `WITH x AS (SELECT 1 AS n) SELECT n FROM x` is allowed; PRAGMA writable_schema and
      PRAGMA table_info refused (the latter's message points at describe_table);
      `ATTACH DATABASE '<tmpdir>/evil.db' AS e` refused AND assert no file exists at that
      path; DETACH / VACUUM / REINDEX / BEGIN / COMMIT / ROLLBACK / SAVEPOINT refused;
      `EXPLAIN DELETE FROM orders` refused; `dElEtE   from\torders` refused;
      `Delete all cancelled orders.` refused with a message telling the caller to send SQL.

- [x] 6. `run_sql_query` executes a validated read-only query
      Deliverable: db.runQuery — assertReadOnly, db.prepare (never db.exec), refuse unless
      stmt.readonly, return {columns, rows, row_count, limit, offset, has_more, notes};
      registered as a tool.
      Test: e2e callTool with the orders→order_items→products join returns the F7 top-3
      categories (Электроника 19999620.00, Бытовая техника 6426360.00, Одежда и обувь
      3446960.00); and runQuery given a stub handle whose prepare() yields
      `stmt.readonly === false` refuses even though the guard passed.

- [x] 7. Row limits and pagination without rewriting the agent's SQL
      Deliverable: limit (default 100, max 1000) and offset applied via stmt.iterate(),
      with one extra row pulled to compute has_more exactly, and a `notes` string naming
      the exact next call.
      Test: a 150-row query with limit=10 returns 10 rows, has_more=true, and notes
      containing `offset=10`; offset=145 returns 5 rows with has_more=false; offset past
      the end returns 0 rows and has_more=false; limit=0 and limit=5000 both return
      INVALID_ARGUMENT naming the accepted range; a query with its own trailing LIMIT is
      not mangled.

- [x] 8. Every SQLite value type survives serialization
      Deliverable: a value coercer for BLOB (Buffer), BigInt, NULL, REAL, and TEXT, plus
      per-cell truncation above 4 KB with an explicit marker.
      Test: `SELECT randomblob(10) AS b, 9223372036854775807 AS big, NULL AS n,
      1.5 AS f` round-trips through the tool without throwing; a query returning a 100 KB
      text cell comes back truncated with the marker and a note.
      Carried in from the gate-2 review: `describeTable`'s sample rows are a SECOND call
      site reaching SQLite outside `runQuery`, with its own MINIMAL STOPGAP `sampleValue`.
      Replace that stopgap here too, or the coercer will not cover it.

- [x] 9. Runaway queries are bounded instead of hanging the process
      Deliverable: an elapsed-time check inside the iterate loop that aborts with a
      QUERY_TIMEOUT error explaining how to narrow the query.
      Test: a 3-way cross join over order_items returns QUERY_TIMEOUT within roughly
      twice the configured deadline rather than blocking the test run.
      Carried in from the gate-2 review: `describeTable` samples via `db.prepare().all()`,
      NOT through `runQuery`'s iterate loop, so a deadline added only to `runQuery` leaves
      view sampling unbounded (measured: 73 s on a GROUP BY view). Route it through the
      same mechanism or state why not.
      RESOLVED for describeTable in slice 2: views are no longer sampled at all, because
      better-sqlite3's Database prototype exposes NO interrupt and NO progress handler, so
      a running statement cannot be cancelled in-process and iterate() cannot help when the
      stall precedes row one. That bounds what THIS task can deliver: the deadline covers
      streaming plans only. Say so explicitly rather than implying general cancellation; a
      worker thread is the only real bound and plan §7 puts it out of scope.

- [x] 10. Errors teach the agent how to fix its query and leak nothing
      Deliverable: src/errors.js — READ_ONLY_VIOLATION / SQL_ERROR / INVALID_ARGUMENT /
      QUERY_TIMEOUT, "no such column" and "no such table" enriched with the real column
      and table lists, and a sanitizer stripping absolute paths and stack frames.
      Test: `SELECT country FROM customers` returns an error naming all 6 real customers
      columns; `SELECT * FROM nope` names the 4 real tables; the refusal for
      `DELETE FROM orders WHERE status='cancelled'` contains a suggested
      `SELECT … WHERE status = 'cancelled'`; and NO error message produced anywhere in
      the suite contains a `/`-rooted path or an `at ` stack frame.
      Carried in from the task-1 review: `introspect.countRows` interpolates a raw
      `err.message` into an agent-visible `note`, so the sanitizer must cover that path
      too, not just tool-level errors.

- [x] 11. Tool descriptions, annotations, and server instructions
      Deliverable: the content pass over src/tools.js in the WHEN TO USE / RETURNS /
      LIMITS house style, readOnlyHint+destructiveHint:false+openWorldHint:false on every
      tool, and the McpServer `instructions` string.
      Test: e2e listTools asserts every tool has annotations.readOnlyHint === true and a
      description over 200 chars; run_sql_query's description mentions both the 1000-row
      cap and the read-only refusal; describe_table's mentions confirming a column exists
      before querying it; and the initialize result's instructions is non-empty.

- [x] 12. Capstone: the database is byte-identical after a full attack run
      Deliverable: test/safety.e2e.test.js.
      Test: copy shop.db to a temp dir, point SHOP_DB_PATH at the copy, drive all 21
      adversarial statements from plan §6 through a live MCP client, and assert every call
      returned isError and the copy's SHA-256 and byte size are unchanged.
      CORRECTED after the slice-3 review: "no new files appeared" is VACUOUS on this path —
      better-sqlite3 opens an attachment readonly, so ATTACH of a nonexistent file cannot
      create one, and that assertion passes with the guard fully disabled. Replace it with
      the two reachable consequences: an ATTACH of an EXISTING sibling database is refused
      and its rows never resolve, and sqlite_temp_master is empty afterwards.

- [x] 13. Analytics tools, registered only when the schema supports them
      Deliverable: src/analytics.js — probeCapabilities plus top_customers_by_spend,
      top_products_by_sales (units and revenue on every row, rank_by parameter), and
      revenue_by_period (empty range returns the actual available date span, not an
      error); each with outputSchema and include_cancelled defaulting to false.
      Test: against shop.db, top_customers_by_spend returns Дмитрий Харитонов /
      dmitriy.kharitonov845@mail.ru / 701780.00 with include_cancelled=false and 785750.00
      with true; top_products_by_sales ranks Планшет Tab 10 first by revenue and
      Увлажнитель воздуха AirFresh first by units; revenue_by_period(year) for 2025
      returns an empty bucket list carrying the 2026-02-17…2026-08-22 range; and against a
      fixture DB with no orders table, listTools contains only the three core tools.

- [x] 14. A missing or unreadable database degrades gracefully
      Deliverable: boot continues when the DB cannot be opened; every tool returns a
      CONFIGURATION_ERROR naming SHOP_DB_PATH; the reason is logged once to stderr.
      Test: spawn with SHOP_DB_PATH pointing at a nonexistent file — the client still
      completes the handshake, listTools succeeds, callTool('list_tables') returns the
      configuration error, and the child process wrote nothing to stdout but valid
      JSON-RPC.

- [x] 15. Deliverables: README, executable config example, Docker
      Deliverable: README.md with install → configure → run → connect, a copy-pasteable
      client config, the eight homework questions with the answers this database actually
      gives, and a "Known data limitations" section stating that no country column exists
      (tasks 2–3 unanswerable) and that 2025 revenue is 0 because orders span 2026 only;
      USE THE CORRECTED §F6/§F7 NUMBERS: best-selling is Ноутбук UltraBook 15 by revenue
      and Эспандер плечевой by units on the default (excl. cancelled) basis — the plan's
      original Планшет Tab 10 / AirFresh claim was measured wrong. Every headline answer
      must state which cancelled-order basis produced it;
      mcp.config.example.json; .mcp.json for Claude Code; Dockerfile (node:22-slim with a
      build stage for better-sqlite3, documented as `docker run -i --rm`, never -t);
      .gitignore.
      Test: test/config-example.test.js reads mcp.config.example.json, spawns exactly the
      command/args/env it declares, and completes a listTools handshake — so the
      documented configuration cannot silently rot.
      Carried in from the task-1 review: the README must state that a relative
      SHOP_DB_PATH resolves against the PROJECT ROOT (not the client's cwd) and
      recommend an absolute path, since our convention is not what every operator
      will assume.
