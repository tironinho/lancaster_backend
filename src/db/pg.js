// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const RAW_URL = (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
if (!RAW_URL) console.error('[pg] DATABASE_URL ausente');

const CONN_TIMEOUT_MS = Number(process.env.DB_CONN_TIMEOUT_MS || 2000);
const MAX = Number(process.env.PG_MAX || 10);

// --- helpers ---
function isSupabaseHost(host) {
  return /\.(supabase\.co|supabase\.com)$/i.test(host);
}
function isPoolerHost(host) {
  return /\.pooler\.supabase\.com$/i.test(host);
}
function toCfg(u) {
  const [database] = (u.pathname || '/postgres').slice(1).split('/');
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    // SSL: SNI + sem exigir cadeia (resolve SELF_SIGNED_CERT_IN_CHAIN)
    ssl: isSupabaseHost(u.hostname)
      ? { rejectUnauthorized: false, servername: u.hostname }
      : (function () {
          const mode = String(process.env.PGSSLMODE || 'require').toLowerCase();
          if (mode === 'disable' || mode === 'allow') return false;
          return { rejectUnauthorized: mode !== 'no-verify' };
        })(),
    // Render é IPv4-only
    lookup: (hostname, _opts, cb) =>
      dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: CONN_TIMEOUT_MS,
    keepAlive: true,
  };
}
function safeHostPort(cfg) {
  return `${cfg.host}:${cfg.port}`;
}

// Gera candidatos SEM mexer na sua env: primeiro a URL original;
// se for pooler do Supabase, também tenta a outra porta (5432/6543).
function buildCandidates(rawUrl) {
  const orig = new NodeURL(rawUrl);
  const list = [orig];

  if (isPoolerHost(orig.hostname)) {
    const ports = new Set([orig.port || '5432', '5432', '6543']);
    ports.forEach((p) => {
      const u = new NodeURL(orig.toString());
      u.port = String(p);
      const key = u.toString();
      if (!list.find((x) => x.toString() === key)) list.push(u);
    });
  }

  return list.map((u) => toCfg(u));
}

const TRANSIENT = new Set([
  '57P01','57P02','57P03','08006',
  'ECONNRESET','ETIMEDOUT','EPIPE','ENETUNREACH','ECONNREFUSED'
]);

function shouldTryNext(err) {
  const code = String(err?.code || err?.errno || '').toUpperCase();
  return TRANSIENT.has(code) || /self[- ]signed|handshake|terminated/i.test(String(err?.message || ''));
}

let pool = null;

// tenta conectar em ordem; a PRIMEIRA que responder SELECT 1 vence
async function connectWithFallback(candidates) {
  let lastErr;
  for (const cfg of candidates) {
    const p = new pg.Pool(cfg);
    try {
      await p.query('SELECT 1');
      console.log('[pg] connected ->', safeHostPort(cfg));
      p.on('error', (e) => {
        console.error('[pg] pool error', e.code || e.message || e);
        pool = null;
      });
      return p;
    } catch (e) {
      lastErr = e;
      console.warn('[pg] failed ->', safeHostPort(cfg), '::', e.code || e.message);
      await p.end().catch(() => {});
      if (!shouldTryNext(e)) break;
    }
  }
  throw lastErr || new Error('DB connection failed');
}

export async function getPool() {
  if (!pool) {
    const candidates = buildCandidates(RAW_URL);
    pool = await connectWithFallback(candidates);
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
