// src/db/pg.js
import pg from 'pg';
import dns from 'dns';

// força IPv4 onde for possível
try { dns.setDefaultResultOrder('ipv4first'); } catch {}

const SSLMODE = (process.env.PGSSLMODE || 'require').toLowerCase();

function sslConfig() {
  // "require" = cifra + verifica; "no-verify" = cifra sem validar CA (evita SELF_SIGNED_CERT_IN_CHAIN)
  return SSLMODE === 'no-verify'
    ? { rejectUnauthorized: false }
    : { rejectUnauthorized: true };
}

function mask(u) {
  return String(u).replace(/:\/\/[^:]+:([^@]+)@/, '://***:***@');
}

// Monte a lista de URLs, priorizando pooler:6543 e removendo pooler:5432
const urls = [
  process.env.DATABASE_URL_POOLING,
  process.env.DATABASE_URL_POOLING_ALT,
  process.env.POSTGRES_PRISMA_URL,
  process.env.POSTGRES_URL,
  process.env.DATABASE_URL,
  process.env.DATABASE_URL_ALT,
  process.env.POSTGRES_URL_NON_POOLING,
]
  .filter(Boolean)
  // tirar qualquer tentativa de pooler:5432 (é fechado e só dá ECONNREFUSED)
  .filter(u => !/pooler\.supabase\.com:5432/i.test(u))
  // de preferência fique só com 6543; os outros (db.supabase.co:5432) ficam por último
  .sort((a, b) => {
    const pa = /:6543\//.test(a) ? 0 : /db\.[^.]+\.supabase\.co:5432/.test(a) ? 2 : 1;
    const pb = /:6543\//.test(b) ? 0 : /db\.[^.]+\.supabase\.co:5432/.test(b) ? 2 : 1;
    return pa - pb;
  })
  // remove duplicado
  .filter((u, i, arr) => arr.indexOf(u) === i);

function cfg(url) {
  return {
    connectionString: url,
    ssl: sslConfig(),
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

let pool;

async function connectWithRetry(list, attempt = 1) {
  if (!list.length) throw new Error('All database URLs failed');
  const [url, ...rest] = list;

  const candidate = new pg.Pool(cfg(url));
  try {
    await candidate.query('select 1');
    console.log('[pg] connected on', mask(url));
    return candidate;
  } catch (err) {
    console.log('[pg] failed on', mask(url), '->', err.code || err.message);
    await candidate.end().catch(() => {});
    // pequeno backoff
    await new Promise(r => setTimeout(r, Math.min(2000, 500 * attempt)));
    return connectWithRetry(rest, attempt + 1);
  }
}

export async function getPool() {
  if (!pool) {
    console.log('[pg] will try', urls.map(mask));
    pool = await connectWithRetry(urls);
    pool.on('error', e => console.error('[pg] pool error', e?.code || e?.message));
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
