import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';

const TOKEN_TTL = '7d';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, actual);
}

export function signToken(user, secret) {
  return jwt.sign({ sub: user.id }, secret, { expiresIn: TOKEN_TTL });
}

/** Returns the user id encoded in the token, or null if it is invalid. */
export function verifyToken(token, secret) {
  try {
    return jwt.verify(token, secret).sub;
  } catch {
    return null;
  }
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const userId = token && verifyToken(token, secret);
    if (!userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
    req.userId = userId;
    next();
  };
}
