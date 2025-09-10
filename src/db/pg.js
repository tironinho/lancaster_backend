// src/db/pg.js
import pg from 'pg';

const urls = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_POOLING,
  process.env.DATABASE_URL_POOLING_ALT,
  // evite incluir POSTGRES_URL se ele apontar para 5432/host direto
].filter(Boolean);

function sslFromEnv() {
  const mode = (process.env.PGSSLMODE || 'require').toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

function cfg(url) {
  return {
    connectionString: url,
    ssl: sslFromEnv(),
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 12_000,
    keepAlive: true,
  };
}

let pool;

async function tryOnce(url) {
  const p = new pg.Pool(cfg(url));
  try {
    await p.query('SELECT 1');
    console.log('[pg] connected on', url.replace(/:[^@]+@/, '://***:***@'));
    return p;
  } catch (e) {
    console.log(
      '[pg] failed on',
      url.replace(/:[^@]+@/, '://***:***@'),
      '->',
      e.code || e.errno || e.message
    );
    await p.end().catch(() => {});
    throw e;
  }
}

async function connectWithRetry(list, i = 0) {
  if (i >= list.length) throw new Error('All database URLs failed');
  try { return await tryOnce(list[i]); }
  catch { return connectWithRetry(list, i + 1); }
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', JSON.stringify(urls, null, 2));
    pool = await connectWithRetry(urls);
    pool.on('error', e => console.error('[pg] pool error', e.code || e.message));
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
