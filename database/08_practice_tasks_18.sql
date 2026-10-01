-- =====================================================================
-- CRM | 08_practice_tasks_18.sql
-- Direct 1:1 answers to the 20 numbered "PostgreSQL Practice Tasks" (§18
-- of the requirements doc). 07_practice_queries.sql covers the broader
-- concept list in §8; this file maps each numbered task exactly.
-- =====================================================================

-- 1. Top 10 agents by converted leads
SELECT u.name, COUNT(*) AS converted_leads
FROM leads l JOIN users u ON u.id = l.assigned_to
WHERE l.converted_at IS NOT NULL
GROUP BY u.name ORDER BY converted_leads DESC LIMIT 10;

-- 2. Leads that have never received an activity
SELECT l.id, l.name FROM leads l
WHERE l.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM activities a WHERE a.lead_id = l.id);

-- 3. Customers with no follow-up in the last 30 days
SELECT c.id, c.company_name
FROM customers c
WHERE c.deleted_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM follow_ups f WHERE f.customer_id = c.id AND f.created_at > now() - interval '30 days'
);

-- 4. Agents whose conversion rate is above their team's average
WITH agent_rate AS (
  SELECT u.id, u.team_id, u.name,
    COUNT(l.id) FILTER (WHERE l.converted_at IS NOT NULL)::numeric / NULLIF(COUNT(l.id), 0) AS rate
  FROM users u LEFT JOIN leads l ON l.assigned_to = u.id AND (l.deleted_at IS NULL OR l.converted_at IS NOT NULL)
  WHERE u.deleted_at IS NULL GROUP BY u.id, u.team_id, u.name
), team_avg AS (
  SELECT team_id, AVG(rate) AS avg_rate FROM agent_rate GROUP BY team_id
)
SELECT ar.name, ar.rate, ta.avg_rate
FROM agent_rate ar JOIN team_avg ta ON ta.team_id = ar.team_id
WHERE ar.rate > ta.avg_rate ORDER BY ar.rate DESC;

-- 5. Monthly revenue and month-over-month growth
SELECT month, collected,
  ROUND(100.0 * (collected - LAG(collected) OVER (ORDER BY month)) / NULLIF(LAG(collected) OVER (ORDER BY month), 0), 1) AS mom_growth_pct
FROM v_monthly_revenue ORDER BY month;

-- 6. Cumulative revenue using a window function
SELECT month, collected, SUM(collected) OVER (ORDER BY month) AS cumulative_revenue FROM v_monthly_revenue ORDER BY month;

-- 7. Rank agents within each team by converted leads
SELECT team_name, agent_name, converted_leads, RANK() OVER (PARTITION BY team_id ORDER BY converted_leads DESC) AS team_rank
FROM v_agent_performance ORDER BY team_name, team_rank;

-- 8. Latest activity for every lead using ROW_NUMBER
SELECT lead_id, subject, activity_at FROM (
  SELECT lead_id, subject, activity_at, ROW_NUMBER() OVER (PARTITION BY lead_id ORDER BY activity_at DESC) AS rn
  FROM activities WHERE deleted_at IS NULL AND lead_id IS NOT NULL
) x WHERE rn = 1;

-- 9. Second-highest opportunity amount (two ways)
SELECT amount FROM opportunities WHERE deleted_at IS NULL ORDER BY amount DESC OFFSET 1 LIMIT 1;
SELECT MAX(amount) FROM opportunities WHERE deleted_at IS NULL AND amount < (SELECT MAX(amount) FROM opportunities WHERE deleted_at IS NULL);

-- 10. Duplicate email addresses, keeping the newest record (see also GET /leads/duplicates)
SELECT id, name, email, created_at, keep FROM (
  SELECT id, name, email, created_at,
    ROW_NUMBER() OVER (PARTITION BY lower(email) ORDER BY created_at DESC) = 1 AS keep
  FROM leads WHERE email IS NOT NULL AND deleted_at IS NULL
) x WHERE email IN (SELECT lower(email) FROM leads WHERE email IS NOT NULL GROUP BY lower(email) HAVING COUNT(*) > 1)
ORDER BY email, keep DESC;

-- 11. Customers whose outstanding balance exceeds a selected amount (parameterized via a literal here: $5,000)
SELECT company_name, get_customer_balance(id) AS balance FROM customers
WHERE deleted_at IS NULL AND get_customer_balance(id) > 5000 ORDER BY balance DESC;

-- 12. The most successful lead source for each month (highest conversions that month)
SELECT month, source_name, converted FROM (
  SELECT month, source_name, converted,
    RANK() OVER (PARTITION BY month ORDER BY converted DESC) AS rnk
  FROM (
    SELECT date_trunc('month', l.created_at)::date AS month, s.name AS source_name,
      COUNT(*) FILTER (WHERE l.converted_at IS NOT NULL) AS converted
    FROM leads l JOIN lead_sources s ON s.id = l.source_id
    WHERE l.deleted_at IS NULL OR l.converted_at IS NOT NULL
    GROUP BY 1, s.name
  ) agg
) x WHERE rnk = 1 ORDER BY month;

-- 13. Sales funnel report with weighted pipeline (also exposed as v_sales_funnel)
SELECT * FROM v_sales_funnel ORDER BY sort_order;

-- 14. Recursive query: manager -> employee hierarchy (also get_user_hierarchy())
WITH RECURSIVE tree AS (
  SELECT id, name, manager_id, 0 AS depth, name::text AS path FROM users WHERE manager_id IS NULL AND deleted_at IS NULL
  UNION ALL
  SELECT u.id, u.name, u.manager_id, t.depth + 1, t.path || ' > ' || u.name FROM users u JOIN tree t ON u.manager_id = t.id WHERE u.deleted_at IS NULL
)
SELECT * FROM tree ORDER BY path;

-- 15. CTE-based multi-step customer report (invoiced, paid, outstanding, open pipeline in one query)
WITH invoiced AS (
  SELECT customer_id, SUM(total_amount) AS total_invoiced FROM invoices WHERE status NOT IN ('draft','cancelled') GROUP BY customer_id
), paid AS (
  SELECT i.customer_id, SUM(p.amount) AS total_paid FROM payments p JOIN invoices i ON i.id = p.invoice_id
  WHERE p.status = 'successful' GROUP BY i.customer_id
), pipeline AS (
  SELECT customer_id, SUM(amount) AS open_pipeline FROM opportunities o JOIN lead_stages s ON s.id = o.stage_id
  WHERE o.deleted_at IS NULL AND s.name NOT IN ('Closed Won','Closed Lost') GROUP BY customer_id
)
SELECT c.company_name, COALESCE(i.total_invoiced,0) AS invoiced, COALESCE(p.total_paid,0) AS paid,
       COALESCE(i.total_invoiced,0) - COALESCE(p.total_paid,0) AS outstanding, COALESCE(pl.open_pipeline,0) AS open_pipeline
FROM customers c LEFT JOIN invoiced i ON i.customer_id = c.id LEFT JOIN paid p ON p.customer_id = c.id LEFT JOIN pipeline pl ON pl.customer_id = c.id
WHERE c.deleted_at IS NULL ORDER BY outstanding DESC LIMIT 20;

-- 16. EXPLAIN ANALYZE before/after an index — see docs/OPTIMIZATION.md for 5 full documented experiments.
-- (kept out of this file since it requires DROP/CREATE INDEX side effects; run separately.)

-- 17. UPSERT for lead source and tag data
INSERT INTO lead_sources (name, score_weight) VALUES ('Webinar', 15)
  ON CONFLICT (name) DO UPDATE SET score_weight = EXCLUDED.score_weight;
INSERT INTO tags (name, color) VALUES ('Renewal Risk', '#ef4444')
  ON CONFLICT (name) DO UPDATE SET color = EXCLUDED.color;

-- 18. Transaction that converts a lead and creates related records (also convert_lead() PL/pgSQL function)
-- BEGIN;
--   SELECT * FROM convert_lead(<lead_id>, <acting_user_id>);
-- COMMIT;
SELECT prosrc FROM pg_proc WHERE proname = 'convert_lead';  -- shows the function's transactional body

-- 19. Trigger that records lead status history (already active — trg_leads_status_history_ins / _upd)
SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname LIKE 'trg_leads_status_history%';

-- 20. Function returning a customer's complete financial summary (also get_customer_financial_summary())
SELECT * FROM get_customer_financial_summary(1);
