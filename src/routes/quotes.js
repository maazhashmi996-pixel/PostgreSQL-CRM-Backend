const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, id, optId, money, date, oneOf } = require('../utils/schemas');

const schema = z.object({
  customer_id: id('Customer'), opportunity_id: optId(), status: oneOf(['draft', 'sent', 'accepted', 'rejected', 'expired'], 'draft'),
  valid_until: date(), total_amount: money('Total amount').default(0), notes: str(2000),
});

module.exports = crud({
  table: 'quotes', alias: 'q',
  from: `quotes q JOIN customers c ON c.id = q.customer_id LEFT JOIN opportunities o ON o.id = q.opportunity_id LEFT JOIN users u ON u.id = q.created_by`,
  columns: `q.id, q.quote_number, q.customer_id, c.company_name AS customer_name, q.opportunity_id, o.title AS opportunity_title,
            q.status, q.valid_until, q.total_amount, q.notes, q.created_by, u.name AS created_by_name, q.created_at`,
  create: schema, writable: ['customer_id', 'opportunity_id', 'status', 'valid_until', 'total_amount', 'notes', 'created_by'],
  searchCols: ['q.quote_number'], filters: { customer_id: 'q.customer_id', status: 'q.status' },
  sortable: { created_at: 'q.created_at', total_amount: 'q.total_amount' }, defaultSort: 'q.created_at DESC',
  writeRoles: ROLES.write, deleteRoles: ROLES.manage,
  hooks: { beforeCreate: (d, req) => ({ ...d, created_by: req.user.id }) },
});
