
CREATE FUNCTION current_app_user() RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::bigint
$$;

CREATE FUNCTION calculate_lead_score(p_lead_id bigint) RETURNS int
LANGUAGE plpgsql STABLE AS $$
DECLARE
  l leads%ROWTYPE;
  v_src int := 0; v_status int := 0; v_act int := 0; v_profile int := 0; v_value int := 0;
  v_status_name text; v_sort int;
BEGIN
  SELECT * INTO l FROM leads WHERE id = p_lead_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT score_weight INTO v_src FROM lead_sources WHERE id = l.source_id;
  SELECT name, sort_order INTO v_status_name, v_sort FROM lead_statuses WHERE id = l.status_id;

  v_status := CASE WHEN v_status_name = 'Lost' THEN 0 ELSE LEAST(v_sort * 4, 24) END;
  SELECT LEAST(COUNT(*) * 4, 24) INTO v_act FROM activities WHERE lead_id = p_lead_id AND deleted_at IS NULL;
  v_profile := (CASE WHEN l.email IS NOT NULL AND l.email <> '' THEN 6 ELSE 0 END)
             + (CASE WHEN l.phone IS NOT NULL AND l.phone <> '' THEN 6 ELSE 0 END)
             + (CASE WHEN l.company_name IS NOT NULL AND l.company_name <> '' THEN 6 ELSE 0 END)
             + (CASE WHEN l.estimated_value > 0 THEN 6 ELSE 0 END);
  v_value := CASE WHEN l.estimated_value >= 100000 THEN 10 WHEN l.estimated_value >= 50000 THEN 6
                  WHEN l.estimated_value >= 10000 THEN 3 ELSE 0 END;

  RETURN LEAST(100, COALESCE(v_src,0) + v_status + v_act + v_profile + v_value);
END $$;

CREATE FUNCTION get_customer_balance(p_customer_id bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT SUM(total_amount) FROM invoices
                    WHERE customer_id = p_customer_id AND status NOT IN ('draft','cancelled')), 0)
       - COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
                    WHERE p.customer_id = p_customer_id AND p.status = 'successful'
                      AND i.status NOT IN ('draft','cancelled')), 0)
$$;

CREATE FUNCTION get_overdue_amount(p_customer_id bigint) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(GREATEST(i.total_amount - paid.amount, 0)), 0)
  FROM invoices i
  CROSS JOIN LATERAL (
    SELECT COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'successful'), 0) AS amount
    FROM payments p WHERE p.invoice_id = i.id
  ) paid
  WHERE i.customer_id = p_customer_id
    AND i.status NOT IN ('draft','cancelled','paid')
    AND i.due_date < current_date
$$;

CREATE FUNCTION get_customer_financial_summary(p_customer_id bigint)
RETURNS TABLE (
  invoice_count int, total_invoiced numeric, total_paid numeric, outstanding numeric,
  overdue_amount numeric, last_payment_at timestamptz, open_pipeline_value numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    (SELECT COUNT(*)::int FROM invoices WHERE customer_id = p_customer_id AND status NOT IN ('draft','cancelled')),
    COALESCE((SELECT SUM(total_amount) FROM invoices WHERE customer_id = p_customer_id AND status NOT IN ('draft','cancelled')), 0),
    COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
               WHERE p.customer_id = p_customer_id AND p.status = 'successful' AND i.status NOT IN ('draft','cancelled')), 0),
    get_customer_balance(p_customer_id),
    get_overdue_amount(p_customer_id),
    (SELECT MAX(paid_at) FROM payments WHERE customer_id = p_customer_id AND status = 'successful'),
    COALESCE((SELECT SUM(o.amount) FROM opportunities o JOIN lead_stages s ON s.id = o.stage_id
               WHERE o.customer_id = p_customer_id AND o.deleted_at IS NULL
                 AND s.name NOT IN ('Closed Won','Closed Lost')), 0)
$$;

CREATE FUNCTION get_agent_monthly_stats(p_user_id bigint, p_month date DEFAULT current_date)
RETURNS TABLE (
  month date, leads_created int, leads_contacted int, leads_converted int, activities_count int,
  opportunities_created int, opportunities_won int, revenue_collected numeric, overdue_followups int
) LANGUAGE sql STABLE AS $$
  WITH m AS (SELECT date_trunc('month', p_month)::date AS start_d,
                    (date_trunc('month', p_month) + interval '1 month')::date AS end_d)
  SELECT m.start_d,
    (SELECT COUNT(*)::int FROM leads l WHERE l.assigned_to = p_user_id AND l.deleted_at IS NULL
        AND l.created_at >= m.start_d AND l.created_at < m.end_d),
    (SELECT COUNT(DISTINCT a.lead_id)::int FROM activities a JOIN leads l ON l.id = a.lead_id
      WHERE l.assigned_to = p_user_id AND a.deleted_at IS NULL AND a.activity_at >= m.start_d AND a.activity_at < m.end_d),
    (SELECT COUNT(*)::int FROM leads l WHERE l.assigned_to = p_user_id AND l.deleted_at IS NULL
        AND l.converted_at >= m.start_d AND l.converted_at < m.end_d),
    (SELECT COUNT(*)::int FROM activities a WHERE a.user_id = p_user_id AND a.deleted_at IS NULL
        AND a.activity_at >= m.start_d AND a.activity_at < m.end_d),
    (SELECT COUNT(*)::int FROM opportunities o WHERE o.owner_id = p_user_id AND o.deleted_at IS NULL
        AND o.created_at >= m.start_d AND o.created_at < m.end_d),
    (SELECT COUNT(*)::int FROM opportunities o JOIN lead_stages s ON s.id = o.stage_id
      WHERE o.owner_id = p_user_id AND o.deleted_at IS NULL AND s.name = 'Closed Won'
        AND o.closed_at >= m.start_d AND o.closed_at < m.end_d),
    COALESCE((SELECT SUM(p.amount) FROM payments p JOIN invoices i ON i.id = p.invoice_id
               JOIN opportunities o ON o.id = i.opportunity_id
              WHERE o.owner_id = p_user_id AND p.status = 'successful'
                AND p.paid_at >= m.start_d AND p.paid_at < m.end_d), 0),
    (SELECT COUNT(*)::int FROM follow_ups f WHERE f.assigned_to = p_user_id AND f.deleted_at IS NULL
        AND f.status = 'open' AND f.due_at < now())
  FROM m
$$;

CREATE FUNCTION get_user_hierarchy(p_root bigint DEFAULT NULL)
RETURNS TABLE (id bigint, name varchar, role_name varchar, manager_id bigint, depth int, path text)
LANGUAGE sql STABLE AS $$
  WITH RECURSIVE tree AS (
    SELECT u.id, u.name, r.name AS role_name, u.manager_id, 0 AS depth, u.name::text AS path
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.deleted_at IS NULL AND ((p_root IS NULL AND u.manager_id IS NULL) OR u.id = p_root)
    UNION ALL
    SELECT c.id, c.name, r.name, c.manager_id, t.depth + 1, t.path || ' > ' || c.name
    FROM users c JOIN roles r ON r.id = c.role_id JOIN tree t ON c.manager_id = t.id
    WHERE c.deleted_at IS NULL AND t.depth < 10
  )
  SELECT * FROM tree ORDER BY path
$$;

-- 7) Transaction-based lead conversion (runs atomically: any failure rolls everything back)
CREATE FUNCTION convert_lead(p_lead_id bigint, p_user_id bigint)
RETURNS TABLE (new_customer_id bigint, new_contact_id bigint, new_opportunity_id bigint)
LANGUAGE plpgsql AS $$
DECLARE
  l leads%ROWTYPE;
  v_cust bigint; v_contact bigint; v_opp bigint;
  v_status int; v_stage int; v_prob smallint;
BEGIN
  PERFORM set_config('app.user_id', p_user_id::text, true);

  SELECT * INTO l FROM leads WHERE id = p_lead_id AND deleted_at IS NULL FOR UPDATE;   -- row lock
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found' USING ERRCODE = 'CR001'; END IF;
  IF l.converted_at IS NOT NULL THEN RAISE EXCEPTION 'Lead is already converted' USING ERRCODE = 'CR001'; END IF;

  SELECT id INTO v_status FROM lead_statuses WHERE name = 'Converted';
  SELECT id, probability INTO v_stage, v_prob FROM lead_stages ORDER BY sort_order LIMIT 1;

  -- reuse an existing customer with the same email, otherwise create one
  IF l.email IS NOT NULL THEN
    SELECT id INTO v_cust FROM customers WHERE lower(email) = lower(l.email) AND deleted_at IS NULL;
  END IF;
  IF v_cust IS NULL THEN
    INSERT INTO customers (company_name, email, phone, status, account_owner)
    VALUES (COALESCE(NULLIF(l.company_name, ''), l.name), l.email, l.phone, 'active', l.assigned_to)
    RETURNING id INTO v_cust;
  END IF;

  IF l.email IS NOT NULL THEN
    SELECT id INTO v_contact FROM contacts WHERE customer_id = v_cust AND lower(email) = lower(l.email) AND deleted_at IS NULL;
  END IF;
  IF v_contact IS NULL THEN
    INSERT INTO contacts (customer_id, name, email, phone, is_primary)
    VALUES (v_cust, l.name, l.email, l.phone,
            NOT EXISTS (SELECT 1 FROM contacts WHERE customer_id = v_cust AND is_primary AND deleted_at IS NULL))
    RETURNING id INTO v_contact;
  END IF;

  INSERT INTO opportunities (customer_id, lead_id, owner_id, stage_id, title, amount, expected_close_date)
  VALUES (v_cust, l.id, l.assigned_to, v_stage, 'Opportunity - ' || COALESCE(NULLIF(l.company_name, ''), l.name),
          l.estimated_value, current_date + 30)
  RETURNING id INTO v_opp;

  UPDATE leads SET status_id = v_status, converted_customer_id = v_cust, converted_at = now() WHERE id = l.id;
  UPDATE leads SET score = calculate_lead_score(id) WHERE id = l.id;

  INSERT INTO activities (lead_id, customer_id, user_id, type, subject, notes)
  VALUES (l.id, v_cust, p_user_id, 'note', 'Lead converted to customer', 'Customer, contact and opportunity created automatically.');

  RETURN QUERY SELECT v_cust, v_contact, v_opp;
END $$;

-- 8) Recompute invoice status from its payments (used by triggers)
CREATE FUNCTION recalc_invoice_status(p_invoice_id bigint) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE i invoices%ROWTYPE; v_paid numeric; v_new varchar;
BEGIN
  SELECT * INTO i FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND OR i.status IN ('draft','cancelled') THEN RETURN; END IF;
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments WHERE invoice_id = p_invoice_id AND status = 'successful';
  -- paid > overdue (past due & not fully paid) > partial > sent
  v_new := CASE
    WHEN v_paid >= i.total_amount AND i.total_amount > 0 THEN 'paid'
    WHEN i.due_date < current_date THEN 'overdue'
    WHEN v_paid > 0 THEN 'partial'
    ELSE 'sent' END;
  IF v_new <> i.status THEN UPDATE invoices SET status = v_new WHERE id = p_invoice_id; END IF;
END $$;

-- 9) Nightly maintenance helper: mark unpaid invoices as overdue
CREATE PROCEDURE mark_overdue_invoices()
LANGUAGE sql AS $$
  UPDATE invoices SET status = 'overdue' WHERE status IN ('sent','partial') AND due_date < current_date
$$;
