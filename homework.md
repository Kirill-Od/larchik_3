# Домашнее задание: MCP-сервер для работы с базой данных — план этапов и статус

**Цель:** MCP-сервер, дающий AI-агенту read-only доступ к SQLite-базе интернет-магазина
(`customers` → `orders` → `order_items` → `products`), подключаемый через stdio.

**Ограничение задания:** код MCP-сервера пишется не вручную, а AI coding agent'ом.

---

## Легенда

- `[x]` — сделано и подтверждено (тестом, файлом или запуском)
- `[ ]` — не сделано
- `[~]` — сделано частично / с оговоркой (пояснение рядом)

**Сводка проверки от 2026-08-23:** реализовано на Node.js, `npm test` → **196/196 passed**.
Открытым остаётся только пункт сдачи: изменения не закоммичены и не запушены в `origin`.

---

## Этап 0. Подготовка

- [x] 0.1 Выбран стек: **Node.js** (ESM, `node >= 20`) — [package.json](package.json)
- [x] 0.2 База `shop.db` включена в проект (150 клиентов, 50 товаров, 750 заказов, 1900 позиций) — [shop.db](shop.db)
- [x] 0.3 Код написан через AI coding agent (Claude Code + скиллы) — [.claude/skills/](.claude/skills/)
- [x] 0.4 План и разбиение на задачи зафиксированы — [tasks/plan.md](tasks/plan.md), [tasks/todo.md](tasks/todo.md)

---

## Этап 1. Запуск MCP-сервера (§2 задания)

- [x] 1.1 Сервер работает через **stdio** (`StdioServerTransport`) — [src/index.js:55](src/index.js#L55)
- [x] 1.2 Запускается как `{"command": "node", "args": [".../src/index.js"]}` — [mcp.config.example.json](mcp.config.example.json)
- [x] 1.3 Сервер сам подключается к `shop.db`, отдельный HTTP-сервер не нужен — [src/db.js](src/db.js)
- [x] 1.4 `stdout` защищён от постороннего вывода (`console.log` → `console.error` первым же стейтментом) — [src/index.js:1-6](src/index.js#L1-L6)
- [x] 1.5 Используется официальный MCP SDK (`@modelcontextprotocol/sdk@^1.30.0`)
- [x] 1.6 E2E-тест: реальный handshake клиента с дочерним процессом — [test/server.e2e.test.js](test/server.e2e.test.js)

---

## Этап 2. Знакомство агента со схемой (§3, задача 1)

- [x] 2.1 `list_tables` — таблицы/представления, число строк, сводка колонок — [src/tools.js:29](src/tools.js#L29)
- [x] 2.2 `describe_table` — колонки (тип/NOT NULL/PK/default), foreign keys, CHECK-констрейнты, индексы, DDL, 3 примера строк — [src/introspect.js](src/introspect.js)
- [x] 2.3 Служебные таблицы SQLite (`sqlite_sequence` и т.п.) скрыты
- [x] 2.4 Ошибка на несуществующей таблице возвращает список реальных таблиц
- [x] 2.5 Тесты — [test/introspect.e2e.test.js](test/introspect.e2e.test.js), [test/describe-table.e2e.test.js](test/describe-table.e2e.test.js)

**Задача 1 («Show me all available tables…») — [x] агент отвечает полностью.**

---

## Этап 3. Выполнение SQL-запросов (§3, задачи 4–8)

- [x] 3.1 `run_sql_query` — один read-only `SELECT` / `WITH…SELECT` / `VALUES` — [src/tools.js:88](src/tools.js#L88)
- [x] 3.2 Возврат `{columns, rows, row_count, limit, offset, has_more, notes}` — [src/db.js](src/db.js)
- [x] 3.3 Двойная защита: SQL-guard **плюс** отказ, если `stmt.readonly === false`
- [x] 3.4 Корректная сериализация всех типов SQLite (BLOB, BigInt, NULL, REAL, TEXT) с обрезкой ячеек > 4 KB
- [x] 3.5 Ограничение времени выполнения (`QUERY_TIMEOUT`) для потоковых планов
- [x] 3.6 Тесты — [test/run-sql-query.e2e.test.js](test/run-sql-query.e2e.test.js), [test/db.test.js](test/db.test.js)

### Контрольные вопросы задания

- [x] **Задача 4.** Кто потратил больше всех → Дмитрий Харитонов, `dmitriy.kharitonov845@mail.ru`, **701 780.00** (без отменённых; 785 750.00 с ними)
- [x] **Задача 5.** Топ-5 товаров → возвращаются **и units, и revenue**; по выручке лидер Ноутбук UltraBook 15, по штукам — Эспандер плечевой
- [x] **Задача 6.** Топ-3 категории по выручке → Электроника 17 060 760.00, Бытовая техника 5 506 570.00, Одежда и обувь 3 085 470.00 (join `orders → order_items → products`)
- [x] **Задача 8.** Больше всех заказов → София Яковлев, `sofiya.yakovlev284@yandex.ru`, **15** заказов (16 с отменёнными)
- [~] **Задача 7.** Выручка за 2025 → корректный ответ **0**: все 750 заказов лежат в диапазоне 2026-02-17 … 2026-08-22. Сервер отдаёт реальный доступный диапазон дат вместо ошибки, чтобы агент не подставил `customers.created_at` / `products.created_at`
- [~] **Задача 2.** «How many customers are from Germany?» → **неотвечаемо**: в базе нет колонки страны/города/адреса. Сервер спроектирован так, чтобы агент это обнаружил и честно сказал (ошибка `no such column` дополняется списком реальных колонок; `instructions` запрещают выдумывать)
- [~] **Задача 3.** «Which country has the most customers?» → **неотвечаемо**, та же причина

> Оговорка по 2, 3, 7 — свойство предоставленных данных, а не пробел реализации.
> Разобрано в README → «Known data limitations».

---

## Этап 4. Safety: только чтение (§4)

- [x] 4.1 База открывается в режиме `readonly` — [src/db.js](src/db.js)
- [x] 4.2 SQL-guard: allow-list открывающих ключевых слов + правило «ровно один стейтмент» — [src/sql-guard.js](src/sql-guard.js)
- [x] 4.3 Лексер вырезает комментарии (`--`, `/* */`), строковые литералы и кавычки идентификаторов **до** матчинга глаголов — обход через `/* SELECT */ DELETE …` не работает, а `WHERE name = 'DROP TABLE orders'` при этом разрешён
- [x] 4.4 Запрещены `INSERT` / `UPDATE` / `DELETE` / `DROP` / `ALTER` / `CREATE` (включая `CREATE TEMP`)
- [x] 4.5 Запрещены `PRAGMA`, `ATTACH`, `DETACH`, `VACUUM`, `REINDEX`, `BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`, `EXPLAIN <write>`
- [x] 4.6 Запрещены записи, спрятанные в CTE (`WITH x AS (...) DELETE …`)
- [x] 4.7 **«Delete all cancelled orders.»** → отказ `READ_ONLY_VIOLATION` + подсказка эквивалентного `SELECT`
- [x] 4.8 Capstone-тест: 21 атакующий запрос через живого MCP-клиента, после прогона SHA-256 и размер копии базы **не изменились** — [test/safety.e2e.test.js](test/safety.e2e.test.js)

---

## Этап 5. Дизайн tools (§5)

- [x] 5.1 Гибридный дизайн: 3 базовых tool'а + 3 специализированных, а не по tool'у на вопрос
- [x] 5.2 Базовые: `list_tables`, `describe_table`, `run_sql_query`
- [x] 5.3 Специализированные: `top_customers_by_spend`, `top_products_by_sales`, `revenue_by_period` — [src/analytics.js](src/analytics.js)
- [x] 5.4 Специализированные tools регистрируются **только если схема их поддерживает** (`probeCapabilities`) — [src/tools.js:143](src/tools.js#L143)
- [x] 5.5 Описания в едином формате: **WHEN TO USE / WHAT TO PASS / RETURNS / LIMITS**
- [x] 5.6 Аннотации `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false` на каждом tool
- [x] 5.7 `instructions` сервера направляют агента: сначала осмотреться, не выдумывать недостающее — [src/index.js:15-31](src/index.js#L15-L31)
- [x] 5.8 `include_cancelled` (по умолчанию `false`) и явный `rank_by` — неоднозначность решает агент, а не сервер
- [x] 5.9 Тест на качество описаний — [test/descriptions.e2e.test.js](test/descriptions.e2e.test.js)

---

## Этап 6. Технические требования (§6)

- [x] 6.1 Используется MCP SDK
- [x] 6.2 Работа через stdio
- [x] 6.3 SQLite (`better-sqlite3`)
- [x] 6.4 Корректная обработка ошибок: типизированные коды `READ_ONLY_VIOLATION` / `SQL_ERROR` / `INVALID_ARGUMENT` / `QUERY_TIMEOUT` / `CONFIGURATION_ERROR` — [src/errors.js](src/errors.js)
- [x] 6.5 Stack traces и абсолютные пути не утекают агенту (санитайзер + тест «ни одно сообщение не содержит `/`-пути и `at ` фрейма»)
- [x] 6.6 Ошибки обучающие: `no such column` дополняется списком реальных колонок, `no such table` — списком таблиц
- [x] 6.7 Абсолютных путей в коде нет
- [x] 6.8 Путь к базе — из `SHOP_DB_PATH`, иначе относительно корня проекта через `import.meta.url` (не `process.cwd()`) — [src/config.js](src/config.js)
- [x] 6.9 Недоступная база не роняет сервер: handshake проходит, tools отвечают `CONFIGURATION_ERROR` — [test/boot.e2e.test.js](test/boot.e2e.test.js)
- [x] 6.10 README с цепочкой **install → configure → run → connect to agent** — [README.md](README.md)

---

## Этап 7. Что сдавать (§7)

- [x] 7.1 `README.md` — [README.md](README.md)
- [x] 7.2 `package.json` — [package.json](package.json)
- [x] 7.3 Исходный код — [src/](src/)
- [x] 7.4 Пример конфигурации — [mcp.config.example.json](mcp.config.example.json)
- [x] 7.5 Конфиг для подключения к агенту (Claude Code) — [.mcp.json](.mcp.json)
- [x] 7.6 `shop.db` включён в репозиторий (явно не игнорируется, см. комментарий в [.gitignore](.gitignore))
- [x] 7.7 Тест, проверяющий, что пример конфигурации реально запускается — [test/config-example.test.js](test/config-example.test.js)
- [ ] 7.8 **Работа сдана: изменения закоммичены и запушены.** Сейчас в рабочем дереве 12 изменённых файлов + новый `test/errors.test.js`, ветка `master` не выгружена в `origin` (`origin/master` отсутствует)

---

## Этап 8. Критерии проверки (§8)

- [x] 8.1 MCP успешно запускается
- [x] 8.2 Агент видит MCP tools
- [x] 8.3 Агент получает информацию о структуре БД
- [x] 8.4 Агент отвечает на аналитические вопросы
- [x] 8.5 Агент корректно выполняет multi-step queries (`orders → order_items → products`)
- [x] 8.6 MCP корректно обрабатывает ошибки
- [x] 8.7 MCP не позволяет изменять базу (подтверждено хешем файла после атак)
- [x] 8.8 Tools имеют понятные descriptions и schemas
- [~] 8.9 Финальная проверка на «живом» стороннем агенте — покрыта e2e-тестами через настоящий MCP-клиент; ручной прогон в UI-агенте не документирован

---

## Этап 9. Bonus (§9)

- [x] 9.1 Pagination больших результатов (`limit` / `offset` / `has_more` + подсказка следующего вызова в `notes`)
- [x] 9.2 Понятная обработка SQL errors (с подстановкой реальных колонок/таблиц)
- [x] 9.3 Ограничение количества строк (по умолчанию 100, максимум 1000) и общего размера ответа (~256 KB)
- [x] 9.4 Специализированные tools для частых операций (3 аналитических)
- [x] 9.5 Хорошие descriptions (единый формат + тест)
- [x] 9.6 Автоматические тесты — **196 тестов, все проходят** (`npm test`), 17 файлов unit + e2e — [test/](test/)
- [x] 9.7 Docker support (multi-stage `node:22-slim`, `USER node`, документировано `docker run -i --rm`, без `-t`) — [Dockerfile](Dockerfile)
- [x] 9.8 Качественный README: 677 строк — установка, конфигурация, запуск, подключение, описание всех tools, гарантии read-only, ограничения данных и техники, ответы на все 8 вопросов

---

## Итог

| Раздел | Готово |
|---|---|
| §2 Требования к MCP | 6 / 6 |
| §3 Задачи агента | 5 полностью + 3 с честным «данных нет» |
| §4 Safety | 8 / 8 |
| §5 Дизайн tools | 9 / 9 |
| §6 Технические требования | 10 / 10 |
| §7 Что сдавать | 7 / 8 — не закоммичено и не запушено |
| §8 Критерии проверки | 8 / 9 |
| §9 Bonus | 8 / 8 |

**Единственный незакрытый пункт — 7.8: коммит и push.**
