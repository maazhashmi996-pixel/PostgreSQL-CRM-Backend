const express = require('express');
const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, reqStr, optId, oneOf } = require('../utils/schemas');
const { ApiError } = require('../utils/http');

const schema = z.object({
  lead_id: optId(), customer_id: optId(), assigned_to: optId(), title: str(200),
  due_at: z.coerce.date({ required_error: 'Due date is required', invalid_type_error: 'Invalid due date' }),
  reminder_at: z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable().optional()),
  status: oneOf(['open', 'completed', 'cancelled'], 'open'), notes: str(2000),
});

module.exports = crud({
  table: 'follow_ups', alias: 'f',
  from: `follow_ups f JOIN users u ON u.id = f.assigned_to LEFT JOIN leads l ON l.id = f.lead_id LEFT JOIN customers c ON c.id = f.customer_id`,
  columns: `f.id, f.lead_id, l.name AS lead_name, f.customer_id, c.company_name AS customer_name, f.assigned_to, u.name AS assigned_name,
            f.title, f.due_at, f.reminder_at, f.status, f.notes, f.completed_at, f.created_at,
            (f.status = 'open' AND f.due_at < now()) AS is_overdue`,
  create: schema, writable: ['lead_id', 'customer_id', 'assigned_to', 'title', 'due_at', 'reminder_at', 'status', 'notes', 'completed_at'],
  searchCols: ['f.title', 'f.notes'],
  filters: {
    lead_id: 'f.lead_id', customer_id: 'f.customer_id', assigned_to: 'f.assigned_to', status: 'f.status',
    overdue: (q, v) => (v === 'true' ? "f.status = 'open' AND f.due_at < now()" : 'TRUE'),
    due_from: (q, v) => `f.due_at >= ${q.add(v)}`, due_to: (q, v) => `f.due_at <= ${q.add(v)}`,
  },
  sortable: { due_at: 'f.due_at', created_at: 'f.created_at' }, defaultSort: 'f.due_at ASC',
  scopeCol: 'f.assigned_to', ownerField: 'assigned_to', writeRoles: ROLES.write, deleteRoles: ROLES.write,
  hooks: {
    beforeCreate: (d) => { if (!d.lead_id && !d.customer_id) throw new ApiError(422, 'A follow-up needs a lead or a customer', { lead_id: 'Required' }); },
    beforeUpdate: (d) => { if (d.status === 'completed' && !d.completed_at) d.completed_at = new Date(); if (d.status && d.status !== 'completed') d.completed_at = null; return d; },
  },
});
