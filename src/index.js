// src/index.js
import 'dotenv/config';
import * as nodeDns from 'dns';
import { runDbDialSelfTest } from './debug/netcheck.js';
try { nodeDns.setDefaultResultOrder?.('ipv4first'); } catch {}

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import numbersRoutes from './routes/numbers.js';
import reservationsRoutes from './routes/reservations.js';
import meRoutes from './routes/me.js';
import drawsRoutes from './routes/draws.js';
import drawsExtRoutes from './routes/draws_ext.js';
import adminRoutes from './routes/admin.js';

import paymentsRouter from './routes/payments.js';
import { query, getPool } from './db/pg.js';

const app = express();
const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CORS_ORIGIN || '*';

// Middlewares
app.use(cors({
  origin: ORIGIN === '*' ? true : ORIGIN.split(',').map(s => s.trim()),
  credentials: true,
}));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Rotas
app.use(paymentsRouter);
app.use('/api/auth', authRoutes);
app.use('/api/numbers', numbersRoutes);
app.use('/api/reservations', reservationsRoutes);
app.use('/api/me', meRoutes);
app.use('/api/draws', drawsRoutes);
app.use('/api/draws-ext', drawsExtRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// DB health ping
setInterval(() => {
  query('SELECT 1').catch(e =>
    console.warn('[health] db ping failed', e.code || e.message)
  );
}, 60_000);

app.listen(PORT, async () => {
  console.log(`API listening on :${PORT}`);
  try {
    const pool = await getPool();
    await pool.query('SELECT 1');
    console.log('[db] warmup ok');
  } catch (e) {
    console.error('[db] initial check failed:', e);
  }
});

// ...dentro do bootstrap async (antes ou logo após app.listen):
(async () => {
  console.log('[diag] starting TCP dial self-test to Postgres…');
  const diag = await runDbDialSelfTest(process.env.DATABASE_URL);
  console.log('[diag] tcp-dial result =', JSON.stringify(diag, null, 2));

  // opcional: tentar um SELECT 1 e logar resultado/erro claramente
  try {
    const p = await getPool();
    const r = await p.query('select 1 as ok');
    console.log('[diag] SELECT 1 ok ->', r.rows[0]);
  } catch (e) {
    console.error('[diag] SELECT 1 FAIL ->', e.code || e.message, e);
  }
})();

app.get('/__diag/db', async (_req, res) => {
  try {
    const diag = await runDbDialSelfTest(process.env.DATABASE_URL);
    let ping = null;
    try {
      const p = await getPool();
      const r = await p.query('select inet_server_addr()::text addr, inet_server_port() port, current_database() db');
      ping = r.rows[0] || null;
    } catch (e) {
      ping = { error: e.code || e.message };
    }
    res.json({ env: {
      PGSSLMODE: process.env.PGSSLMODE || 'require',
      PG_MAX: process.env.PG_MAX || '10',
      DB_CONN_TIMEOUT_MS: process.env.DB_CONN_TIMEOUT_MS || '2000',
    }, tcp: diag, ping });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


export default app;
