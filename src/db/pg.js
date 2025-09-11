// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

// Use APENAS DATABASE_URL (no Render aponte para o pooler 5432 ou 6543)
const RAW_URL = (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
if (!RAW_URL) console.error('[pg] DATABASE_URL ausente');

function sslFor(url) {
  try {
    const { hostname } = new NodeURL(url);
    // Supabase: SNI correto e sem exigir cadeia de CA (evita SELF_SIGNED_CERT_IN_CHAIN)
    if (/\.(supabase\.co|supabase\.com)$/i.test(hostname)) {
      return { rejectUnauthorized: false, servername: hostname };
    }
  } catch {}
  const mode = String(process.env.PGSSLMODE || 'require').trim().toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

const poolCfg = {
  connectionString: RAW_URL,
  ssl: sslFor(RAW_URL),
  // Render é IPv4-only
  lookup: (hostname, _opts, cb) =>
    dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 2000),
  keepAlive: true,
};

let pool = null;

export async function getPool() {
  if (pool) return pool;
  const p = new pg.Pool(poolCfg);
  await p.query('SELECT 1'); // falha rápido se algo estiver errado
  console.log('[pg] connected');
  p.on('error', (e) => {
    console.error('[pg] pool error', e.code || e.message || e);
    pool = null;
  });
  pool = p;
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
