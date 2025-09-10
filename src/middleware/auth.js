// src/routes/auth.js
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getPool } from '../db/pg.js';

const router = express.Router();

// ---- Config de token/cookie ----
const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET || // usa a que você já tem no Vercel
  'change-me-in-env';

const TOKEN_TTL = process.env.JWT_TTL || '7d'; // tempo de vida do token
const COOKIE_NAME = process.env.AUTH_COOKIE_NAME || 'ns_auth';
const IS_PROD = (process.env.NODE_ENV || process.env.NODE_ENV) === 'production';

// Utilitários de token --------------------------------------------------------
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function getTokenFromReq(req) {
  const bearer = req.headers.authorization;
  if (bearer && bearer.startsWith('Bearer ')) return bearer.slice(7);
  if (req.cookies && req.cookies[COOKIE_NAME]) return req.cookies[COOKIE_NAME];
  return null;
}

function verifyToken(req, res, next) {
  try {
    const token = getTokenFromReq(req);
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'unauthorized' });
  }
}

// Busca usuário por e-mail tentando esquemas comuns ---------------------------
// Ajuste a ordem/nomes se souber exatamente a sua tabela/colunas.
async function findUserByEmail(pool, email) {
  const candidates = [
    // [tabela, colEmail, colSenha, colId, colRole?]
    ['admin_users', 'email', 'password_hash', 'id', 'role'],
    ['admins', 'email', 'password', 'id', 'role'],
    ['users', 'email', 'password_hash', 'id', 'role'],
    ['users', 'email', 'password', 'id', 'role'],
  ];

  for (const [table, cEmail, cPass, cId, cRole] of candidates) {
    try {
      const q = `SELECT ${cId} as id, ${cEmail} as email, ${cPass} as hash${cRole ? `, ${cRole} as role` : ''} 
                 FROM ${table} WHERE ${cEmail} = $1 LIMIT 1`;
      const { rows } = await pool.query(q, [email]);
      if (rows.length) {
        const u = rows[0];
        return {
          id: u.id,
          email: u.email,
          hash: u.hash,
          role: u.role || 'user',
        };
      }
    } catch (_) {
      // ignora erro de tabela/coluna inexistente e tenta a próxima
    }
  }
  return null;
}

// -----------------------------------------------------------------------------

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'invalid_payload' });
    }

    const pool = await getPool(); // 🔴 usa o pool compartilhado (NÃO crie Pool novo aqui)

    // Busca usuário
    const user = await findUserByEmail(pool, String(email).trim().toLowerCase());
    if (!user || !user.hash) {
      return res.status(401).json({ error: 'login_failed' });
    }

    // Confere senha
    const ok = await bcrypt.compare(String(password), String(user.hash));
    if (!ok) {
      return res.status(401).json({ error: 'login_failed' });
    }

    // Gera token
    const token = signToken({ sub: user.id, email: user.email, role: user.role });

    // Define cookie httpOnly (e também devolve no body para compatibilidade)
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: IS_PROD ? 'none' : 'lax',
      maxAge:
        typeof TOKEN_TTL === 'string' && TOKEN_TTL.endsWith('d')
          ? parseInt(TOKEN_TTL, 10) * 24 * 60 * 60 * 1000
          : 7 * 24 * 60 * 60 * 1000, // fallback 7d
      path: '/',
    });

    return res.json({
      ok: true,
      token, // caso o front use Authorization: Bearer
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (e) {
    console.error('[auth] login error', e);
    return res.status(500).json({ error: 'login_failed' });
  }
});

router.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    path: '/',
  });
  return res.json({ ok: true });
});

// Retorna o usuário autenticado
router.get('/me', verifyToken, async (req, res) => {
  return res.json({ ok: true, user: req.user });
});

export default router;
