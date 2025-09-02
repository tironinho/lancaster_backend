<<<<<<< HEAD
// src/middleware/auth.js
=======
>>>>>>> 0cbdd00 (chore: backend initial import)
import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
<<<<<<< HEAD
  const bearer = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : null;
  const cookieToken =
    (req.cookies && (req.cookies.token || req.cookies.jwt)) || null;
  const token = bearer || cookieToken;

  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }

=======
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
>>>>>>> 0cbdd00 (chore: backend initial import)
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: data.id, email: data.email, name: data.name };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
