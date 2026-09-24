import { hashPassword, validatePassword } from './auth.js';
import { CONSENT_KINDS, CONSENTS } from './legal.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 운영자용 체험 계정: 가입·문자 인증 없이 바로 로그인해 볼 수 있는 계정을 서버 시작 때 만든다.
 * 환경변수(DEMO_LOGIN_EMAIL, DEMO_LOGIN_PASSWORD)가 있을 때만 동작하고, 비밀번호는 코드에 두지 않는다.
 * 매 시작마다 비밀번호를 환경변수 값으로 맞추므로, 값을 바꾸고 재시작하면 비밀번호도 바뀐다.
 * → 만든/갱신한 계정의 이메일, 없으면 null
 */
export function ensureDemoAccount(db, env = process.env, log = console) {
  const email = env.DEMO_LOGIN_EMAIL?.trim().toLowerCase();
  const password = env.DEMO_LOGIN_PASSWORD;
  if (!email && !password) return null;
  if (!email || !EMAIL_RE.test(email)) {
    log.warn('[demo] DEMO_LOGIN_EMAIL 이 올바른 이메일이 아니어서 체험 계정을 만들지 않았어요.');
    return null;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    log.warn(`[demo] DEMO_LOGIN_PASSWORD: ${invalid} 체험 계정을 만들지 않았어요.`);
    return null;
  }
  const gender = env.DEMO_LOGIN_GENDER === 'female' ? 'female' : 'male';
  const nickname = (env.DEMO_LOGIN_NICKNAME || '운영자').trim().slice(0, 20);
  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL').get(email);
  let userId;
  if (existing) {
    userId = existing.id;
    // 비밀번호를 바꾸면 기존 로그인은 모두 해제
    db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1, phone_verified = 1 WHERE id = ?')
      .run(hashPassword(password), userId);
  } else {
    // 실제 휴대폰 번호 없이 '본인 확인 완료' 상태로 만든다 (체험·운영 확인용)
    const { lastInsertRowid } = db.prepare(`INSERT INTO users (email, password_hash, nickname, gender, real_name, birth_date, phone_verified)
      VALUES (?, ?, ?, ?, ?, ?, 1)`).run(email, hashPassword(password), nickname, gender, nickname, '1990-01-01');
    userId = Number(lastInsertRowid);
  }
  const now = new Date().toISOString();
  const agree = db.prepare(`INSERT INTO user_consents (user_id, kind, version, agreed_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, kind) DO UPDATE SET version = excluded.version`);
  for (const kind of CONSENT_KINDS) agree.run(userId, kind, CONSENTS[kind].version, now);
  log.info(`[demo] 체험 계정 준비됨: ${email} (${existing ? '비밀번호 갱신' : '새로 만듦'})`);
  return email;
}
