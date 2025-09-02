<<<<<<< HEAD
// src/index.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
=======
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
>>>>>>> 0cbdd00 (chore: backend initial import)
import { ensureSchema } from './seed.js';

import authRoutes from './routes/auth.js';
import drawRoutes from './routes/draws.js';
import numberRoutes from './routes/numbers.js';
import reservationRoutes from './routes/reservations.js';
import paymentRoutes from './routes/payments.js';
<<<<<<< HEAD
=======
import meRoutes from './routes/me.js';
import adminRoutes from './routes/admin.js';
import drawsExtRoutes from './routes/draws_ext.js';
>>>>>>> 0cbdd00 (chore: backend initial import)

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(express.json({ limit: '1mb' }));
<<<<<<< HEAD
app.use(cookieParser());

// CORS: aceita múltiplas origens (separadas por vírgula) e envia credenciais
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    optionsSuccessStatus: 204,
  })
);
// garante preflight explícito para qualquer rota da API
app.options('/api/*', cors());
=======
app.use(
  cors({
    origin: (process.env.CORS_ORIGIN || '*').split(','),
    credentials: true
  })
);
>>>>>>> 0cbdd00 (chore: backend initial import)

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/draw', drawRoutes);
app.use('/api/numbers', numberRoutes);
app.use('/api/reservations', reservationRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/mercadopago', paymentRoutes);
<<<<<<< HEAD
=======
app.use('/api/me', meRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/draws', drawsExtRoutes);
>>>>>>> 0cbdd00 (chore: backend initial import)

ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API ouvindo em http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('[seed] erro ao garantir schema:', e);
    process.exit(1);
  });
