const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query, tx } = require('../db');
const { asyncHandler, ApiError } = require('../utils/http');
const { authenticate, authorize } = require('../middleware/auth');
const { z, reqEmail, reqStr, id, optId, str, passwordRule } = require('../utils/schemas');

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again later' } });

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, team_id: u.team_id, team_name: u.team_name, phone: u.phone });

const USER_SQL = `SELECT u.id, u.name, u.email, u.phone, u.team_id, t.name AS team_name, u.password_hash, u.is_active, r.name AS role
                    FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN teams t ON t.id = u.team_id`;

router.post('/login', limiter, asyncHandler(async (req, res) => {
  const { email, password } = z.object({ email: reqEmail(), password: reqStr(200, 'Password') }).parse(req.body);
  const { rows } = await query(`${USER_SQL} WHERE lower(u.email) = $1 AND u.deleted_at IS NULL`, [email]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new ApiError(401, 'Invalid email or password');
  if (!user.is_active) throw new ApiError(403, 'Your account is inactive. Please contact an administrator');
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
  res.json({ token, user: publicUser(user) });
}));

// Admin creates accounts (public self-registration would let anyone obtain access)
router.post('/register', authenticate, authorize('admin'), asyncHandler(async (req, res) => {
  const b = z.object({
    name: reqStr(120, 'Name'), email: reqEmail(), password: passwordRule, role_id: id('Role'),
    team_id: optId(), manager_id: optId(), phone: str(30),
  }).parse(req.body);
  const hash = await bcrypt.hash(b.password, 10);
  const row = await tx(req.user.id, async (c) => (await c.query(
    `INSERT INTO users (name, email, password_hash, role_id, team_id, manager_id, phone)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, email`,
    [b.name, b.email, hash, b.role_id, b.team_id ?? null, b.manager_id ?? null, b.phone ?? null])).rows[0]);
  res.status(201).json({ data: row });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const { rows } = await query(`${USER_SQL} WHERE u.id = $1`, [req.user.id]);
  res.json({ user: publicUser(rows[0]) });
}));

router.patch('/me', authenticate, asyncHandler(async (req, res) => {
  const b = z.object({ name: reqStr(120, 'Name').optional(), phone: str(30) }).parse(req.body);
  await tx(req.user.id, (c) => c.query('UPDATE users SET name = COALESCE($1, name), phone = $2 WHERE id = $3', [b.name ?? null, b.phone ?? null, req.user.id]));
  const { rows } = await query(`${USER_SQL} WHERE u.id = $1`, [req.user.id]);
  res.json({ user: publicUser(rows[0]) });
}));

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const b = z.object({ current_password: reqStr(200, 'Current password'), new_password: passwordRule }).parse(req.body);
  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(b.current_password, rows[0].password_hash)))
    throw new ApiError(422, 'Current password is incorrect', { current_password: 'Current password is incorrect' });
  await tx(req.user.id, async (c) => c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(b.new_password, 10), req.user.id]));
  res.json({ message: 'Password updated successfully' });
}));

// Stateless JWT: the client discards the token; endpoint exists for a clean API contract
router.post('/logout', authenticate, (req, res) => res.json({ message: 'Logged out' }));

module.exports = router;
