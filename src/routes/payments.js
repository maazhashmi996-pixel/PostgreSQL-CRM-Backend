const express = require('express');
const { crud } = require('../utils/crud');
const { ROLES } = require('../middleware/auth');
const { z, str, id, money, oneOf } = require('../utils/schemas');

const schema = z.object({
  invoice_id: id('Invoice'), amount: money('Amount').refine((v) => v > 0, 'Amount must be greater than zero'),
  payment_method: oneOf(['cash', 'bank_transfer', 'card', 'cheque', 'online'], 'bank_transfer'),
  status: oneOf(['successful', 'pending', 'failed', 'refunded'], 'successful'),
  reference: str(100), notes: str(500),
});

// customer_id is derived server-side (trigger validate_payment) from the invoice - never trust the client for it
module.exports = crud({
  table: 'payments', alias: 'p',
  from: `payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.created_by`,
  columns: `p.id, p.invoice_id, i.invoice_number, p.customer_id, c.company_name AS customer_name, p.amount, p.payment_method,
            p.status, p.paid_at, p.reference, p.notes, p.created_by, u.name AS created_by_name, p.created_at`,
  create: schema, writable: ['invoice_id', 'amount', 'payment_method', 'status', 'reference', 'notes'],
  soft: false, searchCols: ['p.reference'], filters: { invoice_id: 'p.invoice_id', customer_id: 'p.customer_id', status: 'p.status', payment_method: 'p.payment_method' },
  sortable: { paid_at: 'p.paid_at', amount: 'p.amount' }, defaultSort: 'p.paid_at DESC',
  writeRoles: ROLES.write, deleteRoles: ROLES.manage, allowDelete: false, allowUpdate: true,
  hooks: { beforeCreate: (d, req) => ({ ...d, created_by: req.user.id }) },
  // Business rule (payment cannot exceed invoice balance) is enforced by the `validate_payment` PostgreSQL trigger,
  // which locks the invoice row (FOR UPDATE) so concurrent payments cannot both slip past the check.
});
