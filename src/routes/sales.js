// Opportunities, products, quotes, invoices, payments
const express = require('express');
const { query, tx } = require('../db');
const { crud } = require('../utils/crud');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, scopeSql, ROLES } = require('../middleware/auth');
const { Q } = require('../utils/query');
const { z, str, reqStr, id, optId, money, oneOf, date, reqDate, bool } = require('../utils/schemas');

// ---------- products ----------
const products = crud({
  table: 'products', alias: 'p', from: 'products p', columns: 'p.*',
  create: z.object({ name: reqStr(150, 'Name'), sku: reqStr(40, 'SKU'), description: str(1000), category: str(60), price: money('Price'), is_active: bool().optional() }),
  writable: ['name', 'sku', 'description', 'category', 'price', 'is_active'],
  searchCols: ['p.name', 'p.sku', 'p.category'], filters: { category: 'p.category', is_active: 'p.is_active' },
  sortable: { name: 'p.name', price: 'p.price', sku: 'p.sku', created_at: 'p.created_at' }, defaultSort: 'p.name ASC',
  readRoles: ROLES.all, writeRoles: ROLES.manage, deleteRoles: ROLES.manage,
});

// ---------- opportunities ----------
const OPP_FROM = `opportunities o JOIN customers c ON c.id = o.customer_id JOIN users u ON u.id = o.owner_id JOIN lead_stages s ON s.id = o.stage_id`;
const OPP_COLS = `o.id, o.title, o.customer_id, c.company_name AS customer_name, o.lead_id, o.owner_id, u.name AS owner_name, o.stage_id, s.name AS stage_name,
  s.sort_order AS stage_order, o.amount, o.products_total, COALESCE(o.probability, s.probability) AS probability,
  ROUND(o.amount * COALESCE(o.probability, s.probability) / 100.0, 2) AS weighted_amount, o.expected_close_date, o.closed_at, o.lost_reason, o.notes,
  o.created_at, o.updated_at, (SELECT COUNT(*)::int FROM opportunity_products op WHERE op.opportunity_id = o.id) AS product_count`;
const oppSchema = z.object({
  customer_id: id('Customer'), lead_id: optId(), owner_id: optId(), stage_id: id('Stage'), title: reqStr(200, 'Title'), amount: money('Amount').default(0),
  probability: z.preprocess((v) => (v === '' ? null : v), z.coerce.number().int().min(0, 'Probability must be 0-100').max(100, 'Probability must be 0-100').nullable().optional()),
  expected_close_date: date(), lost_reason: str(500), notes: str(2000),
});
const oppRouter = express.Router();

oppRouter.get('/board', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const q = new Q(); const where = ['o.deleted_at IS NULL'];
  const sc = scopeSql(req.user, q, 'o.owner_id'); if (sc) where.push(sc);
  if (req.query.owner_id) where.push(`o.owner_id = ${q.add(req.query.owner_id)}`);
  if (req.query.search) where.push(`(o.title ILIKE ${q.add('%' + String(req.query.search).slice(0, 80) + '%')} OR c.company_name ILIKE ${q.add('%' + String(req.query.search).slice(0, 80) + '%')})`);
  const [stages, opps] = await Promise.all([
    query('SELECT id, name, probability, sort_order FROM lead_stages ORDER BY sort_order'),
    query(`SELECT ${OPP_COLS} FROM ${OPP_FROM} WHERE ${where.join(' AND ')} ORDER BY o.amount DESC LIMIT 1000`, q.params),
  ]);
  res.json({ stages: stages.rows, data: opps.rows });
}));

oppRouter.get('/:id(\\d+)/products', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT op.product_id, p.name, p.sku, op.quantity, op.unit_price, op.discount,
      ROUND(op.quantity * op.unit_price * (1 - op.discount / 100), 2) AS line_total
      FROM opportunity_products op JOIN products p ON p.id = op.product_id WHERE op.opportunity_id = $1 ORDER BY p.name`, [req.params.id]);
  res.json({ data: rows });
}));

// UPSERT a product line (INSERT ... ON CONFLICT); the DB trigger recalculates the opportunity total
oppRouter.put('/:id(\\d+)/products', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const b = z.object({ product_id: id('Product'), quantity: z.coerce.number().int().min(1, 'Quantity must be at least 1'),
    unit_price: money('Unit price').optional(), discount: z.coerce.number().min(0).max(100).default(0) }).parse(req.body);
  await tx(req.user.id, async (c) => {
    const q = new Q(); const where = [`o.id = ${q.add(req.params.id)}`, 'o.deleted_at IS NULL']; const sc = scopeSql(req.user, q, 'o.owner_id'); if (sc) where.push(sc);
    if (!(await c.query(`SELECT 1 FROM opportunities o WHERE ${where.join(' AND ')} FOR UPDATE`, q.params)).rowCount) throw new ApiError(404, 'Opportunity not found');
    const p = (await c.query('SELECT price FROM products WHERE id = $1 AND deleted_at IS NULL', [b.product_id])).rows[0];
    if (!p) throw new ApiError(422, 'Product not found');
    await c.query(`INSERT INTO opportunity_products (opportunity_id, product_id, quantity, unit_price, discount) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (opportunity_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, discount = EXCLUDED.discount`,
      [req.params.id, b.product_id, b.quantity, b.unit_price ?? p.price, b.discount]);
  });
  res.json({ message: 'Product saved' });
}));

oppRouter.delete('/:id(\\d+)/products/:productId(\\d+)', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  await tx(req.user.id, async (c) => {
    const q = new Q(); const where = [`o.id = ${q.add(req.params.id)}`]; const sc = scopeSql(req.user, q, 'o.owner_id'); if (sc) where.push(sc);
    if (!(await c.query(`SELECT 1 FROM opportunities o WHERE ${where.join(' AND ')}`, q.params)).rowCount) throw new ApiError(404, 'Opportunity not found');
    await c.query('DELETE FROM opportunity_products WHERE opportunity_id = $1 AND product_id = $2', [req.params.id, req.params.productId]);
  });
  res.json({ message: 'Product removed' });
}));

// move card between stages (kanban)
oppRouter.patch('/:id(\\d+)/stage', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const b = z.object({ stage_id: id('Stage'), lost_reason: str(500) }).parse(req.body);
  await tx(req.user.id, async (c) => {
    const q = new Q(); const where = [`o.id = ${q.add(req.params.id)}`, 'o.deleted_at IS NULL']; const sc = scopeSql(req.user, q, 'o.owner_id'); if (sc) where.push(sc);
    if (!(await c.query(`SELECT 1 FROM opportunities o WHERE ${where.join(' AND ')} FOR UPDATE`, q.params)).rowCount) throw new ApiError(404, 'Opportunity not found');
    const st = (await c.query('SELECT name FROM lead_stages WHERE id = $1', [b.stage_id])).rows[0];
    if (!st) throw new ApiError(422, 'Stage not found');
    await c.query('UPDATE opportunities SET stage_id = $1, lost_reason = $2 WHERE id = $3', [b.stage_id, st.name === 'Closed Lost' ? (b.lost_reason ?? null) : null, req.params.id]);
  });
  res.json({ message: 'Stage updated' });
}));

oppRouter.use(crud({
  table: 'opportunities', alias: 'o', from: OPP_FROM, columns: OPP_COLS, create: oppSchema,
  writable: ['customer_id', 'lead_id', 'owner_id', 'stage_id', 'title', 'amount', 'probability', 'expected_close_date', 'lost_reason', 'notes'],
  searchCols: ['o.title', 'c.company_name'],
  filters: { stage_id: 'o.stage_id', owner_id: 'o.owner_id', customer_id: 'o.customer_id',
             open: (q, v) => (v === 'true' ? `s.name NOT IN ('Closed Won','Closed Lost')` : 'TRUE'),
             close_from: (q, v) => `o.expected_close_date >= ${q.add(v)}::date`, close_to: (q, v) => `o.expected_close_date <= ${q.add(v)}::date` },
  sortable: { title: 'o.title', amount: 'o.amount', close: 'o.expected_close_date', stage: 's.sort_order', created_at: 'o.created_at', owner: 'u.name' },
  defaultSort: 'o.created_at DESC, o.id DESC', scopeCol: 'o.owner_id', ownerField: 'owner_id',
  hooks: { beforeCreate: async (d, req) => ({ ...d, owner_id: d.owner_id || req.user.id }) },
}));

// ---------- quotes ----------
const quotes = crud({
  table: 'quotes', alias: 'q', from: 'quotes q JOIN customers c ON c.id = q.customer_id LEFT JOIN opportunities o ON o.id = q.opportunity_id',
  columns: 'q.id, q.quote_number, q.customer_id, c.company_name AS customer_name, q.opportunity_id, o.title AS opportunity_title, q.status, q.valid_until, q.total_amount, q.notes, q.created_at',
  create: z.object({ customer_id: id('Customer'), opportunity_id: optId(), status: oneOf(['draft', 'sent', 'accepted', 'rejected', 'expired'], 'draft'), valid_until: date(), total_amount: money('Total').default(0), notes: str(2000) }),
  writable: ['customer_id', 'opportunity_id', 'status', 'valid_until', 'total_amount', 'notes', 'created_by'],
  searchCols: ['q.quote_number', 'c.company_name'], filters: { status: 'q.status', customer_id: 'q.customer_id' },
  sortable: { created_at: 'q.created_at', total: 'q.total_amount', quote_number: 'q.quote_number' }, defaultSort: 'q.created_at DESC',
  hooks: { beforeCreate: async (d, req) => ({ ...d, created_by: req.user.id }) },
});

// ---------- invoices ----------
const INV_FROM = 'invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN opportunities o ON o.id = i.opportunity_id';
const INV_COLS = `i.id, i.invoice_number, i.customer_id, c.company_name AS customer_name, i.opportunity_id, o.title AS opportunity_title, i.issue_date, i.due_date, i.total_amount, i.status, i.notes, i.created_at,
  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'successful'), 0) AS paid_amount,
  i.total_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'successful'), 0) AS balance_due`;
const invSchema = z.object({
  customer_id: id('Customer'), opportunity_id: optId(), issue_date: date(), due_date: reqDate('Due date'), total_amount: money('Total amount'),
  status: oneOf(['draft', 'sent', 'partial', 'paid', 'overdue', 'cancelled'], 'sent'), notes: str(2000),
});
const invRouter = express.Router();

// Invoice with an optional initial payment in ONE transaction (all-or-nothing)
invRouter.post('/', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const b = invSchema.extend({ initial_payment: z.object({ amount: money('Payment amount').refine((v) => v > 0, 'Payment must be greater than 0'),
    payment_method: oneOf(['cash', 'bank_transfer', 'card', 'cheque', 'online'], 'bank_transfer'), reference: str(100) }).optional() }).parse(req.body);
  if (b.issue_date && b.due_date < b.issue_date) throw new ApiError(422, 'Due date cannot be before the issue date', { due_date: 'Due date cannot be before the issue date' });
  const out = await tx(req.user.id, async (c) => {
    const inv = (await c.query(`INSERT INTO invoices (customer_id, opportunity_id, issue_date, due_date, total_amount, status, notes, created_by)
      VALUES ($1,$2,COALESCE($3::date, current_date),$4,$5,$6,$7,$8) RETURNING id`,
      [b.customer_id, b.opportunity_id ?? null, b.issue_date ?? null, b.due_date, b.total_amount, b.status, b.notes ?? null, req.user.id])).rows[0];
    if (b.initial_payment) {
      if (['draft', 'cancelled'].includes(b.status)) throw new ApiError(422, 'A draft or cancelled invoice cannot receive a payment');
      await c.query(`INSERT INTO payments (invoice_id, customer_id, amount, payment_method, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [inv.id, b.customer_id, b.initial_payment.amount, b.initial_payment.payment_method, b.initial_payment.reference ?? null, req.user.id]);
    }
    return (await c.query(`SELECT ${INV_COLS} FROM ${INV_FROM} WHERE i.id = $1`, [inv.id])).rows[0];
  });
  res.status(201).json({ data: out });
}));

invRouter.get('/:id(\\d+)', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const inv = (await query(`SELECT ${INV_COLS} FROM ${INV_FROM} WHERE i.id = $1`, [req.params.id])).rows[0];
  if (!inv) throw new ApiError(404, 'Invoice not found');
  const pays = await query(`SELECT p.id, p.amount, p.payment_method, p.status, p.paid_at, p.reference, u.name AS created_by_name
      FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.invoice_id = $1 ORDER BY p.paid_at DESC`, [req.params.id]);
  res.json({ data: inv, payments: pays.rows });
}));

invRouter.use(crud({
  table: 'invoices', alias: 'i', soft: false, from: INV_FROM, columns: INV_COLS, create: invSchema,
  writable: ['customer_id', 'opportunity_id', 'issue_date', 'due_date', 'total_amount', 'status', 'notes', 'created_by'],
  searchCols: ['i.invoice_number', 'c.company_name'],
  filters: { status: 'i.status', customer_id: 'i.customer_id',
             overdue: (q, v) => (v === 'true' ? `(i.status IN ('sent','partial','overdue') AND i.due_date < current_date)` : 'TRUE'),
             from: (q, v) => `i.issue_date >= ${q.add(v)}::date`, to: (q, v) => `i.issue_date <= ${q.add(v)}::date` },
  sortable: { issue_date: 'i.issue_date', due_date: 'i.due_date', total: 'i.total_amount', invoice_number: 'i.invoice_number', customer: 'c.company_name', balance: 'balance_due' },
  defaultSort: 'i.issue_date DESC, i.id DESC', allowDelete: false, writeRoles: ROLES.write,
  hooks: { beforeUpdate: async (d, req, c, existing) => {
    if (['paid', 'cancelled'].includes(existing.status) && d.total_amount !== undefined) throw new ApiError(409, `A ${existing.status} invoice cannot be edited`);
    if (d.status === 'paid' || d.status === 'partial') delete d.status;         // status is derived from payments by the DB
    return d;
  } },
}));

// ---------- payments ----------
const PAY_FROM = 'payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id LEFT JOIN users u ON u.id = p.created_by';
const payments = crud({
  table: 'payments', alias: 'p', soft: false, from: PAY_FROM,
  columns: `p.id, p.invoice_id, i.invoice_number, p.customer_id, c.company_name AS customer_name, p.amount, p.payment_method, p.status, p.paid_at, p.reference, p.notes, u.name AS created_by_name`,
  create: z.object({ invoice_id: id('Invoice'), amount: money('Amount').refine((v) => v > 0, 'Amount must be greater than 0'),
    payment_method: oneOf(['cash', 'bank_transfer', 'card', 'cheque', 'online'], 'bank_transfer'), paid_at: date(), reference: str(100), notes: str(500), status: oneOf(['successful', 'pending', 'failed', 'refunded'], 'successful') }),
  writable: ['invoice_id', 'customer_id', 'amount', 'payment_method', 'paid_at', 'reference', 'notes', 'status', 'created_by'],
  searchCols: ['i.invoice_number', 'c.company_name', 'p.reference'],
  filters: { invoice_id: 'p.invoice_id', customer_id: 'p.customer_id', status: 'p.status', payment_method: 'p.payment_method',
             from: (q, v) => `p.paid_at >= ${q.add(v)}::date`, to: (q, v) => `p.paid_at < (${q.add(v)}::date + 1)` },
  sortable: { paid_at: 'p.paid_at', amount: 'p.amount', invoice: 'i.invoice_number' }, defaultSort: 'p.paid_at DESC, p.id DESC',
  allowUpdate: false, allowDelete: false,
  hooks: { beforeCreate: async (d, req) => ({ ...d, customer_id: 0, paid_at: d.paid_at || new Date().toISOString(), created_by: req.user.id }) },  // customer_id overwritten by trigger
});

module.exports = { products, opportunities: oppRouter, quotes, invoices: invRouter, payments };
