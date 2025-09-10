// src/db/pg.js
import pg from 'pg';
const { Pool } = pg;

const sslmode = String(process.env.PGSSLMODE || 'require').toLowerCase();
const SSL =
  sslmode === 'no-verify'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };

// Monte a lista de URLs em ordem de preferência (pooler primeiro)
const URLS = [
  process.env.DATABASE_URL_POOLING,
  process.env.DATABASE_URL_POOLING_ALT,
  process.env.POSTGRES_PRISMA_URL,          // às vezes também aponta p/ pooler
  process.env.POSTGRES_URL,                 // se for pooler, bom ter
  process.env.DATABASE_URL,                 // 5432 (direto) — fallback
  process.env.DATABASE_URL_ALT,             // fallback extra
  process.env.POSTGRES_URL_NON_POOLING,     // 5432 — último recurso
].filter(Boolean);

function cfg(connectionString) {
  return {
    connectionString,
    ssl: SSL,
    max: Number(process.env.PG_MAX || 2),          // manter baixo no Render free
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    allowExitOnIdle: false,
  };
}

let pool;

/** Conecta testando cada URL até achar uma que responde. */
async function connectWithRetry(urls) {
  if (!urls.length) throw new Error('All database URLs failed');

  const [url, ...rest] = urls;
  const candidate = new Pool(cfg(url));
  try {
    await candidate.query('SELECT 1');
    console.log('[pg] connected on', mask(url));
    return candidate;
  } catch (err) {
    console.log('[pg] failed on', mask(url), '->', err.code || err.message);
    await candidate.end().catch(() => {});
    return connectWithRetry(rest);
  }
}

function mask(u) {
  try {
    const out = new URL(u);
    if (out.username) out.username = '***';
    if (out.password) out.password = '***';
    return out.toString();
  } catch {
    return u;
  }
}

export async function getPool() {
  if (pool) return pool;
  console.log('[pg] will try', JSON.stringify(URLS.map(mask), null, 2));
  pool = await connectWithRetry(URLS);
  pool.on('error', (e) => console.error('[pg] pool error', e?.code || e?.message));
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
