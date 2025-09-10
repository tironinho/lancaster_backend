// src/middleware/auth.js
import jwt from 'jsonwebtoken';

const JWT_SECRET =
  process.env.JWT_SECRET ||
  process.env.SUPABASE_JWT_SECRET ||
  'change-me-in-env';

function extractToken(req) {
  const hdr = req.headers.authorization || '';
  let token = null;

  // Authorization: Bearer <jwt>
  if (/^Bearer\s+/i.test(hdr)) {
    token = hdr.replace(/^Bearer\s+/i, '').trim();
  }

  // Cookies (fallback)
  if (!token && req.cookies) {
    token = req.cookies.ns_auth || req.cookies.token || req.cookies.jwt || null;
  }

  // Sanitiza: remove aspas e espaços acidentais
  if (typeof token === 'string') {
    token = token.trim();
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      token = token.slice(1, -1);
    }
  }

  return token || null;
}

function decodeToken(token) {
  const data = jwt.verify(token, JWT_SECRET);

  // Normaliza id (aceita sub ou id)
  const id = typeof data.id !== 'undefined' ? data.id : data.sub;

  // Normaliza flag de admin
  const is_admin =
    typeof data.is_admin !== 'undefined'
      ? !!data.is_admin
      : typeof data.isAdmin !== 'undefined'
      ? !!data.isAdmin
      : (typeof data.role === 'string' && data.role.toLowerCase() === 'admin') ||
        (typeof data.email === 'string' &&
         data.email.toLowerCase() === 'admin@newstore.com.br');

  return {
    id,
    email: data.email || null,
    name: data.name || null,
    is_admin,
    raw: data,
  };
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }
  try {
    req.user = decodeToken(token);
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// Não obriga estar logado; apenas popula req.user quando houver token válido
export function optionalAuth(req, _res, next) {
  try {
    const token = extractToken(req);
    if (token) {
      req.user = decodeToken(token);
    }
  } catch {
    /* ignora erro de token em rotas públicas */
  }
  next();
}

export function requireAdmin(req, res, next) {
  const token = extractToken(req);
  if (!token) return res.status(401).json({ error: 'missing_token' });

  try {
    req.user = decodeToken(token);
    if (!req.user.is_admin) {
      return res.status(403).json({ error: 'forbidden' });
    }
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
