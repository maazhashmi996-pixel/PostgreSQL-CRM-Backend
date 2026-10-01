#!/usr/bin/env node
/**
 * Applies database/*.sql in order (01..06). Use --reset to drop the public schema first,
 * and --seed to also load 06_seed.sql (skipped by default so production installs don't get demo data).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const args = process.argv.slice(2);
const withSeed = args.includes('--seed');
const reset = args.includes('--reset');
const dbDir = path.join(__dirname, '..', '..', 'database');

const FILES = ['01_schema.sql', '02_functions.sql', '03_triggers.sql', '04_views.sql', '05_indexes.sql', ...(withSeed ? ['06_seed.sql'] : [])];

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    if (reset) {
      console.log('Resetting public schema...');
      await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    }
    for (const file of FILES) {
      const sql = fs.readFileSync(path.join(dbDir, file), 'utf8');
      console.log(`Applying ${file} ...`);
      await client.query(sql);
    }
    console.log('Done.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
