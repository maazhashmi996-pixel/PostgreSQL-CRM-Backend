const express = require('express');
const { query, tx } = require('../db');
const { asyncHandler, ApiError } = require('./http');
const { Q, pageParams, escapeLike } = require('./query');
const { authorize, scopeSql, ROLES } = require('../middleware/auth');

/**

 
 
 
 *  - `scopeCol`: user-id column used for role based row-level scope
 *  - hooks: beforeCreate/afterCreate/beforeUpdate/afterUpdate/beforeDelete (all run inside the transaction)
 */
function crud(cfg) {
  const {
    table, alias, from, columns, create, searchCols = [], filters = {}, sortable = {}, defaultSort,
    soft = true, writable, readRoles = ROLES.all, writeRoles = ROLES.write, deleteRoles = ROLES.manage,
    scopeCol, ownerField, maxLimit = 100, hooks = {}, allowDelete = true, allowUpdate = true, extraWhere,
  } = cfg;
  const cols = writable || Object.keys(create.shape);
  const update = create.partial();
  const router = express.Router();
  const sortDefault = defaultSort || `${alias}.id DESC`;

  async function fetchOne(runner, id, req, scoped = true) {
    const q = new Q();
    const where = [`${alias}.id = ${q.add(id)}`];
    if (soft) where.push(`${alias}.deleted_at IS NULL`);
    const sc = scoped ? scopeSql(req.user, q, scopeCol) : null;
    if (sc) where.push(sc);
    const { rows } = await runner.query(`SELECT ${columns} FROM ${from} WHERE ${where.join(' AND ')}`, q.params);
    return rows[0];
  }

  router.get('/', authorize(...readRoles), asyncHandler(async (req, res) => {
    const q = new Q();
    const where = [];
    if (soft) where.push(`${alias}.deleted_at IS NULL`);
    const sc = scopeSql(req.user, q, scopeCol);
    if (sc) where.push(sc);

    for (const [param, f] of Object.entries(filters)) {
      const v = req.query[param];
      if (v === undefined || v === '') continue;
      where.push(typeof f === 'function' ? f(q, v, req) : `${f} = ${q.add(v)}`);
    }
    if (extraWhere) where.push(...(extraWhere(q, req) || []));
    if (req.query.search && searchCols.length) {
      const p = q.add(`%${escapeLike(String(req.query.search).slice(0, 100))}%`);
      where.push('(' + searchCols.map((c) => `${c}::text ILIKE ${p}`).join(' OR ') + ')');
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { page, limit, offset } = pageParams(req.query, { maxLimit });
    const dir = String(req.query.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sortable[req.query.sort] ? `${sortable[req.query.sort]} ${dir}, ${alias}.id DESC` : sortDefault;

    const [{ rows: cnt }, { rows }] = await Promise.all([
      query(`SELECT count(*) AS total FROM ${from} ${whereSql}`, q.params),
      query(`SELECT ${columns} FROM ${from} ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`, q.params),
    ]);
    const total = cnt[0].total;
    res.json({ data: rows, meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) } });
  }));

  router.get('/:id(\\d+)', authorize(...readRoles), asyncHandler(async (req, res) => {
    const row = await fetchOne({ query }, req.params.id, req);
    if (!row) throw new ApiError(404, 'Record not found');
    res.json({ data: row });
  }));

  router.post('/', authorize(...writeRoles), asyncHandler(async (req, res) => {
    const body = create.parse(req.body);
    const row = await tx(req.user.id, async (client) => {
      let data = { ...body };
      if (ownerField && req.user.role === 'sales_agent') data[ownerField] = req.user.id;
      if (hooks.beforeCreate) data = (await hooks.beforeCreate(data, req, client)) || data;
      const keys = Object.keys(data).filter((k) => cols.includes(k) && data[k] !== undefined);
      const ins = await client.query(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
        keys.map((k) => data[k]));
      const id = ins.rows[0].id;
      if (hooks.afterCreate) await hooks.afterCreate(client, id, data, req);
      return fetchOne(client, id, req, false);
    });
    res.status(201).json({ data: row });
  }));

  if (allowUpdate) {
    router.patch('/:id(\\d+)', authorize(...writeRoles), asyncHandler(async (req, res) => {
      const body = update.parse(req.body);
      const row = await tx(req.user.id, async (client) => {
        const existing = await fetchOne(client, req.params.id, req);
        if (!existing) throw new ApiError(404, 'Record not found');
        let data = { ...body };
        if (ownerField && req.user.role === 'sales_agent') delete data[ownerField];
        if (hooks.beforeUpdate) data = (await hooks.beforeUpdate(data, req, client, existing)) || data;
        const keys = Object.keys(data).filter((k) => cols.includes(k) && data[k] !== undefined);
        if (!keys.length && !hooks.afterUpdate) throw new ApiError(422, 'No fields to update');
        if (keys.length) {
          await client.query(
            `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`,
            [...keys.map((k) => data[k]), existing.id]);
        }
        if (hooks.afterUpdate) await hooks.afterUpdate(client, existing.id, data, req, existing);
        return fetchOne(client, existing.id, req, false);
      });
      res.json({ data: row });
    }));
  }

  if (allowDelete) {
    router.delete('/:id(\\d+)', authorize(...deleteRoles), asyncHandler(async (req, res) => {
      await tx(req.user.id, async (client) => {
        const existing = await fetchOne(client, req.params.id, req);
        if (!existing) throw new ApiError(404, 'Record not found');
        if (hooks.beforeDelete) await hooks.beforeDelete(existing, req, client);
        if (soft) await client.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [existing.id]);
        else await client.query(`DELETE FROM ${table} WHERE id = $1`, [existing.id]);
      });
      res.json({ message: 'Deleted successfully' });
    }));
  }
  return router;
}

module.exports = { crud };
