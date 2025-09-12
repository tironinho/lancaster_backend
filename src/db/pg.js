// src/db/pg.js
import pg from 'pg';
import dns from 'dns';
import { URL as NodeURL } from 'url';

const RAW_URL = (process.env.DATABASE_URL || '').replace(/^['"]|['"]$/g, '');
if (!RAW_URL) console.error('[pg] DATABASE_URL ausente');

function buildConfig(urlStr) {
  const u = new NodeURL(urlStr);
  const [database] = (u.pathname || '/postgres').slice(1).split('/');

  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database,
    user: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
    // SSL: confia no certificado autoassinado do pooler + SNI correto
    ssl: {
      rejectUnauthorized: false,
      servername: u.hostname,
    },
    // força IPv4 no Render
    lookup: (hostname, _opts, cb) =>
      dns.lookup(hostname, { family: 4, hints: dns.ADDRCONFIG }, cb),
    max: Number(process.env.PG_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: Number(process.env.DB_CONN_TIMEOUT_MS || 2000),
    keepAlive: true,
  };
}

const poolCfg = buildConfig(RAW_URL);
let pool = null;

function logSafe() {
  const h = `${poolCfg.host}:${poolCfg.port}`;
  return h.replace(/:[^@]+@/, '://***:***@');
}

export async function getPool() {
  if (!pool) {
    const p = new pg.Pool(poolCfg);
    // falha rápido se algo estiver errado
    await p.query('SELECT 1');
    console.log('[pg] connected to', logSafe());
    p.on('error', (e) => {
      console.error('[pg] pool error', e.code || e.message || e);
      pool = null;
    });
    pool = p;
  }
  return pool;
}

export async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}
