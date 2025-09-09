// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL } from 'url';

try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const urlsOrdered = [
  process.env.DATABASE_URL,           // aws-0:5432 (session)
  process.env.DATABASE_URL_ALT,       // aws-1:5432 (session)
  process.env.DATABASE_URL_POOLING,   // aws-0:6543 (transaction)
  process.env.DATABASE_URL_POOLING_ALT,// aws-1:6543 (transaction)
  process.env.DATABASE_URL_DIRECT,    // direto db.<ref>:5432 (último recurso)
].filter(Boolean);

const strict = String(process.env.PGSSLMODE || 'require')
  .toLowerCase()
  .includes('verify');

function mask(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid url>';
  }
}

async function makePgConfig(urlStr) {
  const u = new URL(urlStr);

  const host = u.hostname;
  const port = Number(u.port || 5432);
  const database = (u.pathname || '/postgres').replace(/^\//, '') || 'postgres';
  const user = decodeURIComponent(u.username || 'postgres');
  const password = decodeURIComponent(u.password || '');

  // Resolve para IPv4 literal (evita AAAA / IPv6)
  const { address } = await dns.promises.lookup(host, { family: 4, all: false });

  return {
    host: address,
    port,
    database,
    user,
    password,
    ssl: strict ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
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
    if (rest.length === 0 || attempt >= 8) throw e;
    await new Promise(r => setTimeout(r, 1000 * attempt));
    return connectWithRetry(rest, attempt + 1);
  }

  const candidate = new pg.Pool(cfg);

  try {
    await candidate.query('SELECT 1');
    console.log(`[pg] connected on ${mask(url)} (IPv4=${cfg.host}:${cfg.port})`);
    return candidate;
  } catch (err) {
    console.error(
      `[pg] failed on ${mask(url)} (IPv4=${cfg.host}:${cfg.port}) -> ${err?.code || 'ERR'} :: ${err?.message || ''}`
    );
    await candidate.end().catch(() => {});
    if (rest.length === 0 || attempt >= 8) throw err;
    await new Promise(r => setTimeout(r, 1000 * attempt));
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
