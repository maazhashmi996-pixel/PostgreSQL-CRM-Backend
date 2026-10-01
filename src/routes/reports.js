const express = require('express');
const { query } = require('../db');
const { asyncHandler } = require('../utils/http');
const { authorize, ROLES } = require('../middleware/auth');

const router = express.Router();
router.use(authorize(...ROLES.manage));

// -------------------------------------------------------------------
// Dashboard KPI cards
router.get('/dashboard', asyncHandler(async (req, res) => {
  const [leads, pipeline, followups, revenue] = await Promise.all([
    query(`SELECT count(*)::int AS total,
                  count(*) FILTER (WHERE converted_at IS NULL AND deleted_at IS NULL)::int AS open,
                  count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted
             FROM leads WHERE deleted_at IS NULL OR converted_at IS NOT NULL`),
    query(`SELECT COALESCE(SUM(amount),0) AS pipeline_value FROM opportunities o JOIN lead_stages s ON s.id=o.stage_id
            WHERE o.deleted_at IS NULL AND s.name NOT IN ('Closed Won','Closed Lost')`),
    query(`SELECT count(*)::int AS overdue FROM v_overdue_followups`),
    query(`SELECT COALESCE(SUM(amount),0) AS collected FROM payments WHERE status='successful'`),
  ]);
  res.json({
    total_leads: leads.rows[0].total, open_leads: leads.rows[0].open, converted_leads: leads.rows[0].converted,
    pipeline_value: pipeline.rows[0].pipeline_value, overdue_followups: followups.rows[0].overdue, collected_payments: revenue.rows[0].collected,
  });
}));

// Lead Conversion Report — total/converted/%% by month, source, agent (GROUP BY + FILTER)
router.get('/lead-conversion', asyncHandler(async (req, res) => {
  const [byMonth, bySource, byAgent] = await Promise.all([
    query(`SELECT date_trunc('month', created_at)::date AS month, count(*)::int AS total_leads,
                  count(*) FILTER (WHERE converted_at IS NOT NULL)::int AS converted,
                  round(100.0 * count(*) FILTER (WHERE converted_at IS NOT NULL) / NULLIF(count(*),0), 1) AS conversion_pct
             FROM leads WHERE deleted_at IS NULL OR converted_at IS NOT NULL GROUP BY 1 ORDER BY 1`),
    query('SELECT * FROM v_lead_source_performance ORDER BY total_leads DESC'),
    query(`SELECT u.id, u.name, count(l.id)::int AS total_leads, count(l.id) FILTER (WHERE l.converted_at IS NOT NULL)::int AS converted,
                  round(100.0 * count(l.id) FILTER (WHERE l.converted_at IS NOT NULL) / NULLIF(count(l.id),0), 1) AS conversion_pct
             FROM users u LEFT JOIN leads l ON l.assigned_to = u.id AND (l.deleted_at IS NULL OR l.converted_at IS NOT NULL)
            WHERE u.deleted_at IS NULL GROUP BY u.id, u.name HAVING count(l.id) > 0 ORDER BY converted DESC`),
  ]);
  res.json({ by_month: byMonth.rows, by_source: bySource.rows, by_agent: byAgent.rows });
}));

router.get('/agent-performance', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM v_agent_performance ORDER BY revenue DESC');
  res.json({ data: rows });
}));

router.get('/pipeline', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM v_sales_funnel ORDER BY sort_order');
  res.json({ data: rows });
}));

// Revenue report + cumulative revenue (window function running total)
router.get('/revenue', asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT *, SUM(collected) OVER (ORDER BY month) AS cumulative_collected FROM v_monthly_revenue ORDER BY month`);
  res.json({ data: rows });
}));

router.get('/overdue-followups', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM v_overdue_followups ORDER BY days_overdue DESC');
  res.json({ data: rows });
}));

router.get('/lead-source-performance', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM v_lead_source_performance ORDER BY total_leads DESC');
  res.json({ data: rows });
}));

router.get('/customer-value', asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM v_customer_summary ORDER BY outstanding_balance DESC LIMIT 200');
  res.json({ data: rows });
}));

// Rank agents within each team by converted leads (RANK / DENSE_RANK window functions)
router.get('/agent-ranking', asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT team_name, agent_name, converted_leads,
           RANK() OVER (PARTITION BY team_id ORDER BY converted_leads DESC) AS team_rank,
           DENSE_RANK() OVER (ORDER BY converted_leads DESC) AS overall_rank
    FROM v_agent_performance ORDER BY team_name, team_rank`);
  res.json({ data: rows });
}));
module.exports = router;
