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

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return '비밀번호는 8자 이상이어야 합니다.';
  if (password.length > 100) return '비밀번호가 너무 깁니다.';
  return null;
}

/**
 * 로그인 토큰 발급/검증. 토큰에 사용자의 token_version 을 넣어 두고, 버전을 올리면
 * 그 전에 발급된 모든 토큰이 즉시 무효가 된다 (모든 기기 로그아웃, 비밀번호 변경, 탈퇴).
 */
export function createAuth(db, secret) {
  const getUser = db.prepare('SELECT token_version AS version, deleted_at AS deletedAt FROM users WHERE id = ?');
  const bump = db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?');

  const auth = {
    sign(userId) {
      return jwt.sign({ sub: userId, ver: getUser.get(userId).version }, secret, { expiresIn: TOKEN_TTL });
    },

    /** 유효하면 사용자 id, 아니면 null */
    verify(token) {
      try {
        const { sub, ver } = jwt.verify(token, secret);
        const user = getUser.get(sub);
        if (!user || user.deletedAt || (ver ?? 0) !== user.version) return null;
        return sub;
      } catch {
        return null;
      }
    },

    /** 이 사용자의 기존 토큰을 모두 무효화 */
    revokeAll(userId) {
      bump.run(userId);
    },

    required(req, res, next) {
      const header = req.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const userId = token && auth.verify(token);
      if (!userId) return res.status(401).json({ error: '로그인이 필요합니다.' });
      req.userId = userId;
      next();
    },
  };
  return auth;
}
