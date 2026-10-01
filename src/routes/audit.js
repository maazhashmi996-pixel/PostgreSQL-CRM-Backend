const express = require('express');
const { query } = require('../db');
const { Q, pageParams } = require('../utils/query');
const { asyncHandler } = require('../utils/http');
const { authorize, ROLES } = require('../middleware/auth');

const router = express.Router();
router.get('/', authorize(...ROLES.manage), asyncHandler(async (req, res) => {
  const q = new Q();
  const where = [];
  if (req.query.table_name) where.push(`table_name = ${q.add(req.query.table_name)}`);
  if (req.query.record_id) where.push(`record_id = ${q.add(req.query.record_id)}`);
  if (req.query.user_id) where.push(`user_id = ${q.add(req.query.user_id)}`);
  if (req.query.action) where.push(`action = ${q.add(req.query.action)}`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const { page, limit, offset } = pageParams(req.query, { defaultLimit: 50, maxLimit: 200 });
  const [{ rows: cnt }, { rows }] = await Promise.all([
    query(`SELECT count(*) AS total FROM audit_logs ${whereSql}`, q.params),
    query(`SELECT a.id, a.user_id, u.name AS user_name, a.table_name, a.record_id, a.action, a.old_data, a.new_data, a.created_at
             FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id ${whereSql}
            ORDER BY a.created_at DESC LIMIT ${limit} OFFSET ${offset}`, q.params),
  ]);
  const total = cnt[0].total;
  res.json({ data: rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
}));
module.exports = router;
