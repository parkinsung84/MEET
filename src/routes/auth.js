import { Router } from 'express';
import { hashPassword, validatePassword, verifyPassword } from '../auth.js';
import { CONSENT_KINDS, CONSENTS } from '../legal.js';
import { badRequest, conflict, HttpError } from '../errors.js';
import { createLimiter } from '../ratelimit.js';
import { normalizeIdentity } from '../users.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MIN = 60 * 1000;

/** 로그인·가입·비밀번호 찾기 호출 제한 */
export function createAuthLimits(scale = 1) {
  return {
    loginByEmail: createLimiter({ windowMs: 15 * MIN, max: 5 * scale }),  // 계정별 15분에 실패 5회
    loginByIp: createLimiter({ windowMs: 15 * MIN, max: 20 * scale }),    // IP별 15분에 실패 20회
    // 학교·회사 와이파이는 여러 사람이 IP 하나를 같이 쓰므로 넉넉하게
    registerByIp: createLimiter({ windowMs: 60 * MIN, max: 30 * scale }),
    resetByIp: createLimiter({ windowMs: 60 * MIN, max: 20 * scale }),
  };
}

function tooMany(res, { retryAfterSec }) {
  res.set('Retry-After', String(retryAfterSec));
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return res.status(429).json({ error: `시도가 너무 많아요. ${minutes}분 후 다시 시도해 주세요.` });
}

export function authRouter(db, auth, users, account, limits = createAuthLimits()) {
  const router = Router();
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const insert = db.prepare(`INSERT INTO users (email, password_hash, nickname, gender, real_name, birth_date, phone)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const phoneTaken = db.prepare('SELECT 1 FROM users WHERE phone = ? AND phone_verified = 1');

  router.post('/register', async (req, res) => {
    const limited = limits.registerByIp.hit(req.ip);
    if (!limited.allowed) return tooMany(res, limited);
    const { email, password, nickname, gender, agreements } = req.body ?? {};
    if (typeof email !== 'string' || !EMAIL_RE.test(email)) throw badRequest('이메일 형식이 올바르지 않습니다.');
    const invalidPassword = validatePassword(password);
    if (invalidPassword) throw badRequest(invalidPassword);
    const missing = CONSENT_KINDS.filter((k) => !agreements?.[k]);
    if (missing.length) throw badRequest(`필수 항목에 동의해 주세요: ${missing.map((k) => CONSENTS[k].label).join(', ')}`);
    if (typeof nickname !== 'string' || !nickname.trim() || nickname.trim().length > 20) {
      throw badRequest('닉네임은 1~20자로 입력해 주세요.');
    }
    if (!['male', 'female'].includes(gender)) throw badRequest('성별을 선택해 주세요.');
    // 본인확인(PASS)을 쓰면 이름·생년월일·번호는 가입 후 본인확인 결과로 채운다
    const identity = users.identityEnabled
      ? { name: null, birthDate: null, phone: null }
      : normalizeIdentity(req.body);

    const normalized = email.trim().toLowerCase();
    if (findByEmail.get(normalized)) throw conflict('이미 가입된 이메일입니다.');
    if (identity.phone && phoneTaken.get(identity.phone)) throw conflict('이미 가입된 휴대폰 번호예요. 기존 계정으로 로그인해 주세요.');
    const { lastInsertRowid } = insert.run(normalized, hashPassword(password), nickname.trim(), gender,
      identity.name, identity.birthDate, identity.phone);
    const userId = Number(lastInsertRowid);
    users.agree(userId, CONSENT_KINDS);
    // 문자 인증이면 가입과 동시에 인증번호 발송 (문자 발송 장애가 가입을 막지 않도록 실패는 무시 — 재발송 가능)
    const verification = users.identityEnabled ? {} : await users.sendPhoneCode(userId).catch((err) => {
      console.error('[sms]', err.message);
      return {};
    });
    res.status(201).json({ token: auth.sign(userId), user: users.me(userId), ...verification });
  });

  router.post('/login', (req, res) => {
    const { email, password } = req.body ?? {};
    const key = typeof email === 'string' ? email.trim().toLowerCase() : '';
    // 이미 막힌 상태면 비밀번호를 확인하지 않는다 (무차별 대입 방지)
    for (const [limiter, k] of [[limits.loginByEmail, key], [limits.loginByIp, req.ip]]) {
      const state = limiter.check(k);
      if (!state.allowed) return tooMany(res, state);
    }
    const user = key && findByEmail.get(key);
    if (!user || user.deleted_at || typeof password !== 'string' || !verifyPassword(password, user.password_hash)) {
      limits.loginByEmail.hit(key);
      limits.loginByIp.hit(req.ip);
      throw new HttpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    limits.loginByEmail.reset(key);
    res.json({ token: auth.sign(user.id), user: users.me(user.id) });
  });

  // 비밀번호 찾기 (로그인 전)
  router.post('/password/forgot', async (req, res) => {
    const limited = limits.resetByIp.hit(req.ip);
    if (!limited.allowed) return tooMany(res, limited);
    const result = await account.requestReset(req.body?.email);
    res.json({ ok: true, message: '가입된 계정이라면 휴대폰(또는 이메일)으로 인증번호를 보냈어요.', ...result });
  });

  router.post('/password/reset', (req, res) => {
    const limited = limits.resetByIp.hit(req.ip);
    if (!limited.allowed) return tooMany(res, limited);
    const { email, code, password } = req.body ?? {};
    account.resetPassword(email, code, password);
    res.json({ ok: true });
  });

  router.get('/me', auth.required, (req, res) => {
    res.json({ user: users.me(req.userId) });
  });

  // 본인정보 입력 (기존 가입자 또는 인증 전 수정) → 휴대폰 인증
  router.put('/identity', auth.required, async (req, res) => {
    users.setIdentity(req.userId, req.body);
    const verification = await users.sendPhoneCode(req.userId);
    res.json({ user: users.me(req.userId), ...verification });
  });

  // 휴대폰 본인확인(PASS 등): 인증 건 발급 → 브라우저에서 본인인증 → 완료 확인
  router.post('/identity/start', auth.required, (req, res) => {
    res.json(users.startIdentity(req.userId));
  });

  router.post('/identity/complete', auth.required, async (req, res) => {
    res.json({ user: await users.completeIdentity(req.userId, req.body?.identityVerificationId) });
  });

  router.post('/phone/send', auth.required, async (req, res) => {
    res.json({ ok: true, ...(await users.sendPhoneCode(req.userId)) });
  });

  router.post('/phone/verify', auth.required, (req, res) => {
    res.json({ user: users.verifyPhone(req.userId, req.body?.code) });
  });

  router.post('/consents', auth.required, (req, res) => {
    res.json({ user: users.agree(req.userId, req.body?.kinds) });
  });

  router.post('/password', auth.required, (req, res) => {
    const token = account.changePassword(req.userId, req.body?.currentPassword, req.body?.newPassword);
    res.json({ token });
  });

  // 모든 기기(현재 기기 포함)에서 로그아웃
  router.post('/logout-all', auth.required, (req, res) => {
    account.logoutAll(req.userId);
    res.json({ ok: true });
  });

  router.delete('/me', auth.required, (req, res) => {
    account.withdraw(req.userId, req.body?.password);
    res.json({ ok: true });
  });

  // 학교/회사 이메일 인증 (선택) — 같은 소속 전용 합승에 사용
  router.post('/email/send', auth.required, async (req, res) => {
    res.json({ ok: true, ...(await users.sendVerificationCode(req.userId)) });
  });

  router.post('/email/verify', auth.required, (req, res) => {
    res.json({ user: users.verify(req.userId, req.body?.code) });
  });

  return router;
}
