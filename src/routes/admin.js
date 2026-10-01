// Users, teams and lookup tables (sources, statuses, stages, tags), plus /meta/lookups for dropdowns
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { crud } = require('../utils/crud');
const { asyncHandler, ApiError } = require('../utils/http');
const { authorize, ROLES } = require('../middleware/auth');
const { z, str, reqStr, reqEmail, id, optId, bool, passwordRule } = require('../utils/schemas');

// ---------- users ----------
const users = crud({
  table: 'users', alias: 'u',
  from: `users u JOIN roles r ON r.id = u.role_id LEFT JOIN teams t ON t.id = u.team_id LEFT JOIN users m ON m.id = u.manager_id`,
  columns: `u.id, u.name, u.email, u.phone, u.role_id, r.name AS role_name, u.team_id, t.name AS team_name,
            u.manager_id, m.name AS manager_name, u.is_active, u.last_login_at, u.created_at`,
  create: z.object({
    name: reqStr(120, 'Name'), email: reqEmail(), password: passwordRule, role_id: id('Role'),
    team_id: optId(), manager_id: optId(), phone: str(30), is_active: bool().optional(),
  }),
  writable: ['name', 'email', 'password_hash', 'role_id', 'team_id', 'manager_id', 'phone', 'is_active'],
  searchCols: ['u.name', 'u.email'],
  filters: { role_id: 'u.role_id', team_id: 'u.team_id', is_active: 'u.is_active' },
  sortable: { name: 'u.name', email: 'u.email', created_at: 'u.created_at', role: 'r.name' },
  defaultSort: 'u.name ASC',
  readRoles: ROLES.manage, writeRoles: ROLES.admin, deleteRoles: ROLES.admin,
  hooks: {
    beforeCreate: async (d) => ({ ...d, password_hash: await bcrypt.hash(d.password, 10) }),
    beforeUpdate: async (d, req, c, existing) => {
      if (d.password) d = { ...d, password_hash: await bcrypt.hash(d.password, 10) };
      if (existing.id === req.user.id && (d.is_active === false || (d.role_id && d.role_id !== existing.role_id)))
        throw new ApiError(400, 'You cannot deactivate or change the role of your own account');
      return d;
    },
    beforeDelete: async (existing, req) => {
      if (existing.id === req.user.id) throw new ApiError(400, 'You cannot delete your own account');
    },
  },
});

// ---------- teams ----------
const teams = crud({
  table: 'teams', alias: 't', soft: false,
  from: 'teams t LEFT JOIN users mg ON mg.id = t.manager_id',
  columns: `t.id, t.name, t.description, t.manager_id, mg.name AS manager_name, t.is_active, t.created_at,
            (SELECT COUNT(*)::int FROM users u WHERE u.team_id = t.id AND u.deleted_at IS NULL) AS member_count`,
  create: z.object({ name: reqStr(100, 'Team name'), manager_id: optId(), description: str(500), is_active: bool().optional() }),
  searchCols: ['t.name'], sortable: { name: 't.name', created_at: 't.created_at' }, defaultSort: 't.name ASC',
  readRoles: ROLES.all, writeRoles: ROLES.admin, deleteRoles: ROLES.admin,
});

// ---------- lookup tables ----------
const lookup = (table, create, extra = {}) => crud({
  table, alias: 'x', soft: false, from: `${table} x`, columns: 'x.*', create,
  searchCols: ['x.name'], defaultSort: extra.defaultSort || 'x.id ASC', maxLimit: 200,
  readRoles: ROLES.all, writeRoles: ROLES.manage, deleteRoles: ROLES.admin,
});
const sources = lookup('lead_sources', z.object({ name: reqStr(60, 'Name'), is_active: bool().optional(), score_weight: z.coerce.number().int().min(0).max(30).optional() }));
const statuses = lookup('lead_statuses', z.object({ name: reqStr(60, 'Name'), sort_order: z.coerce.number().int().min(0).optional(), is_final: bool().optional(), color: str(20) }), { defaultSort: 'x.sort_order ASC' });
const stages = lookup('lead_stages', z.object({ name: reqStr(60, 'Name'), probability: z.coerce.number().int().min(0).max(100), sort_order: z.coerce.number().int().min(0).optional() }), { defaultSort: 'x.sort_order ASC' });
const tags = lookup('tags', z.object({ name: reqStr(50, 'Name'), color: str(20) }));

// ---------- dropdown data ----------
const meta = express.Router();
meta.get('/lookups', asyncHandler(async (req, res) => {
  const [roles, teamRows, srcs, sts, stgs, tgs, usr, prods, custs] = await Promise.all([
    query('SELECT id, name, description FROM roles ORDER BY id'),
    query('SELECT id, name, manager_id FROM teams WHERE is_active ORDER BY name'),
    query('SELECT id, name, is_active, score_weight FROM lead_sources ORDER BY name'),
    query('SELECT id, name, sort_order, is_final, color FROM lead_statuses ORDER BY sort_order'),
    query('SELECT id, name, probability, sort_order FROM lead_stages ORDER BY sort_order'),
    query('SELECT id, name, color FROM tags ORDER BY name'),
    query(`SELECT u.id, u.name, u.team_id, r.name AS role_name FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.deleted_at IS NULL AND u.is_active ORDER BY u.name`),
    query('SELECT id, name, sku, price FROM products WHERE deleted_at IS NULL AND is_active ORDER BY name'),
    query(`SELECT id, company_name, customer_code FROM customers WHERE deleted_at IS NULL ORDER BY company_name LIMIT 2000`),
  ]);
  res.json({ roles: roles.rows, teams: teamRows.rows, sources: srcs.rows, statuses: sts.rows, stages: stgs.rows,
             tags: tgs.rows, users: usr.rows, products: prods.rows, customers: custs.rows });
}));

// Manager -> employee hierarchy (recursive CTE in PostgreSQL)
const hierarchy = express.Router();
hierarchy.get('/', authorize(...ROLES.manage), asyncHandler(async (req, res) => {
  const { rows } = await query('SELECT * FROM get_user_hierarchy()');
  res.json({ data: rows });
}));

module.exports = { users, teams, sources, statuses, stages, tags, meta, hierarchy };
