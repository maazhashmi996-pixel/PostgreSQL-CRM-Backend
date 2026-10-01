-- =====================================================================
-- CRM | 07_practice_queries.sql
-- 30+ advanced SQL practice queries, grouped by concept (requirement #21).
-- Every query runs as-is against the seeded database.
-- =====================================================================

-- ============ JOINS ============

-- 1. INNER JOIN: leads with their source and current status
SELECT l.name, ls.name AS source, st.name AS status
FROM leads l JOIN lead_sources ls ON ls.id = l.source_id JOIN lead_statuses st ON st.id = l.status_id
LIMIT 20;

-- 2. LEFT JOIN: every customer with its opportunity count (0 if none)
SELECT c.company_name, COUNT(o.id) AS opportunity_count
FROM customers c LEFT JOIN opportunities o ON o.customer_id = c.id AND o.deleted_at IS NULL
GROUP BY c.company_name ORDER BY opportunity_count DESC LIMIT 20;

-- 3. RIGHT JOIN: every role with its users (roles with 0 users still appear)
SELECT r.name AS role, u.name AS user_name
FROM users u RIGHT JOIN roles r ON r.id = u.role_id ORDER BY r.name;

-- 4. SELF JOIN: agents and their managers
SELECT a.name AS agent, m.name AS manager
FROM users a JOIN users m ON m.id = a.manager_id ORDER BY m.name;

-- 5. Multi-table join: leads -> users -> teams -> activities
SELECT l.name AS lead, u.name AS agent, t.name AS team, COUNT(a.id) AS activity_count
FROM leads l JOIN users u ON u.id = l.assigned_to LEFT JOIN teams t ON t.id = u.team_id
LEFT JOIN activities a ON a.lead_id = l.id AND a.deleted_at IS NULL
WHERE l.deleted_at IS NULL GROUP BY l.name, u.name, t.name ORDER BY activity_count DESC LIMIT 20;

-- ============ GROUP BY / HAVING ============

-- 6. Agents with more than 30 assigned leads
SELECT u.name, COUNT(*) AS lead_count FROM leads l JOIN users u ON u.id = l.assigned_to
WHERE l.deleted_at IS NULL GROUP BY u.name HAVING COUNT(*) > 30 ORDER BY lead_count DESC;

-- 7. Lead sources with a conversion rate above 10%
SELECT src.name, COUNT(l.id) AS total, COUNT(l.id) FILTER (WHERE l.converted_at IS NOT NULL) AS converted
FROM lead_sources src LEFT JOIN leads l ON l.source_id = src.id
GROUP BY src.name HAVING COUNT(l.id) FILTER (WHERE l.converted_at IS NOT NULL) > 0.1 * NULLIF(COUNT(l.id), 0);

-- ============ CASE EXPRESSIONS ============

-- 8. Lead value bucketed into categories for reporting
SELECT name, estimated_value,
  CASE WHEN estimated_value >= 50000 THEN 'Enterprise' WHEN estimated_value >= 10000 THEN 'Mid-Market' WHEN estimated_value > 0 THEN 'SMB' ELSE 'Unqualified' END AS segment
FROM leads WHERE deleted_at IS NULL ORDER BY estimated_value DESC LIMIT 20;

-- 9. Score category via CASE (mirrors the calculate_lead_score() function's output ranges)
SELECT name, score, CASE WHEN score >= 70 THEN 'Hot' WHEN score >= 40 THEN 'Warm' ELSE 'Cold' END AS temperature
FROM leads WHERE deleted_at IS NULL ORDER BY score DESC LIMIT 20;

-- ============ SUBQUERIES / CORRELATED SUBQUERIES ============

-- 10. Customers whose outstanding balance is above the average (subquery)
SELECT company_name, get_customer_balance(id) AS balance FROM customers
WHERE get_customer_balance(id) > (SELECT AVG(get_customer_balance(id)) FROM customers WHERE deleted_at IS NULL)
ORDER BY balance DESC LIMIT 20;

-- 11. Correlated subquery: leads with more activities than their assigned agent's average
SELECT l.name, (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id) AS activity_count
FROM leads l WHERE l.deleted_at IS NULL
  AND (SELECT COUNT(*) FROM activities a WHERE a.lead_id = l.id)
    > (SELECT AVG(cnt) FROM (SELECT COUNT(*) cnt FROM activities a2 WHERE a2.user_id = l.assigned_to GROUP BY a2.lead_id) x)
LIMIT 20;

-- ============ CTEs ============

-- 12. WITH query: this month's new leads and their current stage in one readable step
WITH this_month AS (SELECT * FROM leads WHERE date_trunc('month', created_at) = date_trunc('month', now()) AND deleted_at IS NULL)
SELECT st.name AS status, COUNT(*) FROM this_month l JOIN lead_statuses st ON st.id = l.status_id GROUP BY st.name;

-- 13. Multi-step CTE: top 5 customers by revenue this year
WITH yearly_payments AS (
  SELECT p.customer_id, SUM(p.amount) AS total FROM payments p WHERE p.status = 'successful' AND date_part('year', p.paid_at) = date_part('year', now()) GROUP BY p.customer_id
)
SELECT c.company_name, yp.total FROM yearly_payments yp JOIN customers c ON c.id = yp.customer_id ORDER BY yp.total DESC LIMIT 5;

-- 14. Recursive CTE: full manager -> agent hierarchy (also exposed as get_user_hierarchy())
WITH RECURSIVE tree AS (
  SELECT id, name, manager_id, 0 AS depth, name::text AS path FROM users WHERE manager_id IS NULL AND deleted_at IS NULL
  UNION ALL
  SELECT u.id, u.name, u.manager_id, t.depth + 1, t.path || ' > ' || u.name FROM users u JOIN tree t ON u.manager_id = t.id WHERE u.deleted_at IS NULL
)
SELECT * FROM tree ORDER BY path;

-- ============ WINDOW FUNCTIONS ============

-- 15. ROW_NUMBER: most recent activity per lead
SELECT * FROM (SELECT lead_id, subject, activity_at, ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY activity_at DESC) AS rn FROM activities WHERE deleted_at IS NULL) x WHERE rn = 1 LIMIT 20;

-- 16. RANK / DENSE_RANK: agents ranked by converted leads within their team (also v_agent_performance based)
SELECT team_name, agent_name, converted_leads, RANK() OVER (PARTITION BY team_id ORDER BY converted_leads DESC) AS team_rank
FROM v_agent_performance ORDER BY team_name, team_rank;

-- 17. LAG/LEAD: month-over-month revenue change
SELECT month, collected, LAG(collected) OVER (ORDER BY month) AS prev_month, collected - LAG(collected) OVER (ORDER BY month) AS change
FROM v_monthly_revenue ORDER BY month;

-- 18. Running total (window frame): cumulative revenue collected
SELECT month, collected, SUM(collected) OVER (ORDER BY month ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM v_monthly_revenue ORDER BY month;

-- 19. Duplicate detection with COUNT() OVER (PARTITION BY): leads sharing the same email
SELECT * FROM (
  SELECT id, name, email, COUNT(*) OVER (PARTITION BY lower(email)) AS copies FROM leads WHERE email IS NOT NULL AND deleted_at IS NULL
) x WHERE copies > 1 ORDER BY email;

-- ============ FILTER clause (conditional aggregation) ============

-- 20. One pass, several conditional counts (used by the Lead Conversion report)
SELECT date_trunc('month', created_at)::date AS month,
  COUNT(*) AS total, COUNT(*) FILTER (WHERE priority = 'urgent') AS urgent, COUNT(*) FILTER (WHERE converted_at IS NOT NULL) AS converted
FROM leads WHERE deleted_at IS NULL OR converted_at IS NOT NULL GROUP BY 1 ORDER BY 1;

-- ============ DATE_TRUNC reporting ============

-- 21. Daily activity volume, last 30 days
SELECT date_trunc('day', activity_at)::date AS day, COUNT(*) FROM activities WHERE activity_at > now() - interval '30 days' GROUP BY 1 ORDER BY 1;

-- 22. Weekly new-lead volume
SELECT date_trunc('week', created_at)::date AS week, COUNT(*) FROM leads WHERE deleted_at IS NULL GROUP BY 1 ORDER BY 1 DESC LIMIT 12;

-- 23. Monthly invoiced vs collected (also v_monthly_revenue)
SELECT date_trunc('month', issue_date)::date AS month, SUM(total_amount) FROM invoices WHERE status NOT IN ('draft','cancelled') GROUP BY 1 ORDER BY 1;

-- ============ COALESCE / NULL handling ============

-- 24. Leads missing contact info, defaulted for a clean export
SELECT name, COALESCE(email, 'no-email-on-file') AS email, COALESCE(phone, 'no-phone-on-file') AS phone FROM leads WHERE deleted_at IS NULL LIMIT 20;

-- ============ EXISTS / NOT EXISTS ============

-- 25. Leads that have never had an activity logged (a "cold" queue for managers)
SELECT l.id, l.name FROM leads l WHERE l.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id) LIMIT 20;

-- 26. Customers that do have at least one overdue invoice
SELECT c.company_name FROM customers c WHERE EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'overdue') LIMIT 20;

-- ============ UPSERT (INSERT ... ON CONFLICT) ============

-- 27. Idempotent tag assignment (skip if the lead already has the tag)
INSERT INTO lead_tags (lead_id, tag_id) VALUES (1, 1) ON CONFLICT (lead_id, tag_id) DO NOTHING;

-- 28. Upsert an opportunity_product line (used by PUT /opportunities/:id/products)
INSERT INTO opportunity_products (opportunity_id, product_id, quantity, unit_price, discount) VALUES (1, 1, 2, 500, 0)
ON CONFLICT (opportunity_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price;

-- ============ RETURNING clause ============

-- 29. Insert and get the generated id + customer_code back in one round trip
INSERT INTO customers (company_name, status) VALUES ('Practice Query Co', 'prospect') RETURNING id, customer_code, created_at;

-- ============ JSONB ============

-- 30. Inspect what changed on the most recent audit entry for a table
SELECT table_name, action, old_data - 'updated_at' AS old_values, new_data - 'updated_at' AS new_values, created_at
FROM audit_logs WHERE table_name = 'customers' ORDER BY created_at DESC LIMIT 5;

-- 31. JSONB containment: audit entries where the new status became 'Lost'
SELECT * FROM audit_logs WHERE table_name = 'leads' AND new_data @> '{}'::jsonb AND (new_data->>'status_id') IS NOT NULL LIMIT 5;

-- ============ ARRAY operations ============

-- 32. Aggregate a customer's contact emails into one array
SELECT c.company_name, array_agg(ct.email) FILTER (WHERE ct.email IS NOT NULL) AS contact_emails
FROM customers c LEFT JOIN contacts ct ON ct.customer_id = c.id AND ct.deleted_at IS NULL GROUP BY c.company_name LIMIT 10;

-- 33. Filter leads by an array of tag ids (ANY)
SELECT DISTINCT l.name FROM leads l JOIN lead_tags lt ON lt.lead_id = l.id WHERE lt.tag_id = ANY(ARRAY[1,2,3]) LIMIT 20;

-- ============ Full-text search ============

-- 34. Full-text search across lead name/company/notes (GIN index: idx_leads_fts)
SELECT name, company_name, ts_rank(search_vector, query) AS rank
FROM leads, to_tsquery('simple', 'budget:*') query WHERE search_vector @@ query ORDER BY rank DESC LIMIT 10;

-- 35. Full-text search on customers
SELECT company_name, city FROM customers, plainto_tsquery('simple', 'technologies') query WHERE search_vector @@ query LIMIT 10;
