import jwt from 'jsonwebtoken';

export function requireAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing_token' });
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: data.id, email: data.email, name: data.name };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}
