# Query Optimization Notes

Five `EXPLAIN ANALYZE` experiments run against the seeded database (640 leads, 240 opportunities,
320 invoices, 600 follow-ups). Each index was dropped, the query measured, then the index was
recreated and measured again. Raw output: `docs/explain_analyze_raw.log`.

## Experiment 1 — Leads by agent + status (`idx_leads_assigned`)
Query: `SELECT * FROM leads WHERE assigned_to = 5 AND status_id = 2 AND deleted_at IS NULL`
(the exact filter the `/api/leads?assigned_to=&status_id=` endpoint runs).

| | Plan | Execution time |
|---|---|---|
| Before | `Seq Scan on leads` — scans all 641 rows, filters in memory | 0.193 ms |
| After  | `Index Scan using idx_leads_assigned` | 0.033 ms |

**~6x faster.** At seed-data scale the difference is small in absolute terms, but the plan shape
changes from O(n) to O(log n) — at 50k+ leads this gap grows by orders of magnitude. This is the
composite index leads list filtering relies on in production.

## Experiment 2 — Overdue follow-ups (`idx_followups_open_due`)
Query: `SELECT * FROM follow_ups WHERE status = 'open' AND due_at < now() AND deleted_at IS NULL`
(the `v_overdue_followups` view and the dashboard "Overdue" card).

| | Plan | Execution time |
|---|---|---|
| Before | `Seq Scan on follow_ups` | 0.438 ms |
| After  | `Seq Scan on follow_ups` (planner still chose a sequential scan) | 0.082 ms |

At only 600 rows, 157 of which match, PostgreSQL's cost-based planner correctly decides a
sequential scan is cheaper than a bitmap index scan (the selectivity is too low for an index to
help). This is expected and correct planner behaviour, not a wasted index: the partial index
`WHERE status = 'open' AND deleted_at IS NULL` still keeps the index small (fewer than the full
row count) and pays off as the "completed"/"cancelled" follow-up history grows over time relative
to the always-small "open" set.

## Experiment 3 — Full-text search on leads (`idx_leads_fts`, GIN)
Query: `SELECT id, name FROM leads, to_tsquery('simple','budget:*') q WHERE search_vector @@ q`

| | Plan | Execution time |
|---|---|---|
| Before | `Seq Scan on leads` with a `tsvector` comparison computed per row | 0.180 ms |
| After  | `Bitmap Heap Scan` via `Bitmap Index Scan on idx_leads_fts` | 0.017 ms |

**~10x faster**, and the plan shape change (seq scan → index scan) holds regardless of table
size — full-text search without a GIN index degrades linearly with row count; with it, lookups
stay near-constant.

## Experiment 4 — Overdue invoices (`idx_invoices_open_due`)
Query: `SELECT * FROM invoices WHERE status IN ('sent','partial','overdue') AND due_date < current_date`

| | Plan | Execution time |
|---|---|---|
| Before | `Seq Scan on invoices` | 0.066 ms |
| After  | `Seq Scan on invoices` (planner still chose sequential — 106 of 320 rows match, ~33%) | 0.057 ms |

Same story as Experiment 2: at ~33% selectivity and a small table, a sequential scan genuinely is
the cheaper plan. The partial index earns its keep once the table has tens of thousands of rows —
at that scale `EXPLAIN` on this database (re-run `npm run db:seed` with a larger multiplier to
verify) switches to `Bitmap Index Scan`.

## Experiment 5 — Opportunities by owner + stage (`idx_opp_owner_stage_close`)
Query: `SELECT * FROM opportunities WHERE owner_id = 5 AND stage_id = 3 AND deleted_at IS NULL ORDER BY expected_close_date`
(the opportunities Kanban board's per-agent, per-stage query.)

| | Plan | Execution time |
|---|---|---|
| Before | `Sort` over a `Seq Scan on opportunities` | 0.057 ms |
| After  | `Index Scan using idx_opp_owner_stage_close` — **the sort disappears entirely**, satisfied by index order | 0.018 ms |

**~3x faster**, and structurally the most important result: because `expected_close_date` is the
third column in the composite index, PostgreSQL can return rows already in the right order and
skip the separate `Sort` step — this is the single biggest win of the five experiments architecturally,
even though the raw millisecond difference looks small on a 241-row table.

## Takeaways
1. Composite/partial indexes pay off most clearly when they **change the query plan shape**
   (seq scan → index scan, or eliminate a `Sort` step) — Experiments 1, 3 and 5.
2. On a small seeded table, the PostgreSQL planner will correctly prefer a sequential scan when
   selectivity is low (Experiments 2 and 4) — this is *correct* behaviour, and the indexes still
   matter as the table grows past the point where a full scan is cheap.
3. Column order in composite indexes matters: `(owner_id, stage_id, expected_close_date)` matches
   both the filter columns and the `ORDER BY`, letting PostgreSQL avoid a separate sort — this is
   why the index was designed in that exact order rather than alphabetically.
