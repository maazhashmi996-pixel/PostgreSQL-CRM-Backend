const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { ApiError, asyncHandler } = require('../utils/http');

const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new ApiError(401, 'Authentication required');
  let payload;
  try { payload = jwt.verify(token, config.jwtSecret); }
  catch { throw new ApiError(401, 'Session expired, please sign in again'); }

  const { rows } = await query(
    `SELECT u.id, u.name, u.email, u.team_id, u.is_active, r.name AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`, [payload.sub]);
  const user = rows[0];
  if (!user || !user.is_active) throw new ApiError(401, 'Account is inactive or no longer exists');
  req.user = user;
  next();
});

const authorize = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, 'You do not have permission to perform this action'));

/**
 * Row-level data scope:  admin/viewer -> everything, manager -> own team, sales_agent -> own records.
 * Returns an SQL condition for `column` (a user-id column) or null.
 */
function scopeSql(user, q, column) {
  if (!column) return null;
  if (user.role === 'sales_agent') return `${column} = ${q.add(user.id)}`;
  if (user.role === 'manager') {
    return user.team_id
      ? `${column} IN (SELECT id FROM users WHERE deleted_at IS NULL AND (team_id = ${q.add(user.team_id)} OR id = ${q.add(user.id)}))`
      : `${column} = ${q.add(user.id)}`;
  }
  return null;
}

const ROLES = {
  all: ['admin', 'manager', 'sales_agent', 'viewer'],
  write: ['admin', 'manager', 'sales_agent'],
  manage: ['admin', 'manager'],
  admin: ['admin'],
};

module.exports = { authenticate, authorize, scopeSql, ROLES };
