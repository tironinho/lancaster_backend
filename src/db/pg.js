// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const RAW = (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
if (!RAW) console.error('[pg] DATABASE_URL ausente');

function buildSsl(url) {
  try {
    const { hostname } = new NodeURL(url);
    // Supabase: use SNI e não exija cadeia (evita SELF_SIGNED_CERT_IN_CHAIN)
    if (/\.(supabase\.co|supabase\.com)$/i.test(hostname)) {
      return { rejectUnauthorized: false, servername: hostname };
    }
  } catch {}
  // fallback padrão
  const mode = String(process.env.PGSSLMODE || 'require').toLowerCase();
  if (mode === 'disable' || mode === 'allow') return false;
  return { rejectUnauthorized: mode !== 'no-verify' };
}

const poolCfg = {
  connectionString: RAW.includes('sslmode=') ? RAW : `${RAW}${RAW.includes('?') ? '&' : '?'}sslmode=require`,
  ssl: buildSsl(RAW),
  // Render é IPv4-only; força resolução v4
  lookup: (host, _opts, cb) => dns.lookup(host, { family: 4, hints: dns.ADDRCONFIG }, cb),
  max: Number(process.env.PG_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 2000),
  keepAlive: true,
};

let pool = null;

export async function getPool() {
  if (pool) return pool;
  const p = new pg.Pool(poolCfg);
  await p.query('SELECT 1'); // falha rápido se houver problema de rede/ssl
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
