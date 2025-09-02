// src/middleware/auth.js
import jwt from 'jsonwebtoken';

function extractToken(req) {
  const hdr = req.headers.authorization || '';
  let token = null;

  // Header: Authorization: Bearer <jwt>
  if (/^Bearer\s+/i.test(hdr)) {
    token = hdr.replace(/^Bearer\s+/i, '').trim();
  }

  // Cookies: token / jwt (fallback)
  if (!token && req.cookies) {
    token = req.cookies.token || req.cookies.jwt || null;
  }

  // Sanitiza: remove aspas e espaços acidentais
  if (typeof token === 'string') {
    token = token.trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      token = token.slice(1, -1);
    }
  }

  return token || null;
}

export function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: data.id, email: data.email, name: data.name };
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
