const express = require('express');
const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, reqStr, id, optId, oneOf } = require('../utils/schemas');
const { ApiError } = require('../utils/http');

const schema = z.object({
  lead_id: optId(), customer_id: optId(), type: oneOf(['call', 'meeting', 'email', 'note', 'other']),
  subject: reqStr(200, 'Subject'), notes: str(2000), activity_at: z.coerce.date().optional(),
});

module.exports = crud({
  table: 'activities', alias: 'a',
  from: `activities a JOIN users u ON u.id = a.user_id LEFT JOIN leads l ON l.id = a.lead_id LEFT JOIN customers c ON c.id = a.customer_id`,
  columns: `a.id, a.lead_id, l.name AS lead_name, a.customer_id, c.company_name AS customer_name, a.user_id, u.name AS user_name,
            a.type, a.subject, a.notes, a.activity_at, a.created_at`,
  create: schema, writable: ['lead_id', 'customer_id', 'type', 'subject', 'notes', 'activity_at', 'user_id'],
  searchCols: ['a.subject', 'a.notes'], filters: { lead_id: 'a.lead_id', customer_id: 'a.customer_id', type: 'a.type', user_id: 'a.user_id' },
  sortable: { activity_at: 'a.activity_at', created_at: 'a.created_at' }, defaultSort: 'a.activity_at DESC',
  scopeCol: 'a.user_id', ownerField: 'user_id', writeRoles: ROLES.write, deleteRoles: ROLES.write,
  hooks: {
    beforeCreate: async (d, req) => {
      if (!d.lead_id && !d.customer_id) throw new ApiError(422, 'An activity needs a lead or a customer', { lead_id: 'Required' });
      return { ...d, user_id: d.user_id || req.user.id };
    },
  },
});
