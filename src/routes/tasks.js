const express = require('express');
const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, reqStr, optId, date, oneOf } = require('../utils/schemas');

const schema = z.object({
  assigned_to: optId(), lead_id: optId(), customer_id: optId(), title: reqStr(200, 'Title'), description: str(2000),
  priority: oneOf(['low', 'medium', 'high', 'urgent'], 'medium'), due_date: date(), status: oneOf(['todo', 'in_progress', 'completed', 'cancelled'], 'todo'),
});

module.exports = crud({
  table: 'tasks', alias: 't',
  from: `tasks t JOIN users u ON u.id = t.assigned_to JOIN users cb ON cb.id = t.created_by LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN customers c ON c.id = t.customer_id`,
  columns: `t.id, t.assigned_to, u.name AS assigned_name, t.created_by, cb.name AS created_by_name, t.lead_id, l.name AS lead_name,
            t.customer_id, c.company_name AS customer_name, t.title, t.description, t.priority, t.due_date, t.status, t.completed_at, t.created_at,
            (t.status NOT IN ('completed','cancelled') AND t.due_date < current_date) AS is_overdue`,
  create: schema, writable: ['assigned_to', 'lead_id', 'customer_id', 'title', 'description', 'priority', 'due_date', 'status', 'completed_at'],
  searchCols: ['t.title', 't.description'],
  filters: { assigned_to: 't.assigned_to', status: 't.status', priority: 't.priority', lead_id: 't.lead_id', customer_id: 't.customer_id' },
  sortable: { due_date: 't.due_date', priority: `array_position(ARRAY['low','medium','high','urgent'], t.priority)`, created_at: 't.created_at' },
  defaultSort: 't.due_date ASC NULLS LAST',
  scopeCol: 't.assigned_to', ownerField: 'assigned_to', writeRoles: ROLES.write, deleteRoles: ROLES.write,
  hooks: {
    beforeCreate: (d, req) => ({ ...d, assigned_to: d.assigned_to || req.user.id, created_by: req.user.id }),
    beforeUpdate: (d) => { if (d.status === 'completed' && !d.completed_at) d.completed_at = new Date(); if (d.status && d.status !== 'completed') d.completed_at = null; return d; },
  },
});
