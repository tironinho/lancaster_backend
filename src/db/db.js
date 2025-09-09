// src/db/pg.js
import pg from 'pg';
export * from "./pg.js";
export { default } from "./pg.js";

const primary = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
const secondary = process.env.DATABASE_URL_POOLING || '';

function cfg(url) {
  return {
    connectionString: url,
    ssl: { rejectUnauthorized: true }, // SSL obrigatório
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

let pool;

async function connectWithRetry(urls, attempt = 1) {
  const [url, ...rest] = urls;
  if (!url) throw new Error('No database URL available');

  const candidate = new pg.Pool(cfg(url));
  try {
    await candidate.query('SELECT 1'); // testa imediatamente
    return candidate;
  } catch (err) {
    await candidate.end().catch(() => {});
    if (rest.length === 0 || attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff
    return connectWithRetry(rest, attempt + 1);
  }
}

export async function getPool() {
  if (pool) return pool;
  const urls = [primary, secondary].filter(Boolean);
  pool = await connectWithRetry(urls);
  pool.on('error', (e) => {
    console.error('[pg] pool error', e?.code || e?.message);
  });
  return pool;
}
