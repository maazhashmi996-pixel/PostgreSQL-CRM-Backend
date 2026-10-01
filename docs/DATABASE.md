# Database Architecture

## Entity groups and relationships

**Identity & org structure**
- `roles` 1→N `users` · `teams` 1→N `users` · `users` self-references via `manager_id` (recursive
  hierarchy, see `get_user_hierarchy()`) · `teams.manager_id` → `users`.

**Sales pipeline**
- `lead_sources`, `lead_statuses` (funnel position via `sort_order`, `is_final`), `lead_stages`
  (opportunity pipeline, each with a win `probability`) are lookup tables.
- `leads` belongs to a `lead_source`, a `lead_status`, and an owning `user` (assigned_to).
- `leads` N↔N `tags` through `lead_tags`.
- `lead_status_history` logs every status transition (trigger-maintained, never written to directly).
- `convert_lead(lead_id, user_id)` turns a lead into a `customers` + `contacts` + `opportunities`
  row set, inside one transaction; `leads.converted_customer_id` / `converted_at` record the result.

**Customers**
- `customers` 1→N `contacts` (with a **partial unique index** ensuring at most one `is_primary`
  contact per customer, and email uniqueness scoped to the customer, not globally).
- `customers` 1→N `activities`, `follow_ups`, `opportunities`, `invoices`.

**Activity tracking**
- `activities` and `follow_ups` can point at *either* a `lead` or a `customer` (never both null —
  enforced by a CHECK constraint), so the same interaction log works pre- and post-conversion.
- `tasks` can optionally reference a `lead` and/or `customer`, always has an `assigned_to` and a
  `created_by`.

**Revenue**
- `products` N↔N `opportunities` through `opportunity_products` (composite PK
  `(opportunity_id, product_id)` — the "opportunity/product combination" uniqueness required by
  the spec). A trigger recomputes `opportunities.products_total` and `amount` whenever these lines
  change.
- `opportunities` 1→N `quotes` and 1→N `invoices` (both optional — a quote/invoice can also stand
  alone against a `customer` directly).
- `invoices` 1→N `payments`. A trigger (`validate_payment`) locks the invoice row and rejects any
  payment that would push total successful payments past `total_amount`; another trigger keeps
  `invoices.status` (`sent`/`partial`/`paid`/`overdue`) in sync automatically as payments land.

**Audit**
- `audit_logs` captures INSERT/UPDATE/DELETE/SOFT_DELETE on every business-critical table as
  JSONB before/after snapshots, tagged with the acting `user_id` (read from the transaction-local
  `app.user_id` setting the API sets on every write).

## Business rules enforced at the database layer (not just the frontend)

| Rule | Mechanism |
|---|---|
| A payment can never exceed its invoice's remaining balance | `validate_payment` trigger, row-locked with `FOR UPDATE` |
| An invoice's total can't drop below what's already been paid; a paid invoice can't be cancelled | `guard_invoice_total` trigger |
| Exactly one primary contact per customer | Partial unique index `uq_contacts_one_primary` |
| A lead can only be converted once | `convert_lead()` checks `converted_at IS NOT NULL` and raises `CR001` |
| Opportunity `amount`/`products_total` always reflects its product lines | `refresh_opportunity_total` trigger |
| Every status change on a lead is recorded, including its first status | `log_lead_status_change` trigger (AFTER INSERT *and* AFTER UPDATE) |
| A manager can't manage themselves; a self-referencing loop is impossible one level deep | CHECK constraint `chk_users_manager_not_self` |
| Money, quantities, discounts, probabilities all stay in valid ranges | CHECK constraints on every relevant column |

## Soft delete

`leads`, `customers`, `contacts`, `activities`, `follow_ups`, `tasks`, `opportunities`, `products`
and `quotes` use a nullable `deleted_at` — the API's generic CRUD layer filters `WHERE deleted_at
IS NULL` on every read and turns `DELETE` into `UPDATE … SET deleted_at = now()`. `invoices` and
`payments` are financial records and are **never** deleted — they're cancelled/refunded via
`status` instead, which the audit log then captures as an ordinary UPDATE.

## Concurrency

`validate_payment` and `convert_lead()` both take `SELECT … FOR UPDATE` row locks before reading
balances, so two simultaneous payment requests against the same invoice — or two attempts to
convert the same lead — serialize correctly instead of both reading a stale balance and both
succeeding when only one should. This was verified manually by opening two `psql` sessions and
firing overlapping payments at the same invoice: the second session blocks until the first
commits, then re-evaluates the balance and is correctly rejected once it would overshoot.

### Concurrency test evidence (reproduced for this build)
Two `psql` sessions against invoice #276 (balance \$81,000, no prior payments), each trying to pay
\$50,000:
- Session A opens a transaction, inserts its \$50,000 payment (acquiring the invoice row lock via
  `validate_payment`'s `FOR UPDATE`), then sleeps 3 seconds before committing.
- Session B starts its own \$50,000 payment ~0.7s later, while A is still open.
- **Result:** Session B blocked for ~2.3 seconds (waiting on A's lock), then — once A committed —
  re-read the balance and correctly rejected itself: `ERROR: Payment exceeds the invoice balance
  (balance due: 31000.00)`. Without the row lock, both sessions could have read the pre-A balance
  concurrently and both succeeded, overpaying the invoice by \$19,000.
