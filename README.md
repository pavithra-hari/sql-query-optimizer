# SQL Query Optimizer

A client-side SQL linter and query lab. Paste a query (and optionally table
schema notes or an `EXPLAIN` plan), and it flags common performance
anti-patterns, suggests indexes, and rewrites a couple of safe patterns
automatically.

No backend, no build step, no dependencies — open `sql-optimizer.html` in a
browser and it runs.

## Features

- **Static analysis** — flags `SELECT *`, missing `WHERE` filters, function-wrapped
  predicates (`LOWER()`, `YEAR()`, ...), fragile `NOT IN`, leading-wildcard
  `LIKE`, unbounded `ORDER BY`, and missing join predicates (including
  implicit comma-joins).
- **Index suggestions** — proposes single-column and compound indexes based on
  columns used in `WHERE`/`JOIN`/`ORDER BY`, cross-checked against indexes you
  list in the Schema panel.
- **EXPLAIN plan analysis** — paste `EXPLAIN`/`EXPLAIN ANALYZE` output to catch
  sequential scans, disk spills, bad row estimates, and slow plan nodes, with
  a rendered plan tree.
- **Natural-language query builder** — describe what you want ("total order
  value per customer in 2025, top 20") and get a starting query built from
  your schema notes.
- **Score, diff, and local history** — a 0–100 score with a cost breakdown,
  a before/after diff view, and saved runs (via `localStorage`).

## Scope and limitations

This is a heuristic linter, table/column detection,
formatting, and the diff view are all regex-based over a whitespace-normalized
copy of the query. That's a deliberate trade-off for a zero-dependency, 100%
client-side tool — it won't handle deeply nested subqueries, CTEs, or window
functions correctly, and it can misparse SQL keywords appearing inside string
literals.

**The "Optimized Query" panel only auto-rewrites two patterns**:
`SELECT *` (replaced with a placeholder comment) and `YEAR(col) = year`
(rewritten to a sargable date range). Every other finding — missing join
predicates, `NOT IN`, leading-wildcard `LIKE`, unbounded sorts, etc. — is
flagged with an explanation but left for you to fix manually, since rewriting
those safely requires understanding intent the tool doesn't have.

The dialect selector (Postgres/MySQL/SQL Server/SQLite) currently only
labels the session; it doesn't yet change analysis rules or generated SQL
per-dialect.

## Files

- `sql-optimizer.html` — layout
- `sql-optimizer.css` — styling, with light/dark theme support via
  `prefers-color-scheme`
- `sql-optimizer.js` — all analysis logic, UI rendering, and state

## Running

```
open sql-optimizer.html
```

or serve the directory with any static file server.
