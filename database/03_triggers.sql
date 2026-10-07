-- =====================================================================

-- =====================================================================

-- 1) Updated timestamp -------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','teams','leads','customers','contacts','follow_ups','tasks',
                           'products','opportunities','quotes','invoices']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t, t);
  END LOOP;
END $$;

-- 2) Lead status history -------------------------------------------------
CREATE FUNCTION log_lead_status_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lead_status_history (lead_id, old_status_id, new_status_id, changed_by, changed_at)
    VALUES (NEW.id, NULL, NEW.status_id, current_app_user(), NEW.created_at);
  ELSIF NEW.status_id IS DISTINCT FROM OLD.status_id THEN
    INSERT INTO lead_status_history (lead_id, old_status_id, new_status_id, changed_by)
    VALUES (NEW.id, OLD.status_id, NEW.status_id, current_app_user());
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leads_status_history_ins AFTER INSERT ON leads
  FOR EACH ROW EXECUTE FUNCTION log_lead_status_change();
CREATE TRIGGER trg_leads_status_history_upd AFTER UPDATE OF status_id ON leads
  FOR EACH ROW WHEN (OLD.status_id IS DISTINCT FROM NEW.status_id) EXECUTE FUNCTION log_lead_status_change();

-- 3) Generic audit log (INSERT / UPDATE / SOFT_DELETE / DELETE) ---------------
--    The API sets  app.user_id  inside each transaction: SELECT set_config('app.user_id', '42', true)
--    Set  app.skip_audit = 'on'  for bulk loads (e.g. seed data).
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_old jsonb; v_new jsonb; v_action text; v_id bigint;
  v_noise text[] := ARRAY['updated_at','score','search_vector','last_login_at','password_hash'];
BEGIN
  IF current_setting('app.skip_audit', true) = 'on' THEN RETURN COALESCE(NEW, OLD); END IF;

  IF TG_OP = 'INSERT' THEN
    v_new := to_jsonb(NEW) - 'search_vector' - 'password_hash'; v_action := 'INSERT'; v_id := (v_new->>'id')::bigint;
  ELSIF TG_OP = 'DELETE' THEN
    v_old := to_jsonb(OLD) - 'search_vector' - 'password_hash'; v_action := 'DELETE'; v_id := (v_old->>'id')::bigint;
  ELSE
    v_old := to_jsonb(OLD) - 'search_vector' - 'password_hash';
    v_new := to_jsonb(NEW) - 'search_vector' - 'password_hash';
    IF (to_jsonb(OLD) - v_noise) = (to_jsonb(NEW) - v_noise) THEN RETURN NEW; END IF;   -- ignore noise-only updates
    v_action := CASE WHEN (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN 'SOFT_DELETE' ELSE 'UPDATE' END;
    v_id := (v_new->>'id')::bigint;
  END IF;

  INSERT INTO audit_logs (user_id, table_name, record_id, action, old_data, new_data)
  VALUES (current_app_user(), TG_TABLE_NAME, v_id, v_action, v_old, v_new);
  RETURN COALESCE(NEW, OLD);
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','teams','leads','customers','contacts','tasks','opportunities',
                           'products','quotes','invoices','payments']
  LOOP
    EXECUTE format('CREATE TRIGGER trg_%s_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t, t);
  END LOOP;
END $$;

-- 4) Payment validation (business rule: total successful payments can never exceed the invoice) ----
CREATE FUNCTION validate_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i invoices%ROWTYPE; v_paid numeric;
BEGIN
  SELECT * INTO i FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;    -- lock: serialises concurrent payments
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found' USING ERRCODE = 'CR001'; END IF;
  IF i.status IN ('draft','cancelled') THEN
    RAISE EXCEPTION 'Cannot record a payment against a % invoice', i.status USING ERRCODE = 'CR001';
  END IF;
  NEW.customer_id := i.customer_id;

  IF NEW.status = 'successful' THEN
    SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments
     WHERE invoice_id = NEW.invoice_id AND status = 'successful' AND id IS DISTINCT FROM NEW.id;
    IF v_paid + NEW.amount > i.total_amount THEN
      RAISE EXCEPTION 'Payment exceeds the invoice balance (balance due: %)', (i.total_amount - v_paid)
        USING ERRCODE = 'CR001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_payments_validate BEFORE INSERT OR UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_payment();

-- 5) Keep invoice status in sync with payments ---------------------------------
CREATE FUNCTION sync_invoice_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM recalc_invoice_status(COALESCE(NEW.invoice_id, OLD.invoice_id));
  RETURN NULL;
END $$;
CREATE TRIGGER trg_payments_sync_invoice AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION sync_invoice_status();

-- ...and stop the invoice total being lowered below what is already paid
CREATE FUNCTION guard_invoice_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_paid numeric;
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_paid FROM payments WHERE invoice_id = NEW.id AND status = 'successful';
  IF NEW.total_amount < v_paid THEN
    RAISE EXCEPTION 'Invoice total cannot be lower than the amount already paid (%)', v_paid USING ERRCODE = 'CR001';
  END IF;
  IF NEW.status = 'cancelled' AND v_paid > 0 THEN
    RAISE EXCEPTION 'Cannot cancel an invoice that already has payments' USING ERRCODE = 'CR001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE OF total_amount, status ON invoices
  FOR EACH ROW EXECUTE FUNCTION guard_invoice_total();

-- 6) Opportunity total from its products -----------------------------------------
CREATE FUNCTION refresh_opportunity_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_opp bigint := COALESCE(NEW.opportunity_id, OLD.opportunity_id); v_total numeric; v_cnt int;
BEGIN
  SELECT COALESCE(SUM(quantity * unit_price * (1 - discount / 100)), 0), COUNT(*) INTO v_total, v_cnt
    FROM opportunity_products WHERE opportunity_id = v_opp;
  UPDATE opportunities SET products_total = ROUND(v_total, 2),
                           amount = CASE WHEN v_cnt > 0 THEN ROUND(v_total, 2) ELSE amount END
   WHERE id = v_opp;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_opp_products_total AFTER INSERT OR UPDATE OR DELETE ON opportunity_products
  FOR EACH ROW EXECUTE FUNCTION refresh_opportunity_total();

-- 7) Opportunity stage -> probability / closed_at --------------------------------
CREATE FUNCTION sync_opportunity_stage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s lead_stages%ROWTYPE;
BEGIN
  SELECT * INTO s FROM lead_stages WHERE id = NEW.stage_id;
  IF TG_OP = 'INSERT' OR NEW.stage_id IS DISTINCT FROM OLD.stage_id THEN
    IF NEW.probability IS NULL OR TG_OP = 'UPDATE' THEN NEW.probability := s.probability; END IF;
    IF s.name IN ('Closed Won','Closed Lost') THEN NEW.closed_at := COALESCE(NEW.closed_at, now());
    ELSE NEW.closed_at := NULL; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_opportunities_stage BEFORE INSERT OR UPDATE OF stage_id ON opportunities
  FOR EACH ROW EXECUTE FUNCTION sync_opportunity_stage();

-- 8) Lead score refresh when an activity is logged ---------------------------------
CREATE FUNCTION refresh_lead_score() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lead_id IS NOT NULL THEN
    UPDATE leads SET score = calculate_lead_score(NEW.lead_id) WHERE id = NEW.lead_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER trg_activities_score AFTER INSERT ON activities
  FOR EACH ROW EXECUTE FUNCTION refresh_lead_score();
