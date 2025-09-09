// src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from './routes/auth.js';
import numbersRoutes from './routes/numbers.js';
import reservationsRoutes from './routes/reservations.js';
import paymentsRoutes from './routes/payments.js';
import meRoutes from './routes/me.js';
import drawsRoutes from './routes/draws.js';
import drawsExtRoutes from './routes/draws_ext.js';
import adminRoutes from './routes/admin.js';

// >>> DB pool resiliente
import { getPool } from './db/pg.js';

const app = express();

const PORT = process.env.PORT || 4000;
const ORIGIN = process.env.CORS_ORIGIN || '*';

// CORS (mantém compat, com múltiplas origens separadas por vírgula)
app.use(
  cors({
    origin: ORIGIN === '*' ? true : ORIGIN.split(',').map((s) => s.trim()),
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Health simples (compat legado)
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Health para Render (valida DB)
app.get('/healthz', async (_req, res) => {
  try {
    const db = await getPool();
    await db.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ ok: false, error: e?.message || 'db_unavailable' });
  }
});

// Rotas
app.use('/api/auth', authRoutes);
app.use('/api/numbers', numbersRoutes);
app.use('/api/reservations', reservationsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/me', meRoutes);
app.use('/api/draws', drawsRoutes);
app.use('/api/draws-ext', drawsExtRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

// Sobe servidor e tenta pré-validar conexão ao DB (sem derrubar o app)
app.listen(PORT, async () => {
  console.log(`API listening on :${PORT}`);
  try {
    const db = await getPool();
    await db.query('SELECT 1');
    console.log('[db] connected');
  } catch (e) {
    console.error('[db] initial check failed:', e?.message || e);
  }
});
