import { Router } from 'express';
import { hashPassword, requireAuth, signToken, verifyPassword } from '../auth.js';
import { badRequest, conflict, HttpError } from '../errors.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const publicUser = ({ id, email, nickname, gender }) => ({ id, email, nickname, gender });

export function authRouter(db, secret) {
  const router = Router();
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const findById = db.prepare('SELECT * FROM users WHERE id = ?');
  const insert = db.prepare('INSERT INTO users (email, password_hash, nickname, gender) VALUES (?, ?, ?, ?)');

  router.post('/register', (req, res) => {
    const { email, password, nickname, gender } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw badRequest('이메일 형식이 올바르지 않습니다.');
    if (typeof password !== 'string' || password.length < 8) throw badRequest('비밀번호는 8자 이상이어야 합니다.');
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 20) {
      throw badRequest('닉네임은 1~20자로 입력해 주세요.');
    }
    if (!['male', 'female'].includes(gender)) throw badRequest('성별을 선택해 주세요.');

    const normalized = email.trim().toLowerCase();
    if (findByEmail.get(normalized)) throw conflict('이미 가입된 이메일입니다.');
    const { lastInsertRowid } = insert.run(normalized, hashPassword(password), nickname.trim(), gender);
    const user = findById.get(lastInsertRowid);
    res.status(201).json({ token: signToken(user, secret), user: publicUser(user) });
  });

  router.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const user = typeof email === 'string' && findByEmail.get(email.trim().toLowerCase());
    if (!user || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    res.json({ token: signToken(user, secret), user: publicUser(user) });
  });

  router.get('/me', requireAuth(secret), (req, res) => {
    const user = findById.get(req.userId);
    if (!user) throw new HttpError(401, '로그인이 필요합니다.');
    res.json({ user: publicUser(user) });
  });

  return router;
}
