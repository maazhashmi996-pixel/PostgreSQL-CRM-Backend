-- =====================================================================
-- CRM  |  04_views.sql
-- =====================================================================

-- Lead count and potential value by status
CREATE VIEW v_lead_pipeline AS
SELECT s.id AS status_id, s.name AS status_name, s.sort_order, s.color,
       COUNT(l.id)::int AS lead_count,
       COALESCE(SUM(l.estimated_value), 0) AS potential_value,
       COALESCE(ROUND(AVG(l.score), 1), 0) AS avg_score
FROM lead_statuses s
LEFT JOIN leads l ON l.status_id = s.id AND l.deleted_at IS NULL
GROUP BY s.id, s.name, s.sort_order, s.color
ORDER BY s.sort_order;

-- Agent performance
CREATE VIEW v_agent_performance AS
SELECT u.id AS user_id, u.name AS agent_name, u.team_id, t.name AS team_name, r.name AS role_name,
  (SELECT COUNT(*)::int FROM leads l WHERE l.assigned_to = u.id AND l.deleted_at IS NULL) AS assigned_leads,
  (SELECT COUNT(*)::int FROM leads l JOIN lead_statuses s ON s.id = l.status_id
    WHERE l.assigned_to = u.id AND l.deleted_at IS NULL AND s.name <> 'New') AS contacted_leads,
  (SELECT COUNT(*)::int FROM leads l WHERE l.assigned_to = u.id AND l.deleted_at IS NULL AND l.converted_at IS NOT NULL) AS converted_leads,
  (SELECT COUNT(*)::int FROM activities a WHERE a.user_id = u.id AND a.deleted_at IS NULL) AS activities_count,
  (SELECT COUNT(*)::int FROM opportunities o JOIN lead_stages st ON st.id = o.stage_id
    WHERE o.owner_id = u.id AND o.deleted_at IS NULL AND st.name NOT IN ('Closed Won','Closed Lost')) AS open_opportunities,
  COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
             JOIN opportunities o ON o.id = i.opportunity_id
            WHERE o.owner_id = u.id AND p.status = 'successful'), 0) AS revenue
FROM users u
JOIN roles r ON r.id = u.role_id
LEFT JOIN teams t ON t.id = u.team_id
WHERE u.deleted_at IS NULL AND r.name IN ('sales_agent','manager');

-- Customer summary
CREATE VIEW v_customer_summary AS
SELECT c.id AS customer_id, c.customer_code, c.company_name, c.status,
  (SELECT COUNT(*)::int FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL) AS contact_count,
  (SELECT COUNT(*)::int FROM opportunities o WHERE o.customer_id = c.id AND o.deleted_at IS NULL) AS opportunity_count,
  (SELECT COUNT(*)::int FROM invoices i WHERE i.customer_id = c.id AND i.status NOT IN ('draft','cancelled')) AS invoice_count,
  COALESCE((SELECT SUM(total_amount) FROM invoices i WHERE i.customer_id = c.id AND i.status NOT IN ('draft','cancelled')), 0) AS total_invoiced,
  COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
             WHERE p.customer_id = c.id AND p.status = 'successful' AND i.status NOT IN ('draft','cancelled')), 0) AS paid_amount,
  get_customer_balance(c.id) AS outstanding_balance
FROM customers c
WHERE c.deleted_at IS NULL;

-- Open follow-ups whose due date has passed
CREATE VIEW v_overdue_followups AS
SELECT f.id, f.title, f.due_at, f.assigned_to, u.name AS agent_name, u.team_id,
       f.lead_id, l.name AS lead_name, f.customer_id, c.company_name AS customer_name,
       GREATEST(0, (current_date - f.due_at::date))::int AS days_overdue
FROM follow_ups f
JOIN users u ON u.id = f.assigned_to
LEFT JOIN leads l ON l.id = f.lead_id
LEFT JOIN customers c ON c.id = f.customer_id
WHERE f.status = 'open' AND f.deleted_at IS NULL AND f.due_at < now();

-- Monthly invoice / payment totals
CREATE VIEW v_monthly_revenue AS
WITH inv AS (
  SELECT date_trunc('month', issue_date)::date AS month, SUM(total_amount) AS invoiced, COUNT(*)::int AS invoice_count
  FROM invoices WHERE status NOT IN ('draft','cancelled') GROUP BY 1
), pay AS (
  SELECT date_trunc('month', paid_at)::date AS month, SUM(amount) AS collected
  FROM payments WHERE status = 'successful' GROUP BY 1
)
SELECT COALESCE(inv.month, pay.month) AS month,
       COALESCE(inv.invoice_count, 0) AS invoice_count,
       COALESCE(inv.invoiced, 0) AS invoiced,
       COALESCE(pay.collected, 0) AS collected,
       COALESCE(inv.invoiced, 0) - COALESCE(pay.collected, 0) AS net_outstanding_change
FROM inv FULL JOIN pay ON pay.month = inv.month
ORDER BY 1;

-- Stage-wise opportunity count, amount and weighted amount
CREATE VIEW v_sales_funnel AS
SELECT s.id AS stage_id, s.name AS stage_name, s.sort_order, s.probability,
       COUNT(o.id)::int AS opportunity_count,
       COALESCE(SUM(o.amount), 0) AS total_amount,
       COALESCE(ROUND(SUM(o.amount * COALESCE(o.probability, s.probability) / 100.0), 2), 0) AS weighted_amount
FROM lead_stages s
LEFT JOIN opportunities o ON o.stage_id = s.id AND o.deleted_at IS NULL
GROUP BY s.id, s.name, s.sort_order, s.probability
ORDER BY s.sort_order;

-- Lead source performance
CREATE VIEW v_lead_source_performance AS
SELECT src.id AS source_id, src.name AS source_name,
       COUNT(l.id)::int AS total_leads,
       COUNT(l.id) FILTER (WHERE l.converted_at IS NOT NULL)::int AS converted_leads,
       ROUND(100.0 * COUNT(l.id) FILTER (WHERE l.converted_at IS NOT NULL) / NULLIF(COUNT(l.id), 0), 1) AS conversion_rate,
       COALESCE(SUM(l.estimated_value), 0) AS potential_value
FROM lead_sources src
LEFT JOIN leads l ON l.source_id = src.id AND l.deleted_at IS NULL
GROUP BY src.id, src.name;
