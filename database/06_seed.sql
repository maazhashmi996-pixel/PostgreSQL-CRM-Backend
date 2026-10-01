-- =====================================================================
-- CRM  |  06_seed.sql  |  Realistic, reproducible test data (setseed)
-- Login for every seeded user:  Password@123
-- =====================================================================
SELECT set_config('app.skip_audit', 'on', false);
SELECT setseed(0.42);

INSERT INTO roles (name, description) VALUES
 ('admin',       'Full system access: users, teams, leads, customers, settings and reports'),
 ('manager',     'Team performance, assign leads, manage opportunities and reports'),
 ('sales_agent', 'Manage assigned leads/customers, follow-ups, activities, tasks and opportunities'),
 ('viewer',      'Read-only access to permitted CRM data and reports');

INSERT INTO lead_sources (name, score_weight) VALUES
 ('Website',12),('Referral',28),('Cold Call',6),('Social Media',10),('Email Campaign',14),('Trade Show',20),('Partner',24),('Advertisement',8);

INSERT INTO lead_statuses (name, sort_order, is_final, color) VALUES
 ('New',1,false,'#64748b'),('Contacted',2,false,'#0ea5e9'),('Qualified',3,false,'#8b5cf6'),
 ('Proposal',4,false,'#f59e0b'),('Negotiation',5,false,'#f97316'),('Converted',6,true,'#10b981'),('Lost',7,true,'#ef4444');

INSERT INTO lead_stages (name, probability, sort_order) VALUES
 ('Prospecting',10,1),('Qualification',25,2),('Needs Analysis',40,3),('Proposal',60,4),
 ('Negotiation',80,5),('Closed Won',100,6),('Closed Lost',0,7);

INSERT INTO tags (name, color) VALUES
 ('Hot','#ef4444'),('Enterprise','#6366f1'),('SMB','#0ea5e9'),('Follow Up Needed','#f59e0b'),('Decision Maker','#8b5cf6'),
 ('Budget Approved','#10b981'),('Competitor Involved','#f97316'),('Renewal','#14b8a6'),('Referral Partner','#ec4899'),('VIP','#eab308');

INSERT INTO teams (name, description) VALUES
 ('Alpha Team','Enterprise accounts'),('Beta Team','Small & medium business'),
 ('Gamma Team','Inside sales'),('Delta Team','Partnerships & channels');

-- ---------- helper arrays ----------
CREATE TEMP TABLE seed_arr AS SELECT
  ARRAY['Ali','Ahmed','Sara','Fatima','Usman','Ayesha','Hassan','Zainab','Bilal','Hira','Omar','Maryam','Daniel','Emma','Liam','Olivia','Noah','Sophia','James','Mia','Ethan','Amelia','Lucas','Ella','Hamza','Noor','Imran','Sana','Talha','Iqra'] AS fn,
  ARRAY['Khan','Malik','Sheikh','Butt','Chaudhry','Qureshi','Raza','Siddiqui','Iqbal','Ansari','Smith','Johnson','Brown','Taylor','Wilson','Clark','Lewis','Walker','Hall','Young','Ahmed','Farooq','Hussain','Mirza','Javed','Nawaz','Rehman','Saeed','Baig','Zafar'] AS ln,
  ARRAY['Apex','Nova','Vertex','Blue','Summit','Quantum','Zenith','Pioneer','Crescent','Falcon','Orbit','Nimbus','Titan','Lumen','Vista','Prime','Nexus','Horizon','Atlas','Stellar','Ember','Cobalt','Aurora','Vanguard'] AS cp,
  ARRAY['Technologies','Solutions','Industries','Logistics','Systems','Trading','Consulting','Holdings','Networks','Labs','Enterprises','Digital','Foods','Textiles','Builders','Healthcare'] AS cs,
  ARRAY['Lahore','Karachi','Islamabad','Dubai','Riyadh','London','Toronto','Singapore','Doha','Manchester'] AS city,
  ARRAY['Pakistan','Pakistan','Pakistan','UAE','Saudi Arabia','United Kingdom','Canada','Singapore','Qatar','United Kingdom'] AS country,
  ARRAY['Software','Retail','Manufacturing','Healthcare','Education','Finance','Logistics','Real Estate','Hospitality','Telecom'] AS industry,
  ARRAY['gmail.com','outlook.com','yahoo.com','example.com','mail.com'] AS dom;

CREATE TEMP TABLE seed_h AS SELECT '$2a$10$u0O6xZ8CrrhoabZ7XkNlXuxghhYQbzG0Q5rtsbJyC2VFatNWSKRuy'::text AS h;

-- ---------- users: 1 admin, 4 managers, 14 agents, 2 viewers ----------
INSERT INTO users (role_id, name, email, password_hash, phone, created_at)
SELECT (SELECT id FROM roles WHERE name='admin'), 'Super Admin', 'admin@crm.com', h, '+92 300 1000000', now() - interval '460 days' FROM seed_h;

INSERT INTO users (role_id, team_id, manager_id, name, email, password_hash, phone, created_at)
SELECT (SELECT id FROM roles WHERE name='manager'),
       (SELECT id FROM teams ORDER BY id OFFSET k-1 LIMIT 1),
       (SELECT id FROM users WHERE email='admin@crm.com'),
       a.fn[1 + (k*4) % 30] || ' ' || a.ln[1 + (k*9) % 30], 'manager' || k || '@crm.com', s.h,
       '+92 301 20000' || lpad(k::text, 2, '0'), now() - interval '440 days'
FROM generate_series(1,4) k, seed_arr a, seed_h s;

UPDATE teams t SET manager_id = u.id FROM users u
 WHERE u.team_id = t.id AND u.role_id = (SELECT id FROM roles WHERE name='manager');

INSERT INTO users (role_id, team_id, manager_id, name, email, password_hash, phone, created_at)
SELECT (SELECT id FROM roles WHERE name='sales_agent'), t.id, t.manager_id,
       a.fn[1 + (k*7+3) % 30] || ' ' || a.ln[1 + (k*5+1) % 30], 'agent' || k || '@crm.com', s.h,
       '+92 302 30000' || lpad(k::text, 2, '0'), now() - ((300 + k*7) || ' days')::interval
FROM generate_series(1,14) k, seed_arr a, seed_h s
JOIN LATERAL (SELECT id, manager_id FROM teams ORDER BY id OFFSET 0 LIMIT 4) t ON true
WHERE t.id = (SELECT id FROM teams ORDER BY id OFFSET (k % 4) LIMIT 1);

INSERT INTO users (role_id, name, email, password_hash, phone, created_at)
SELECT (SELECT id FROM roles WHERE name='viewer'), a.fn[1 + (k*11) % 30] || ' ' || a.ln[1 + (k*13) % 30],
       'viewer' || k || '@crm.com', s.h, '+92 303 40000' || k, now() - interval '200 days'
FROM generate_series(1,2) k, seed_arr a, seed_h s;

CREATE TEMP TABLE seed_ids AS SELECT
  (SELECT array_agg(u.id ORDER BY u.id) FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name='sales_agent') AS agents,
  (SELECT array_agg(u.id ORDER BY u.id) FROM users u JOIN roles r ON r.id=u.role_id WHERE r.name IN ('manager','admin')) AS bosses,
  (SELECT array_agg(id ORDER BY id) FROM lead_sources) AS sources;

-- ---------- customers (180) ----------
INSERT INTO customers (company_name, email, phone, address, city, country, industry, website, status, account_owner, notes, created_at)
SELECT a.cp[1 + (i*7) % 24] || ' ' || a.cs[1 + (i*3) % 16],
       'info' || i || '@' || lower(a.cp[1 + (i*7) % 24]) || i || '.com',
       '+92 42 ' || lpad((3000000 + i*137)::text, 7, '0'),
       (10 + i % 90) || ' Business Avenue, Block ' || chr(65 + i % 8),
       a.city[1 + i % 10], a.country[1 + i % 10], a.industry[1 + (i*3) % 10],
       'www.' || lower(a.cp[1 + (i*7) % 24]) || i || '.com',
       CASE WHEN r < 0.82 THEN 'active' WHEN r < 0.88 THEN 'inactive' WHEN r < 0.95 THEN 'prospect' ELSE 'churned' END,
       (SELECT agents FROM seed_ids)[1 + floor(random() * 14)::int],
       CASE WHEN i % 6 = 0 THEN 'Key account - quarterly business review required' WHEN i % 7 = 0 THEN 'Prefers communication over email' END,
       now() - ((random() * 430)::int || ' days')::interval
FROM generate_series(1,180) i, seed_arr a, LATERAL (SELECT random() + 0 * i AS r) x;

-- ---------- contacts (310): 1 primary per customer + extras ----------
INSERT INTO contacts (customer_id, name, email, phone, designation, is_primary, created_at)
SELECT c.id, a.fn[1 + (c.id*3) % 30] || ' ' || a.ln[1 + (c.id*7) % 30], 'primary' || c.id || '@' || split_part(c.email, '@', 2),
       '+92 300 ' || lpad((5000000 + c.id*31)::text, 7, '0'),
       (ARRAY['CEO','CTO','Procurement Manager','Operations Head','Finance Manager','Owner'])[1 + c.id % 6], true, c.created_at
FROM customers c, seed_arr a;

INSERT INTO contacts (customer_id, name, email, phone, designation, is_primary, created_at)
SELECT c.id, a.fn[1 + (g*5) % 30] || ' ' || a.ln[1 + (g*11) % 30], 'contact' || g || '@' || split_part(c.email, '@', 2),
       '+92 321 ' || lpad((6000000 + g*17)::text, 7, '0'),
       (ARRAY['Sales Manager','IT Manager','Accountant','HR Manager','Project Lead'])[1 + g % 5], false, c.created_at + interval '2 days'
FROM generate_series(1,130) g, seed_arr a
JOIN LATERAL (SELECT id, email, created_at FROM customers ORDER BY id OFFSET (g*7) % 180 LIMIT 1) c ON true;

-- ---------- leads (640, incl. ~16 duplicate e-mails) ----------
INSERT INTO leads (source_id, status_id, assigned_to, name, email, phone, company_name, priority, estimated_value, notes, created_at)
SELECT (SELECT sources FROM seed_ids)[1 + floor(random() * 8)::int],
       (SELECT id FROM lead_statuses WHERE name = 'New'),
       (SELECT agents FROM seed_ids)[1 + floor(random() * 14)::int],
       a.fn[1 + (i*7) % 30] || ' ' || a.ln[1 + (i*11) % 30],
       CASE WHEN i % 23 = 0 THEN NULL ELSE 'lead' || k.k || '@' || a.dom[1 + k.k % 5] END,
       CASE WHEN i % 17 = 0 THEN NULL ELSE '+92 3' || lpad((10000000 + (i*7919) % 89999999)::text, 9, '0') END,
       CASE WHEN i % 9 = 0 THEN NULL ELSE a.cp[1 + (i*5) % 24] || ' ' || a.cs[1 + (i*9) % 16] END,
       CASE WHEN r < 0.15 THEN 'low' WHEN r < 0.60 THEN 'medium' WHEN r < 0.90 THEN 'high' ELSE 'urgent' END,
       CASE WHEN i % 13 = 0 THEN 0 ELSE round((500 + random() * random() * 150000)::numeric, 2) END,
       CASE WHEN i % 5 = 0 THEN (ARRAY['Interested in annual plan','Needs a customised demo','Budget approval pending','Comparing with a competitor','Requested pricing sheet'])[1 + i % 5] END,
       now() - ((random() * 430)::int || ' days')::interval - (random() * 20 || ' hours')::interval
FROM generate_series(1,640) i, seed_arr a,
     LATERAL (SELECT CASE WHEN i % 40 = 0 THEN i - 1 ELSE i END AS k) k,
     LATERAL (SELECT random() + 0 * i AS r) x;

CREATE TEMP TABLE seed_lead_target AS
SELECT id, CASE WHEN r < 0.20 THEN 1 WHEN r < 0.40 THEN 2 WHEN r < 0.55 THEN 3 WHEN r < 0.67 THEN 4
                WHEN r < 0.75 THEN 5 WHEN r < 0.90 THEN 6 ELSE 7 END AS target
FROM (SELECT id, random() AS r FROM leads) q;

-- walk every lead through its pipeline so lead_status_history is filled by the trigger
DO $$
DECLARE k int;
BEGIN
  FOR k IN 2..6 LOOP
    UPDATE leads l SET status_id = (SELECT id FROM lead_statuses WHERE sort_order = k)
      FROM seed_lead_target t WHERE t.id = l.id AND t.target >= k AND t.target <= 6;
  END LOOP;
  UPDATE leads l SET status_id = (SELECT id FROM lead_statuses WHERE sort_order = 2)
    FROM seed_lead_target t WHERE t.id = l.id AND t.target = 7 AND l.id % 5 <> 0;
  UPDATE leads l SET status_id = (SELECT id FROM lead_statuses WHERE name = 'Lost')
    FROM seed_lead_target t WHERE t.id = l.id AND t.target = 7;
END $$;

UPDATE leads SET converted_at = LEAST(now() - interval '1 hour', created_at + ((4 + id % 40) || ' days')::interval),
                 converted_customer_id = 1 + (id * 7) % 180
 WHERE status_id = (SELECT id FROM lead_statuses WHERE name = 'Converted');

WITH h AS (
  SELECT x.id, l.created_at, l.assigned_to, row_number() OVER (PARTITION BY x.lead_id ORDER BY x.id) AS rn
  FROM lead_status_history x JOIN leads l ON l.id = x.lead_id)
UPDATE lead_status_history x
   SET changed_at = LEAST(now() - interval '1 minute', h.created_at + ((h.rn - 1) * 4 + x.id % 3) * interval '1 day'),
       changed_by = h.assigned_to
  FROM h WHERE h.id = x.id;

INSERT INTO lead_tags (lead_id, tag_id)
SELECT l.id, t.id FROM leads l JOIN tags t ON ((l.id * 13 + t.id * 7) % 10) < 2;

-- ---------- activities (1300) ----------
INSERT INTO activities (lead_id, user_id, type, subject, notes, activity_at, created_at)
SELECT l.id, l.assigned_to, ty.t,
       CASE ty.t WHEN 'call' THEN (ARRAY['Introductory call','Discovery call','Pricing discussion','Follow-up call'])[1 + g % 4]
                 WHEN 'email' THEN (ARRAY['Sent proposal','Shared product brochure','Requested documents','Sent meeting invite'])[1 + g % 4]
                 WHEN 'meeting' THEN (ARRAY['Product demo','Requirements workshop','On-site visit'])[1 + g % 3]
                 ELSE (ARRAY['Internal note','Client feedback recorded','Budget confirmed'])[1 + g % 3] END,
       CASE WHEN g % 3 = 0 THEN 'Customer was responsive and asked for a follow-up next week.' END,
       l.created_at + random() * (now() - l.created_at), l.created_at + random() * (now() - l.created_at)
FROM generate_series(1,1000) g
CROSS JOIN LATERAL (SELECT (ARRAY['call','call','email','meeting','note','email'])[1 + floor(random()*6)::int + 0 * g] AS t) ty
CROSS JOIN LATERAL (SELECT id, assigned_to, created_at FROM leads ORDER BY id OFFSET floor(random() * 560)::int + 0 * g LIMIT 1) l;

INSERT INTO activities (customer_id, user_id, type, subject, notes, activity_at)
SELECT c.id, COALESCE(c.account_owner, (SELECT agents FROM seed_ids)[1]), ty.t,
       CASE ty.t WHEN 'call' THEN 'Account review call' WHEN 'email' THEN 'Sent renewal quotation' WHEN 'meeting' THEN 'Quarterly business review' ELSE 'Account note' END,
       CASE WHEN g % 4 = 0 THEN 'Discussed upcoming requirements and support tickets.' END,
       c.created_at + random() * (now() - c.created_at)
FROM generate_series(1,300) g
CROSS JOIN LATERAL (SELECT (ARRAY['call','email','meeting','note'])[1 + floor(random()*4)::int + 0 * g] AS t) ty
CROSS JOIN LATERAL (SELECT id, account_owner, created_at FROM customers ORDER BY id OFFSET floor(random() * 180)::int + 0 * g LIMIT 1) c;

-- ---------- follow-ups (600) ----------
INSERT INTO follow_ups (lead_id, customer_id, assigned_to, title, due_at, reminder_at, status, notes, completed_at)
SELECT CASE WHEN g <= 400 THEN o.id END, CASE WHEN g > 400 THEN o.id END, o.owner,
       (ARRAY['Call back','Send quotation','Demo reminder','Check contract status','Payment reminder'])[1 + g % 5],
       d.due,
       CASE WHEN g % 2 = 0 THEN d.due - interval '1 hour' END,
       s.st,
       CASE WHEN g % 4 = 0 THEN 'Customer asked to be contacted after 3 PM.' END,
       CASE WHEN s.st = 'completed' THEN LEAST(now(), d.due + interval '3 hours') END
FROM generate_series(1,600) g
CROSS JOIN LATERAL (
  SELECT CASE WHEN g <= 400 THEN (SELECT l.id FROM leads l ORDER BY id OFFSET floor(random()*640)::int + 0 * g LIMIT 1)
              ELSE (SELECT c.id FROM customers c ORDER BY id OFFSET floor(random()*180)::int + 0 * g LIMIT 1) END AS id,
         CASE WHEN g <= 400 THEN (SELECT agents FROM seed_ids)[1 + floor(random()*14)::int]
              ELSE (SELECT agents FROM seed_ids)[1 + floor(random()*14)::int] END AS owner) o
CROSS JOIN LATERAL (SELECT now() + ((random() * 230 - 200 + 0 * g) || ' days')::interval AS due, random() + 0 * g AS r) d
CROSS JOIN LATERAL (SELECT CASE WHEN d.due < now() THEN (CASE WHEN d.r < 0.55 THEN 'completed' WHEN d.r < 0.70 THEN 'cancelled' ELSE 'open' END)
                                ELSE (CASE WHEN d.r < 0.90 THEN 'open' ELSE 'cancelled' END) END AS st) s;

-- ---------- tasks (300) ----------
INSERT INTO tasks (assigned_to, created_by, lead_id, customer_id, title, description, priority, due_date, status, completed_at, created_at)
SELECT (SELECT agents FROM seed_ids)[1 + floor(random()*14)::int], (SELECT bosses FROM seed_ids)[1 + floor(random()*5)::int],
       CASE WHEN g % 3 = 0 THEN 1 + (g*7) % 640 END, CASE WHEN g % 3 = 1 THEN 1 + (g*5) % 180 END,
       (ARRAY['Prepare proposal','Update CRM records','Send contract draft','Schedule product demo','Collect KYC documents','Review pricing','Prepare monthly report'])[1 + g % 7],
       CASE WHEN g % 2 = 0 THEN 'Please complete before the deadline and update the status.' END,
       (ARRAY['low','medium','medium','high','urgent'])[1 + g % 5], (current_date + ((random()*105 - 60)::int))::date,
       s.st, CASE WHEN s.st = 'completed' THEN now() - ((random()*30)::int || ' days')::interval END,
       now() - ((random()*90)::int || ' days')::interval
FROM generate_series(1,300) g
CROSS JOIN LATERAL (SELECT (ARRAY['todo','in_progress','completed','completed','cancelled'])[1 + floor(random()*5)::int + 0 * g] AS st) s;

-- ---------- products (36) ----------
INSERT INTO products (name, sku, category, description, price, is_active)
SELECT c.name || ' - ' || t.tier, c.code || '-' || upper(left(t.tier, 3)) || '-' || lpad((c.n * 10 + t.n)::text, 3, '0'), c.name,
       t.tier || ' tier of ' || lower(c.name), round(c.base * t.mult, 2), random() > 0.05
FROM (VALUES (1,'Software License','LIC',1200),(2,'Support Plan','SUP',600),(3,'Consulting','CON',2500),
             (4,'Hardware','HRD',900),(5,'Training','TRN',400),(6,'Cloud Hosting','CLD',300)) c(n,name,code,base)
CROSS JOIN (VALUES (1,'Basic',1.0),(2,'Standard',1.6),(3,'Pro',2.4),(4,'Enterprise',4.0),(5,'Premium',5.5),(6,'Custom',7.0)) t(n,tier,mult);

-- ---------- opportunities (240) ----------
INSERT INTO opportunities (customer_id, lead_id, owner_id, stage_id, title, amount, expected_close_date, lost_reason, created_at)
SELECT l.converted_customer_id, l.id, l.assigned_to, st.id, 'Deal - ' || COALESCE(l.company_name, l.name), round((2000 + random()*80000)::numeric, 2),
       (l.converted_at + ((20 + random()*100) || ' days')::interval)::date,
       CASE WHEN st.name = 'Closed Lost' THEN (ARRAY['Price too high','Chose competitor','No budget','Project postponed'])[1 + g % 4] END,
       l.converted_at
FROM generate_series(1,60) g
CROSS JOIN LATERAL (SELECT id, name, company_name, assigned_to, converted_customer_id, converted_at FROM leads
                     WHERE converted_at IS NOT NULL ORDER BY id OFFSET g - 1 LIMIT 1) l
CROSS JOIN LATERAL (SELECT random() + 0 * g AS r) x
JOIN lead_stages st ON st.sort_order = CASE WHEN r<0.15 THEN 1 WHEN r<0.30 THEN 2 WHEN r<0.42 THEN 3 WHEN r<0.54 THEN 4 WHEN r<0.64 THEN 5 WHEN r<0.89 THEN 6 ELSE 7 END;

INSERT INTO opportunities (customer_id, owner_id, stage_id, title, amount, expected_close_date, lost_reason, created_at)
SELECT c.id, COALESCE(c.account_owner, (SELECT agents FROM seed_ids)[1]), st.id,
       (ARRAY['Annual license renewal','Cloud migration','Support contract','Hardware rollout','Staff training programme','CRM integration'])[1 + g % 6] || ' - ' || c.company_name,
       round((2000 + random()*120000)::numeric, 2), (c.created_at + ((30 + random()*300) || ' days')::interval)::date,
       CASE WHEN st.name = 'Closed Lost' THEN (ARRAY['Price too high','Chose competitor','No budget','Project postponed'])[1 + g % 4] END,
       LEAST(now() - interval '2 days', c.created_at + (random() * 300 || ' days')::interval)
FROM generate_series(1,180) g
CROSS JOIN LATERAL (SELECT id, company_name, account_owner, created_at FROM customers ORDER BY id OFFSET floor(random()*180)::int + 0 * g LIMIT 1) c
CROSS JOIN LATERAL (SELECT random() + 0 * g AS r) x
JOIN lead_stages st ON st.sort_order = CASE WHEN r<0.15 THEN 1 WHEN r<0.30 THEN 2 WHEN r<0.42 THEN 3 WHEN r<0.54 THEN 4 WHEN r<0.64 THEN 5 WHEN r<0.89 THEN 6 ELSE 7 END;

UPDATE opportunities SET closed_at = LEAST(now() - interval '1 hour', created_at + ((10 + random()*90) || ' days')::interval)
 WHERE closed_at IS NOT NULL;

INSERT INTO opportunity_products (opportunity_id, product_id, quantity, unit_price, discount)
SELECT o.id, p.id, 1 + floor(random()*9)::int, p.price, (ARRAY[0,0,5,10,15])[1 + floor(random()*5)::int]
FROM opportunities o
CROSS JOIN LATERAL (SELECT id, price FROM products WHERE is_active ORDER BY random() LIMIT 1 + (o.id % 3)) p;

-- ---------- quotes (60) ----------
INSERT INTO quotes (customer_id, opportunity_id, status, valid_until, total_amount, created_by, created_at)
SELECT o.customer_id, o.id, (ARRAY['draft','sent','sent','accepted','rejected','expired'])[1 + floor(random()*6)::int],
       (o.created_at + interval '30 days')::date, o.amount, o.owner_id, o.created_at + interval '2 days'
FROM (SELECT * FROM opportunities ORDER BY random() LIMIT 60) o;

-- ---------- invoices (320) ----------
INSERT INTO invoices (customer_id, opportunity_id, issue_date, due_date, total_amount, status, created_by, created_at)
SELECT q.customer_id, q.opp, q.issue, q.issue + (ARRAY[15,30,45])[1 + q.id % 3], q.total,
       CASE WHEN q.r < 0.03 THEN 'draft' WHEN q.r < 0.07 THEN 'cancelled' ELSE 'sent' END, q.owner, q.issue::timestamptz
FROM (
  SELECT o.id, o.customer_id, o.id AS opp, o.owner_id AS owner, random() AS r,
         LEAST(current_date, (o.created_at + ((5 + random()*40) || ' days')::interval)::date) AS issue,
         GREATEST(o.amount, 500) AS total
  FROM (SELECT * FROM opportunities ORDER BY random() LIMIT 200) o
  UNION ALL
  SELECT 1000 + g, c.id, NULL, (SELECT agents FROM seed_ids)[1 + floor(random()*14)::int], random(),
         (current_date - ((random()*420)::int))::date, round((500 + random()*60000)::numeric, 2)
  FROM generate_series(1,120) g
  CROSS JOIN LATERAL (SELECT id FROM customers ORDER BY id OFFSET floor(random()*180)::int + 0 * g LIMIT 1) c
) q ORDER BY q.issue;

-- ---------- payments: 0 / 2 partial / 3 full / 2 full payments per invoice, plus failed + pending ----------
INSERT INTO payments (invoice_id, customer_id, amount, payment_method, status, paid_at, reference, created_by)
SELECT e.id, e.customer_id,
  CASE e.pat
    WHEN 1 THEN round(e.total_amount * CASE k WHEN 1 THEN 0.5 ELSE 0.2 END, 2)
    WHEN 2 THEN CASE WHEN k < 3 THEN round(e.total_amount * 0.3, 2) ELSE e.total_amount - 2 * round(e.total_amount * 0.3, 2) END
    ELSE CASE WHEN k = 1 THEN round(e.total_amount * 0.5, 2) ELSE e.total_amount - round(e.total_amount * 0.5, 2) END
  END,
  (ARRAY['bank_transfer','card','cash','cheque','online'])[1 + (e.id + k) % 5], 'successful',
  LEAST(now() - interval '1 hour', e.issue_date::timestamptz + ((k*9 + 2 + e.id % 7) * interval '1 day')),
  'PAY-' || e.id || '-' || k, e.created_by
FROM (SELECT i.*, (row_number() OVER (ORDER BY i.id)) % 4 AS pat FROM invoices i WHERE i.status NOT IN ('draft','cancelled')) e
CROSS JOIN LATERAL generate_series(1, CASE e.pat WHEN 0 THEN 0 WHEN 1 THEN 2 WHEN 2 THEN 3 ELSE 2 END) k;

INSERT INTO payments (invoice_id, customer_id, amount, payment_method, status, paid_at, reference, created_by)
SELECT i.id, i.customer_id, round(i.total_amount * 0.25, 2), 'card', CASE WHEN i.id % 2 = 0 THEN 'failed' ELSE 'pending' END,
       LEAST(now(), i.issue_date::timestamptz + interval '6 days'), 'TRY-' || i.id, i.created_by
FROM invoices i WHERE i.status NOT IN ('draft','cancelled') ORDER BY i.id LIMIT 40;

CALL mark_overdue_invoices();

-- ---------- scores, sample audit trail, statistics ----------
UPDATE leads SET score = calculate_lead_score(id);

SELECT set_config('app.skip_audit', 'off', false);
SELECT set_config('app.user_id', (SELECT id::text FROM users WHERE email = 'admin@crm.com'), false);
UPDATE customers SET notes = COALESCE(notes || ' | ', '') || 'Verified by admin' WHERE id % 15 = 0;
UPDATE leads SET priority = 'high' WHERE id % 45 = 0 AND priority <> 'high';
UPDATE products SET price = round(price * 1.05, 2) WHERE id % 9 = 0;
UPDATE users SET phone = phone WHERE false;
SELECT set_config('app.user_id', '', false);

ANALYZE;
