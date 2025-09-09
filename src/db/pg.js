// src/db/pg.js
import pg from 'pg';
import dns from 'dns';

// Garante IPv4 mesmo que alguém importe este módulo antes do index
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* Node < 18 */ }

// Ordem: 5432 (não-pooler) primeiro, depois 6543 (pooler)
const urlsOrdered = [
  process.env.DATABASE_URL,            // ex.: ...@db.<ref>.supabase.co:5432/postgres?sslmode=require
  process.env.DATABASE_URL_POOLING,    // ex.: ...@aws-1-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require
].filter(Boolean);

// SSL:
// - Por padrão usamos 'require' com CA relaxado (Render às vezes não tem cadeia completa).
// - Se quiser validação estrita do certificado, defina PGSSLMODE=verify-full.
const strict = String(process.env.PGSSLMODE || 'require').toLowerCase().includes('verify');

function cfg(url) {
  return {
    connectionString: url,
    ssl: strict ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    keepAlive: true,

    // 🔐 Força resolução IPv4 para evitar ENETUNREACH em ambientes sem saída IPv6
    lookup: (hostname, options, cb) =>
      dns.lookup(hostname, { ...options, family: 4, all: false }, cb),
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
    if (rest.length === 0 || attempt >= 5) throw err;
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
