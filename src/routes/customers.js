const express = require('express');
const { query } = require('../db');
const { crud } = require('../utils/crud');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, ROLES } = require('../middleware/auth');
const { z, str, reqStr, email, id, optId, oneOf } = require('../utils/schemas');

const customerSchema = z.object({
  company_name: reqStr(200, 'Company name'), email: email(), phone: str(30), address: str(500), city: str(100), country: str(100),
  industry: str(100), website: str(200), status: oneOf(['active', 'inactive', 'prospect', 'churned'], 'active'),
  account_owner: optId(), notes: str(2000),
});

const COLUMNS = `c.id, c.customer_code, c.company_name, c.email, c.phone, c.address, c.city, c.country, c.industry, c.website,
  c.status, c.account_owner, ow.name AS owner_name, c.notes, c.created_at, c.updated_at,
  (SELECT COUNT(*)::int FROM contacts ct WHERE ct.customer_id = c.id AND ct.deleted_at IS NULL) AS contact_count,
  (SELECT COUNT(*)::int FROM opportunities o WHERE o.customer_id = c.id AND o.deleted_at IS NULL) AS opportunity_count,
  get_customer_balance(c.id) AS outstanding_balance`;
const FROM = 'customers c LEFT JOIN users ow ON ow.id = c.account_owner';

const router = express.Router();

router.get('/:id(\\d+)', authorize(...ROLES.all), asyncHandler(async (req, res) => {
  const cid = req.params.id;
  const { rows } = await query(`SELECT ${COLUMNS} FROM ${FROM} WHERE c.id = $1 AND c.deleted_at IS NULL`, [cid]);
  if (!rows[0]) throw new ApiError(404, 'Customer not found');
  const [contacts, opps, invoices, activities, followUps, summary, payments] = await Promise.all([
    query('SELECT id, name, email, phone, designation, is_primary FROM contacts WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_primary DESC, name', [cid]),
    query(`SELECT o.id, o.title, o.amount, o.probability, o.expected_close_date, s.name AS stage_name, u.name AS owner_name
             FROM opportunities o JOIN lead_stages s ON s.id = o.stage_id JOIN users u ON u.id = o.owner_id
            WHERE o.customer_id = $1 AND o.deleted_at IS NULL ORDER BY o.created_at DESC`, [cid]),
    query(`SELECT i.id, i.invoice_number, i.issue_date, i.due_date, i.total_amount, i.status,
                  COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id AND p.status = 'successful'), 0) AS paid_amount
             FROM invoices i WHERE i.customer_id = $1 ORDER BY i.issue_date DESC`, [cid]),
    query(`SELECT a.id, a.type, a.subject, a.notes, a.activity_at, u.name AS user_name FROM activities a JOIN users u ON u.id = a.user_id
            WHERE a.customer_id = $1 AND a.deleted_at IS NULL ORDER BY a.activity_at DESC LIMIT 50`, [cid]),
    query(`SELECT f.id, f.title, f.due_at, f.status, u.name AS assigned_name, (f.status = 'open' AND f.due_at < now()) AS is_overdue
             FROM follow_ups f JOIN users u ON u.id = f.assigned_to WHERE f.customer_id = $1 AND f.deleted_at IS NULL ORDER BY f.due_at DESC LIMIT 50`, [cid]),
    query('SELECT * FROM get_customer_financial_summary($1)', [cid]),
    query(`SELECT p.id, p.amount, p.payment_method, p.status, p.paid_at, p.reference, i.invoice_number
             FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = $1 ORDER BY p.paid_at DESC LIMIT 20`, [cid]),
  ]);
  res.json({ data: rows[0], contacts: contacts.rows, opportunities: opps.rows, invoices: invoices.rows, activities: activities.rows,
             follow_ups: followUps.rows, financial_summary: summary.rows[0], payments: payments.rows });
}));

router.use(crud({
  table: 'customers', alias: 'c', from: FROM, columns: COLUMNS, create: customerSchema,
  searchCols: ['c.company_name', 'c.email', 'c.phone', 'c.customer_code', 'c.city'],
  filters: { status: 'c.status', account_owner: 'c.account_owner', industry: 'c.industry', country: 'c.country' },
  sortable: { company_name: 'c.company_name', created_at: 'c.created_at', customer_code: 'c.customer_code', balance: 'get_customer_balance(c.id)', city: 'c.city' },
  defaultSort: 'c.created_at DESC, c.id DESC',
  hooks: { beforeCreate: async (d, req) => ({ ...d, account_owner: d.account_owner || req.user.id }) },
}));

// ---------- contacts ----------
const contactSchema = z.object({
  customer_id: id('Customer'), name: reqStr(120, 'Name'), email: email(), phone: str(30), designation: str(120),
  is_primary: z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean().default(false)),
});
const contacts = crud({
  table: 'contacts', alias: 'c', from: 'contacts c JOIN customers cu ON cu.id = c.customer_id',
  columns: 'c.id, c.customer_id, cu.company_name AS customer_name, c.name, c.email, c.phone, c.designation, c.is_primary, c.created_at',
  create: contactSchema, searchCols: ['c.name', 'c.email', 'c.phone', 'cu.company_name'],
  filters: { customer_id: 'c.customer_id' }, sortable: { name: 'c.name', created_at: 'c.created_at' }, defaultSort: 'cu.company_name, c.is_primary DESC, c.name',
  hooks: {
    beforeCreate: async (d, req, client) => {
      const primary = await client.query('SELECT 1 FROM contacts WHERE customer_id = $1 AND is_primary AND deleted_at IS NULL', [d.customer_id]);
      if (d.is_primary) await client.query('UPDATE contacts SET is_primary = false WHERE customer_id = $1 AND is_primary AND deleted_at IS NULL', [d.customer_id]);
      else if (!primary.rowCount) d.is_primary = true;          // first contact becomes primary automatically
      return d;
    },
    beforeUpdate: async (d, req, client, existing) => {
      if (d.is_primary === true) await client.query('UPDATE contacts SET is_primary = false WHERE customer_id = $1 AND id <> $2 AND is_primary AND deleted_at IS NULL', [existing.customer_id, existing.id]);
      return d;
    },
  },
});

module.exports = { customers: router, contacts };
