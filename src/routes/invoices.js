const express = require('express');
const { query, tx } = require('../db');
const { crud } = require('../utils/crud');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, ROLES } = require('../middleware/auth');
const { z, str, id, optId, money, reqDate, oneOf } = require('../utils/schemas');

const schema = z.object({
  customer_id: id('Customer'), opportunity_id: optId(), issue_date: reqDate('Issue date').optional(),
  due_date: reqDate('Due date'), total_amount: money('Total amount'), status: oneOf(['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled']).optional(), notes: str(2000),
  // optional first payment recorded atomically with the invoice (requirement: "Invoice creation with initial payment should be transactional")
  initial_payment: z.object({ amount: money('Payment amount'), payment_method: oneOf(['cash', 'bank_transfer', 'card', 'cheque', 'online']).optional(), reference: str(100) }).optional(),
});

const FROM = `invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN opportunities o ON o.id = i.opportunity_id LEFT JOIN users u ON u.id = i.created_by`;
const COLUMNS = `i.id, i.invoice_number, i.customer_id, c.company_name AS customer_name, i.opportunity_id, o.title AS opportunity_title,
  i.issue_date, i.due_date, i.total_amount, i.status, i.notes, i.created_by, u.name AS created_by_name, i.created_at,
  COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'successful'), 0) AS paid_amount,
  i.total_amount - COALESCE((SELECT SUM(amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'successful'), 0) AS balance_due`;

const router = express.Router();

router.get('/:id(\\d+)/payments', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT p.id, p.amount, p.payment_method, p.status, p.paid_at, p.reference, p.notes, u.name AS created_by_name
                                   FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.invoice_id = $1 ORDER BY p.paid_at DESC`, [req.params.id]);
  res.json({ data: rows });
}));

router.use(crud({
  table: 'invoices', alias: 'i', from: FROM, columns: COLUMNS, create: schema,
  writable: ['customer_id', 'opportunity_id', 'issue_date', 'due_date', 'total_amount', 'status', 'notes'],
  soft: false, searchCols: ['i.invoice_number'],
  filters: {
    customer_id: 'i.customer_id', status: 'i.status',
    overdue: (q, v) => (v === 'true' ? "i.status = 'overdue'" : 'TRUE'),
  },
  sortable: { issue_date: 'i.issue_date', due_date: 'i.due_date', total_amount: 'i.total_amount', created_at: 'i.created_at' },
  defaultSort: 'i.issue_date DESC, i.id DESC',
  writeRoles: ROLES.write, deleteRoles: ROLES.manage, allowDelete: false,   // financial records: cancel via status, never hard-delete
  hooks: {
    beforeCreate: (d, req) => ({ ...d, created_by: req.user.id }),
    // transactional: invoice + its first payment succeed or fail together (requirement #13)
    afterCreate: async (client, invoiceId, d) => {
      if (d.initial_payment && d.initial_payment.amount > 0) {
        await client.query(
          `INSERT INTO payments (invoice_id, customer_id, amount, payment_method, reference, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [invoiceId, d.customer_id, d.initial_payment.amount, d.initial_payment.payment_method || 'bank_transfer', d.initial_payment.reference || null, d.created_by]);
      }
    },
    beforeUpdate: (d) => { delete d.initial_payment; return d; },
  },
}));

module.exports = router;
