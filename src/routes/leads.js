const express = require('express');
const { query, tx } = require('../db');
const { crud } = require('../utils/crud');
const { Q } = require('../utils/query');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, scopeSql, ROLES } = require('../middleware/auth');
const { z, str, reqStr, email, id, optId, money, oneOf } = require('../utils/schemas');

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const leadSchema = z.object({
  name: reqStr(150, 'Lead name'), email: email(), phone: str(30), company_name: str(200),
  source_id: id('Source'), status_id: optId(), assigned_to: optId(),
  priority: oneOf(PRIORITIES, 'medium'), estimated_value: money('Estimated value').default(0), notes: str(2000),
  tag_ids: z.array(z.coerce.number().int().positive()).max(20).optional(),
});

const FROM = `leads l JOIN lead_sources ls ON ls.id = l.source_id JOIN lead_statuses st ON st.id = l.status_id JOIN users u ON u.id = l.assigned_to`;
const COLUMNS = `l.id, l.name, l.email, l.phone, l.company_name, l.priority, l.estimated_value, l.score, l.notes,
  l.source_id, ls.name AS source_name, l.status_id, st.name AS status_name, st.color AS status_color, st.is_final AS status_is_final,
  l.assigned_to, u.name AS assigned_name, u.team_id, l.converted_customer_id, l.converted_at, l.created_at, l.updated_at,
  (SELECT COALESCE(json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) ORDER BY t.name), '[]'::json)
     FROM lead_tags lt JOIN tags t ON t.id = lt.tag_id WHERE lt.lead_id = l.id) AS tags`;

async function setTags(client, leadId, tagIds) {
  await client.query('DELETE FROM lead_tags WHERE lead_id = $1', [leadId]);
  if (tagIds.length) {
    await client.query('INSERT INTO lead_tags (lead_id, tag_id) SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING', [leadId, [...new Set(tagIds)]]);
  }
}
const refreshScore = (client, leadId) => client.query('UPDATE leads SET score = calculate_lead_score(id) WHERE id = $1', [leadId]);

const router = express.Router();

async function getLead(runner, leadId, req) {
  const q = new Q();
  const where = [`l.id = ${q.add(leadId)}`, 'l.deleted_at IS NULL'];
  const sc = scopeSql(req.user, q, 'l.assigned_to');
  if (sc) where.push(sc);
  return (await runner.query(`SELECT ${COLUMNS} FROM ${FROM} WHERE ${where.join(' AND ')}`, q.params)).rows[0];
}

// ---- duplicate e-mails (window functions) ----
router.get('/duplicates', authorize(...ROLES.manage), asyncHandler(async (req, res) => {
  const { rows } = await query(`
    SELECT * FROM (
      SELECT l.id, l.name, l.email, l.created_at, u.name AS assigned_name,
             COUNT(*) OVER (PARTITION BY lower(l.email)) AS copies,
             ROW_NUMBER() OVER (PARTITION BY lower(l.email) ORDER BY l.created_at DESC) AS rn
        FROM leads l JOIN users u ON u.id = l.assigned_to
       WHERE l.deleted_at IS NULL AND l.email IS NOT NULL) d
    WHERE copies > 1 ORDER BY lower(email), rn`);
  res.json({ data: rows.map((r) => ({ ...r, keep: r.rn === 1 })) });
}));

// ---- bulk import with controlled transaction + SAVEPOINTs ----
router.post('/import', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const { rows: input, mode } = z.object({
    rows: z.array(z.record(z.any())).min(1, 'No rows to import').max(1000, 'Maximum 1000 rows per import'),
    mode: z.enum(['partial', 'atomic']).default('partial'),
  }).parse(req.body);

  const result = await tx(req.user.id, async (client) => {
    const [srcs, sts, usrs] = await Promise.all([
      client.query('SELECT id, lower(name) AS k FROM lead_sources'),
      client.query('SELECT id, lower(name) AS k FROM lead_statuses'),
      client.query('SELECT id, lower(email) AS k FROM users WHERE deleted_at IS NULL AND is_active'),
    ]);
    const map = (r) => new Map(r.rows.map((x) => [x.k, x.id]));
    const srcMap = map(srcs), stMap = map(sts), userMap = map(usrs);
    const newId = stMap.get('new');
    let inserted = 0; const errors = [];

    for (let i = 0; i < input.length; i++) {
      const raw = input[i]; const sp = `sp_${i}`;
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const d = leadSchema.parse({
          ...raw,
          source_id: raw.source_id || srcMap.get(String(raw.source || '').toLowerCase()),
          status_id: raw.status_id || stMap.get(String(raw.status || '').toLowerCase()) || newId,
          assigned_to: req.user.role === 'sales_agent' ? req.user.id : (raw.assigned_to || userMap.get(String(raw.assigned_to_email || '').toLowerCase()) || req.user.id),
        });
        if (d.status_id === stMap.get('converted')) throw new ApiError(422, 'Cannot import leads as Converted');
        const r = await client.query(
          `INSERT INTO leads (name, email, phone, company_name, source_id, status_id, assigned_to, priority, estimated_value, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [d.name, d.email ?? null, d.phone ?? null, d.company_name ?? null, d.source_id, d.status_id, d.assigned_to, d.priority, d.estimated_value, d.notes ?? null]);
        await refreshScore(client, r.rows[0].id);
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        inserted++;
      } catch (e) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        const message = e.issues ? e.issues.map((x) => `${x.path.join('.') || 'row'}: ${x.message}`).join('; ')
          : (e instanceof ApiError || e.code === 'CR001') ? e.message
          : e.code === '23503' ? 'Invalid source / status / user reference' : 'Row could not be saved';
        errors.push({ row: i + 1, message });
      }
    }
    if (mode === 'atomic' && errors.length) {
      throw new ApiError(422, `Import cancelled - ${errors.length} invalid row(s). Nothing was saved.`, errors);
    }
    return { inserted, failed: errors.length, errors };
  });
  res.status(201).json(result);
}));

// ---- bulk assignment ----
router.post('/bulk-assign', authorize(...ROLES.manage), asyncHandler(async (req, res) => {
  const b = z.object({ lead_ids: z.array(z.coerce.number().int().positive()).min(1).max(500), assigned_to: id('Agent') }).parse(req.body);
  const updated = await tx(req.user.id, async (client) => {
    const target = await client.query('SELECT id FROM users WHERE id = $1 AND is_active AND deleted_at IS NULL', [b.assigned_to]);
    if (!target.rowCount) throw new ApiError(422, 'Selected user is not active');
    const q = new Q();
    const where = [`id = ANY(${q.add(b.lead_ids)}::bigint[])`, 'deleted_at IS NULL'];
    const sc = scopeSql(req.user, q, 'assigned_to');
    if (sc) where.push(sc);
    const r = await client.query(`UPDATE leads SET assigned_to = ${q.add(b.assigned_to)} WHERE ${where.join(' AND ')}`, q.params);
    return r.rowCount;
  });
  res.json({ message: `${updated} lead(s) reassigned`, updated });
}));

// ---- lead detail (profile, activities, follow-ups, tags, status history) ----
router.get('/:id(\\d+)', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const lead = await getLead({ query }, req.params.id, req);
  if (!lead) throw new ApiError(404, 'Lead not found');
  const lid = lead.id;
  const [activities, followUps, history, tasks, opps] = await Promise.all([
    query(`SELECT a.id, a.type, a.subject, a.notes, a.activity_at, a.user_id, u.name AS user_name
             FROM activities a JOIN users u ON u.id = a.user_id
            WHERE a.lead_id = $1 AND a.deleted_at IS NULL ORDER BY a.activity_at DESC LIMIT 100`, [lid]),
    query(`SELECT f.id, f.title, f.due_at, f.reminder_at, f.status, f.notes, f.completed_at, f.assigned_to, u.name AS assigned_name,
                  (f.status = 'open' AND f.due_at < now()) AS is_overdue
             FROM follow_ups f JOIN users u ON u.id = f.assigned_to
            WHERE f.lead_id = $1 AND f.deleted_at IS NULL ORDER BY f.due_at DESC`, [lid]),
    query(`SELECT h.id, os.name AS old_status, ns.name AS new_status, ns.color AS new_color, u.name AS changed_by_name, h.changed_at
             FROM lead_status_history h LEFT JOIN lead_statuses os ON os.id = h.old_status_id
             JOIN lead_statuses ns ON ns.id = h.new_status_id LEFT JOIN users u ON u.id = h.changed_by
            WHERE h.lead_id = $1 ORDER BY h.changed_at DESC, h.id DESC`, [lid]),
    query(`SELECT t.id, t.title, t.priority, t.status, t.due_date, u.name AS assigned_name
             FROM tasks t JOIN users u ON u.id = t.assigned_to WHERE t.lead_id = $1 AND t.deleted_at IS NULL ORDER BY t.due_date NULLS LAST`, [lid]),
    query(`SELECT o.id, o.title, o.amount, s.name AS stage_name FROM opportunities o JOIN lead_stages s ON s.id = o.stage_id
            WHERE o.lead_id = $1 AND o.deleted_at IS NULL`, [lid]),
  ]);
  res.json({ data: lead, activities: activities.rows, follow_ups: followUps.rows, status_history: history.rows, tasks: tasks.rows, opportunities: opps.rows });
}));

router.put('/:id(\\d+)/tags', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const { tag_ids } = z.object({ tag_ids: z.array(z.coerce.number().int().positive()).max(20) }).parse(req.body);
  const lead = await tx(req.user.id, async (client) => {
    const l = await getLead(client, req.params.id, req);
    if (!l) throw new ApiError(404, 'Lead not found');
    await setTags(client, l.id, tag_ids);
    return getLead(client, l.id, req);
  });
  res.json({ data: lead });
}));

router.post('/:id(\\d+)/convert', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const out = await tx(req.user.id, async (client) => {
    const l = await getLead(client, req.params.id, req);
    if (!l) throw new ApiError(404, 'Lead not found');
    const r = await client.query('SELECT * FROM convert_lead($1, $2)', [l.id, req.user.id]);   // atomic PL/pgSQL conversion
    return r.rows[0];
  });
  res.status(201).json({ message: 'Lead converted successfully', customer_id: out.new_customer_id, contact_id: out.new_contact_id, opportunity_id: out.new_opportunity_id });
}));

router.post('/:id(\\d+)/recalculate-score', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const lead = await tx(req.user.id, async (client) => {
    const l = await getLead(client, req.params.id, req);
    if (!l) throw new ApiError(404, 'Lead not found');
    await refreshScore(client, l.id);
    return getLead(client, l.id, req);
  });
  res.json({ data: lead });
}));

// ---- generic list / create / update / delete ----
router.use(crud({
  table: 'leads', alias: 'l', from: FROM, columns: COLUMNS, create: leadSchema,
  writable: ['name', 'email', 'phone', 'company_name', 'source_id', 'status_id', 'assigned_to', 'priority', 'estimated_value', 'notes'],
  searchCols: ['l.name', 'l.email', 'l.phone', 'l.company_name'],
  filters: {
    status_id: 'l.status_id', source_id: 'l.source_id', assigned_to: 'l.assigned_to', priority: 'l.priority', team_id: 'u.team_id',
    tag_id: (q, v) => `EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ${q.add(v)})`,
    converted: (q, v) => (v === 'true' ? 'l.converted_at IS NOT NULL' : 'l.converted_at IS NULL'),
    open: (q, v) => (v === 'true' ? 'st.is_final = false' : 'TRUE'),
    created_from: (q, v) => `l.created_at >= ${q.add(v)}::date`,
    created_to: (q, v) => `l.created_at < (${q.add(v)}::date + 1)`,
    min_score: (q, v) => `l.score >= ${q.add(v)}`,
  },
  sortable: { name: 'l.name', created_at: 'l.created_at', score: 'l.score', value: 'l.estimated_value', priority: `array_position(ARRAY['low','medium','high','urgent'], l.priority)`, status: 'st.sort_order', assigned: 'u.name' },
  defaultSort: 'l.created_at DESC, l.id DESC',
  scopeCol: 'l.assigned_to', ownerField: 'assigned_to', writeRoles: ROLES.write, deleteRoles: ROLES.manage,
  hooks: {
    beforeCreate: async (d, req, client) => {
      const out = { ...d };
      if (!out.status_id) out.status_id = (await client.query("SELECT id FROM lead_statuses WHERE name = 'New'")).rows[0].id;
      if (!out.assigned_to) out.assigned_to = req.user.id;
      const conv = (await client.query("SELECT id FROM lead_statuses WHERE name = 'Converted'")).rows[0].id;
      if (out.status_id === conv) throw new ApiError(422, 'A new lead cannot start as Converted', { status_id: 'Invalid status' });
      return out;
    },
    afterCreate: async (client, leadId, d) => { if (d.tag_ids) await setTags(client, leadId, d.tag_ids); await refreshScore(client, leadId); },
    beforeUpdate: async (d, req, client, existing) => {
      if (d.status_id !== undefined && d.status_id !== null) {
        const conv = (await client.query("SELECT id FROM lead_statuses WHERE name = 'Converted'")).rows[0].id;
        if (d.status_id === conv && !existing.converted_at)
          throw new ApiError(422, 'Use the "Convert lead" action to convert a lead', { status_id: 'Use the Convert action' });
        if (existing.converted_at && d.status_id !== conv)
          throw new ApiError(422, 'A converted lead cannot move back to another status', { status_id: 'Lead is already converted' });
      }
      return d;
    },
    afterUpdate: async (client, leadId, d) => { if (d.tag_ids) await setTags(client, leadId, d.tag_ids); await refreshScore(client, leadId); },
  },
}));

module.exports = router;
