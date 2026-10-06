const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, (v) => parseInt(v, 10));     
types.setTypeParser(1700, (v) => parseFloat(v));       
types.setTypeParser(1082, (v) => v);                   // date    -> 'YYYY-MM-DD' string (no timezone shifting)

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
pool.on('error', (e) => console.error('[pg] idle client error', e.message));

const query = (text, params) => pool.query(text, params);

/**
 * Run fn inside a transaction. The acting user id is stored in the transaction-local
 * setting `app.user_id`, which the audit / history triggers read.
 */
async function tx(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
