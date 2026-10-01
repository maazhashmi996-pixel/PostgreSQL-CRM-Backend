const app = require('./app');
const config = require('./config');
const { pool } = require('./db');

const server = app.listen(config.port, () => console.log(`CRM API listening on port ${config.port} [${process.env.NODE_ENV || 'development'}]`));

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
