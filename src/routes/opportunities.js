const express = require('express');
const { query, tx } = require('../db');
const { crud } = require('../utils/crud');
const { Q } = require('../utils/query');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, scopeSql, ROLES } = require('../middleware/auth');
const { z, str, reqStr, id, optId, money, date } = require('../utils/schemas');

const schema = z.object({
  customer_id: id('Customer'), lead_id: optId(), owner_id: optId(), stage_id: id('Stage'), title: reqStr(200, 'Title'),
  amount: money('Amount').default(0), probability: z.coerce.number().int().min(0).max(100).optional(), expected_close_date: date(),
  lost_reason: str(500), notes: str(2000),
});

const FROM = `opportunities o JOIN customers c ON c.id = o.customer_id JOIN users ow ON ow.id = o.owner_id JOIN lead_stages s ON s.id = o.stage_id LEFT JOIN leads l ON l.id = o.lead_id`;
const COLUMNS = `o.id, o.customer_id, c.company_name AS customer_name, o.lead_id, l.name AS lead_name, o.owner_id, ow.name AS owner_name,
  o.stage_id, s.name AS stage_name, s.probability AS stage_probability, s.sort_order AS stage_sort, o.title, o.amount, o.products_total,
  o.probability, o.expected_close_date, o.closed_at, o.lost_reason, o.notes, o.created_at, o.updated_at`;

const router = express.Router();

router.get('/:id(\\d+)/products', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT op.opportunity_id, op.product_id, p.name, p.sku, op.quantity, op.unit_price, op.discount,
      round(op.quantity * op.unit_price * (1 - op.discount/100), 2) AS line_total
    FROM opportunity_products op JOIN products p ON p.id = op.product_id WHERE op.opportunity_id = $1 ORDER BY p.name`, [req.params.id]);
  res.json({ data: rows });
}));

router.put('/:id(\\d+)/products', authorize(...ROLES.write), asyncHandler(async (req, res) => {
  const body = z.object({ items: z.array(z.object({
    product_id: id('Product'), quantity: z.coerce.number().int().positive('Quantity must be positive'),
    unit_price: money('Unit price'), discount: z.coerce.number().min(0).max(100).default(0),
  })).max(100) }).parse(req.body);

  const rows = await tx(req.user.id, async (client) => {
    const opp = await client.query('SELECT id FROM opportunities WHERE id = $1 AND deleted_at IS NULL', [req.params.id]);
    if (!opp.rowCount) throw new ApiError(404, 'Opportunity not found');
    await client.query('DELETE FROM opportunity_products WHERE opportunity_id = $1', [req.params.id]);
    for (const it of body.items) {
      await client.query(
        `INSERT INTO opportunity_products (opportunity_id, product_id, quantity, unit_price, discount) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (opportunity_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity, unit_price = EXCLUDED.unit_price, discount = EXCLUDED.discount`,
        [req.params.id, it.product_id, it.quantity, it.unit_price, it.discount]);
    }
    return (await client.query(`SELECT op.product_id, p.name, op.quantity, op.unit_price, op.discount FROM opportunity_products op
                                  JOIN products p ON p.id = op.product_id WHERE op.opportunity_id = $1`, [req.params.id])).rows;
  });
  res.json({ data: rows });
}));

router.use(crud({
  table: 'opportunities', alias: 'o', from: FROM, columns: COLUMNS, create: schema,
  writable: ['customer_id', 'lead_id', 'owner_id', 'stage_id', 'title', 'amount', 'probability', 'expected_close_date', 'lost_reason', 'notes'],
  searchCols: ['o.title'],
  filters: {
    customer_id: 'o.customer_id', owner_id: 'o.owner_id', stage_id: 'o.stage_id',
    open: (q, v) => (v === 'true' ? "s.name NOT IN ('Closed Won','Closed Lost')" : 'TRUE'),
    won: (q, v) => (v === 'true' ? "s.name = 'Closed Won'" : 'TRUE'),
  },
  sortable: { amount: 'o.amount', stage: 's.sort_order', expected_close_date: 'o.expected_close_date', created_at: 'o.created_at' },
  defaultSort: 'o.created_at DESC',
  scopeCol: 'o.owner_id', ownerField: 'owner_id', writeRoles: ROLES.write, deleteRoles: ROLES.manage,
  hooks: { beforeCreate: (d, req) => ({ ...d, owner_id: d.owner_id || req.user.id }) },
}));

module.exports = router;
