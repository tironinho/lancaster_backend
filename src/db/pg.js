// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL } from 'url';

// Força preferência por IPv4 globalmente (Node >= 18)
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* ignore */ }

// Construímos uma lista de candidatos, em ordem:
// 1) Session (5432) aws-0   2) Session (5432) aws-1
// 3) Transaction (6543) aws-0   4) Transaction (6543) aws-1
const urlsOrdered = [
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_ALT,
  process.env.DATABASE_URL_POOLING,
  process.env.DATABASE_URL_POOLING_ALT,
].filter(Boolean);

// SSL: por padrão "require" com CA relaxado (Render às vezes não tem cadeia completa).
const strict = String(process.env.PGSSLMODE || 'require').toLowerCase().includes('verify');

function mask(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

/**
 * Resolve o host para IPv4 e monta um config explícito (host/port/user/db)
 * para o pg.Pool, evitando novas resoluções (e quaisquer tentativas em IPv6).
 */
async function makePgConfig(urlStr) {
  const u = new URL(urlStr);

  const host = u.hostname;
  const port = Number(u.port || 5432);
  const database = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres';
  const user = decodeURIComponent(u.username || 'postgres');
  const password = decodeURIComponent(u.password || '');

  // Resolve IPv4 explicitamente e usa o IP literal como host
  const { address } = await dns.promises.lookup(host, { family: 4, all: false });

  return {
    host: address,        // ← IP v4 literal
    port,
    database,
    user,
    password,

    // SSL
    ssl: strict ? { rejectUnauthorized: true } : { rejectUnauthorized: false },

    // Pool
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

  console.log(`[pg] trying ${mask(url)} (attempt ${attempt})`);

  let cfg;
  try {
    cfg = await makePgConfig(url);
  } catch (e) {
    console.error(`[pg] DNS/parse failed on ${mask(url)} -> ${e?.code || e?.message}`);
    if (rest.length === 0 || attempt >= 6) throw e;
    await new Promise(r => setTimeout(r, 1000 * attempt));
    return connectWithRetry(rest, attempt + 1);
  }

  const candidate = new pg.Pool(cfg);

  try {
    await candidate.query('SELECT 1'); // testa imediatamente
    console.log(`[pg] connected on ${mask(url)} (IPv4=${cfg.host}:${cfg.port})`);
    return candidate;
  } catch (err) {
    console.error(
      `[pg] failed on ${mask(url)} (IPv4=${cfg.host}:${cfg.port}) -> ${err?.code || err?.message}`
    );
    await candidate.end().catch(() => {});
    if (rest.length === 0 || attempt >= 6) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt)); // backoff incremental
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
