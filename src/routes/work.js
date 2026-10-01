// Activities, follow-ups, tasks
const express = require('express');
const { crud } = require('../utils/crud');
const { asyncHandler, ApiError } = require('../utils/http');
const { tx, query } = require('../db');
const { authorize, ROLES } = require('../middleware/auth');
const { z, str, reqStr, optId, oneOf, reqDate, date } = require('../utils/schemas');

const target = (d) => { if (!d.lead_id && !d.customer_id) throw new ApiError(422, 'Select a lead or a customer', { lead_id: 'Select a lead or a customer' }); };

// ---------- activities ----------
const activities = crud({
  table: 'activities', alias: 'a',
  from: `activities a JOIN users u ON u.id = a.user_id LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN customers c ON c.id = a.customer_id`,
  columns: `a.id, a.lead_id, l.name AS lead_name, a.customer_id, c.company_name AS customer_name, a.user_id, u.name AS user_name,
            a.type, a.subject, a.notes, a.activity_at, a.created_at`,
  create: z.object({ lead_id: optId(), customer_id: optId(), type: oneOf(['call', 'meeting', 'email', 'note', 'other']), subject: reqStr(200, 'Subject'), notes: str(4000), activity_at: date() }),
  writable: ['lead_id', 'customer_id', 'user_id', 'type', 'subject', 'notes', 'activity_at'],
  searchCols: ['a.subject', 'a.notes', 'l.name', 'c.company_name'],
  filters: { lead_id: 'a.lead_id', customer_id: 'a.customer_id', user_id: 'a.user_id', type: 'a.type',
             from: (q, v) => `a.activity_at >= ${q.add(v)}::date`, to: (q, v) => `a.activity_at < (${q.add(v)}::date + 1)` },
  sortable: { activity_at: 'a.activity_at', type: 'a.type', subject: 'a.subject' }, defaultSort: 'a.activity_at DESC, a.id DESC',
  scopeCol: 'a.user_id',
  hooks: { beforeCreate: async (d, req) => { target(d); return { ...d, user_id: req.user.id, activity_at: d.activity_at || new Date().toISOString() }; } },
});

// ---------- follow-ups ----------
const followSchema = z.object({
  lead_id: optId(), customer_id: optId(), assigned_to: optId(), title: reqStr(200, 'Title').default('Follow-up'),
  due_at: reqDate('Due date'), reminder_at: date(), status: oneOf(['open', 'completed', 'cancelled'], 'open'), notes: str(2000),
});
const followUps = crud({
  table: 'follow_ups', alias: 'f',
  from: `follow_ups f JOIN users u ON u.id = f.assigned_to LEFT JOIN leads l ON l.id = f.lead_id LEFT JOIN customers c ON c.id = f.customer_id`,
  columns: `f.id, f.title, f.lead_id, l.name AS lead_name, f.customer_id, c.company_name AS customer_name, f.assigned_to, u.name AS assigned_name,
            f.due_at, f.reminder_at, f.status, f.notes, f.completed_at, (f.status = 'open' AND f.due_at < now()) AS is_overdue, f.created_at`,
  create: followSchema, searchCols: ['f.title', 'f.notes', 'l.name', 'c.company_name'],
  filters: { status: 'f.status', assigned_to: 'f.assigned_to', lead_id: 'f.lead_id', customer_id: 'f.customer_id',
             overdue: (q, v) => (v === 'true' ? `(f.status = 'open' AND f.due_at < now())` : 'TRUE'),
             from: (q, v) => `f.due_at >= ${q.add(v)}::date`, to: (q, v) => `f.due_at < (${q.add(v)}::date + 1)` },
  sortable: { due_at: 'f.due_at', status: 'f.status', assigned: 'u.name' }, defaultSort: 'f.due_at ASC, f.id',
  scopeCol: 'f.assigned_to', ownerField: 'assigned_to', maxLimit: 500,
  hooks: {
    beforeCreate: async (d, req) => { target(d); return { ...d, assigned_to: d.assigned_to || req.user.id, completed_at: d.status === 'completed' ? new Date().toISOString() : null }; },
    beforeUpdate: async (d) => (d.status ? { ...d, completed_at: d.status === 'completed' ? new Date().toISOString() : null } : d),
  },
});

// ---------- tasks ----------
const taskSchema = z.object({
  title: reqStr(200, 'Title'), description: str(2000), assigned_to: optId(), lead_id: optId(), customer_id: optId(),
  priority: oneOf(['low', 'medium', 'high', 'urgent'], 'medium'), due_date: date(), status: oneOf(['todo', 'in_progress', 'completed', 'cancelled'], 'todo'),
});
const tasks = crud({
  table: 'tasks', alias: 't',
  from: `tasks t JOIN users a ON a.id = t.assigned_to JOIN users cb ON cb.id = t.created_by LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN customers c ON c.id = t.customer_id`,
  columns: `t.id, t.title, t.description, t.priority, t.due_date, t.status, t.completed_at, t.assigned_to, a.name AS assigned_name,
            t.created_by, cb.name AS created_by_name, t.lead_id, l.name AS lead_name, t.customer_id, c.company_name AS customer_name,
            (t.status IN ('todo','in_progress') AND t.due_date < current_date) AS is_overdue, t.created_at`,
  create: taskSchema, writable: ['title', 'description', 'assigned_to', 'created_by', 'lead_id', 'customer_id', 'priority', 'due_date', 'status', 'completed_at'],
  searchCols: ['t.title', 't.description', 'l.name', 'c.company_name'],
  filters: { status: 't.status', priority: 't.priority', assigned_to: 't.assigned_to', lead_id: 't.lead_id', customer_id: 't.customer_id',
             overdue: (q, v) => (v === 'true' ? `(t.status IN ('todo','in_progress') AND t.due_date < current_date)` : 'TRUE') },
  sortable: { due_date: 't.due_date', priority: `array_position(ARRAY['low','medium','high','urgent'], t.priority)`, status: 't.status', title: 't.title' },
  defaultSort: 't.due_date ASC NULLS LAST, t.id DESC', scopeCol: 't.assigned_to', ownerField: 'assigned_to', maxLimit: 300, deleteRoles: ROLES.write,
  hooks: {
    beforeCreate: async (d, req) => ({ ...d, created_by: req.user.id, assigned_to: d.assigned_to || req.user.id, completed_at: d.status === 'completed' ? new Date().toISOString() : null }),
    beforeUpdate: async (d) => (d.status ? { ...d, completed_at: d.status === 'completed' ? new Date().toISOString() : null } : d),
  },
});

// quick status change endpoints used by the UI
const quick = express.Router();
quick.post('/follow-ups/:id(\\d+)/complete', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const r = await tx(req.user.id, (c) => c.query(
    `UPDATE follow_ups SET status = 'completed', completed_at = now() WHERE id = $1 AND deleted_at IS NULL AND ($2 <> 'sales_agent' OR assigned_to = $3) RETURNING id`,
    [req.params.id, req.user.role, req.user.id]));
  if (!r.rowCount) throw new ApiError(404, 'Follow-up not found');
  res.json({ message: 'Follow-up completed' });
}));

module.exports = { activities, followUps, tasks, quick };
