-- =====================================================================
-- CRM  |  05_indexes.sql   (see docs/OPTIMIZATION.md for EXPLAIN ANALYZE experiments)
-- =====================================================================

-- Foreign keys frequently used in joins
CREATE INDEX idx_users_role        ON users (role_id);
CREATE INDEX idx_users_team        ON users (team_id);
CREATE INDEX idx_users_manager     ON users (manager_id);
CREATE INDEX idx_teams_manager     ON teams (manager_id);
CREATE INDEX idx_contacts_customer ON contacts (customer_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_customers_owner   ON customers (account_owner);
CREATE INDEX idx_opp_products_prod ON opportunity_products (product_id);
CREATE INDEX idx_invoices_customer ON invoices (customer_id);
CREATE INDEX idx_invoices_opp      ON invoices (opportunity_id);
CREATE INDEX idx_payments_invoice  ON payments (invoice_id);
CREATE INDEX idx_payments_customer ON payments (customer_id);
CREATE INDEX idx_quotes_customer   ON quotes (customer_id);
CREATE INDEX idx_lead_tags_tag     ON lead_tags (tag_id);
CREATE INDEX idx_lsh_lead          ON lead_status_history (lead_id, changed_at);

-- Leads: assigned_to, status_id, source_id, created_at (all partial: live rows only)
CREATE INDEX idx_leads_assigned    ON leads (assigned_to, status_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_status      ON leads (status_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_source      ON leads (source_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_created     ON leads (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_leads_email       ON leads (lower(email));
CREATE INDEX idx_leads_fts         ON leads USING gin (search_vector);
CREATE INDEX idx_customers_fts     ON customers USING gin (search_vector);

-- Activities
CREATE INDEX idx_activities_lead     ON activities (lead_id, activity_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_activities_customer ON activities (customer_id, activity_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_activities_user     ON activities (user_id, activity_at DESC);

-- Follow-ups: assigned_to + status + due_at, plus partial index for the "open" queue
CREATE INDEX idx_followups_owner_status_due ON follow_ups (assigned_to, status, due_at);
CREATE INDEX idx_followups_open_due  ON follow_ups (due_at) WHERE status = 'open' AND deleted_at IS NULL;
CREATE INDEX idx_followups_lead      ON follow_ups (lead_id);
CREATE INDEX idx_followups_customer  ON follow_ups (customer_id);

-- Tasks / opportunities
CREATE INDEX idx_tasks_owner_status  ON tasks (assigned_to, status, due_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_opp_owner_stage_close ON opportunities (owner_id, stage_id, expected_close_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_opp_customer        ON opportunities (customer_id);

-- Finance
CREATE INDEX idx_invoices_open_due   ON invoices (due_date) WHERE status IN ('sent','partial','overdue');
CREATE INDEX idx_payments_paid_at    ON payments (paid_at) WHERE status = 'successful';

-- Audit
CREATE INDEX idx_audit_record        ON audit_logs (table_name, record_id);
CREATE INDEX idx_audit_created       ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_user          ON audit_logs (user_id);
