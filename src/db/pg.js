// src/db/pg.js
import pg from 'pg';

const urlsOrdered = [
  process.env.DATABASE_URL,            // 5432 (não-pooling) -> prioridade
  process.env.DATABASE_URL_POOLING,    // 6543 (pooler)      -> fallback
].filter(Boolean);

function cfg(url) {
  return {
    connectionString: url,
    ssl: { rejectUnauthorized: true },
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
  };
}

function mask(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

let pool;

async function connectWithRetry(urls, attempt = 1) {
  const [url, ...rest] = urls;
  if (!url) throw new Error('No database URL available');

  console.log(`[pg] trying ${mask(url)} (attempt ${attempt})`);

  const candidate = new pg.Pool(cfg(url));
  try {
    await candidate.query('SELECT 1'); // testa imediatamente
    console.log(`[pg] connected on ${mask(url)}`);
    return candidate;
  } catch (err) {
    console.error(`[pg] failed on ${mask(url)} -> ${err?.code || err?.message}`);
    await candidate.end().catch(() => {});
    if (rest.length === 0 || attempt >= 3) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff
    return connectWithRetry(rest, attempt + 1);
  }
}

export async function getPool() {
  if (pool) return pool;
  if (!urlsOrdered.length) throw new Error('No database URLs configured');

  pool = await connectWithRetry(urlsOrdered);
  pool.on('error', (e) => {
    console.error('[pg] pool error', e?.code || e?.message);
  });
  return pool;
}
