import { createHash, randomBytes, randomInt } from 'node:crypto';
import { hashPassword, validatePassword, verifyPassword } from './auth.js';
import { transaction } from './db.js';
import { badRequest, conflict, HttpError } from './errors.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_SMS_PER_DAY = 5;
const WITHDRAWN_RECORD_MS = 365 * 24 * 3600 * 1000;
const RESET_INVALID = '인증번호가 올바르지 않거나 만료되었어요.';

/**
 * 계정 관리: 비밀번호 변경·재설정, 모든 기기 로그아웃, 회원 탈퇴(개인정보 파기).
 * onRevoke(userId): 토큰이 무효화될 때 접속 중인 소켓을 끊기 위한 콜백
 */
export function createAccountService(db, { users, auth, sms, mailer, secret, exposeDevCode = false, onRevoke = () => {} }) {
  const stmt = {
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    byEmail: db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL'),
    setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    getReset: db.prepare('SELECT * FROM password_resets WHERE user_id = ?'),
    putReset: db.prepare(`INSERT OR REPLACE INTO password_resets (user_id, channel, code_hash, expires_at, attempts, sent_at)
      VALUES (?, ?, ?, ?, 0, ?)`),
    bumpReset: db.prepare('UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?'),
    deleteReset: db.prepare('DELETE FROM password_resets WHERE user_id = ?'),
    smsCount: db.prepare('SELECT COUNT(*) AS n FROM sms_sends WHERE phone = ? AND sent_at > ?'),
    logSms: db.prepare('INSERT INTO sms_sends (phone, user_id, sent_at) VALUES (?, ?, ?)'),
    activeRides: db.prepare(`SELECT r.id FROM rides r JOIN ride_members m ON m.ride_id = r.id
      WHERE m.user_id = ? AND r.status IN ('open', 'departed')`),
    // 정산 요청을 받았는데 아직 송금하지 않은 합승
    unpaid: db.prepare(`SELECT r.id FROM rides r JOIN ride_members m ON m.ride_id = r.id
      WHERE m.user_id = ? AND r.payer_id IS NOT NULL AND r.payer_id != m.user_id AND m.paid_at IS NULL`),
    saveWithdrawn: db.prepare(`INSERT INTO withdrawn_accounts (phone_hash, no_show_count, late_cancel_count, withdrawn_at)
      VALUES (?, ?, ?, ?)`),
    purgeWithdrawn: db.prepare('DELETE FROM withdrawn_accounts WHERE withdrawn_at < ?'),
    // 개인정보 파기: 이메일·실명·생년월일·연락처 삭제, 닉네임 익명화. 합승 기록·채팅은 '탈퇴한 사용자'로 남는다.
    anonymize: db.prepare(`UPDATE users SET
      email = ?, password_hash = ?, nickname = '탈퇴한 사용자', real_name = NULL, birth_date = NULL, phone = NULL,
      phone_verified = 0, email_verified = 0, org_domain = NULL, deleted_at = ? WHERE id = ?`),
    cleanups: [
      'DELETE FROM push_subscriptions WHERE user_id = ?',
      'DELETE FROM ride_alerts WHERE user_id = ?',
      'DELETE FROM notifications WHERE user_id = ?',
      'DELETE FROM email_verifications WHERE user_id = ?',
      'DELETE FROM phone_verifications WHERE user_id = ?',
      'DELETE FROM password_resets WHERE user_id = ?',
      'DELETE FROM user_consents WHERE user_id = ?',
      'UPDATE ride_shares SET revoked_at = datetime(\'now\') WHERE user_id = ? AND revoked_at IS NULL',
    ].map((sql) => db.prepare(sql)),
    deleteBlocks: db.prepare('DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?'),
  };

  const hashCode = (userId, code) => createHash('sha256').update(`${secret}:reset:${userId}:${code}`).digest('hex');

  function revoke(userId) {
    auth.revokeAll(userId);
    onRevoke(userId);
  }

  return {
    /** 비밀번호 변경 → 다른 기기는 로그아웃, 이 기기용 새 토큰 발급 */
    changePassword(userId, current, next) {
      const user = stmt.byId.get(userId);
      if (typeof current !== 'string' || !verifyPassword(current, user.password_hash)) throw badRequest('현재 비밀번호가 올바르지 않습니다.');
      const invalid = validatePassword(next);
      if (invalid) throw badRequest(invalid);
      stmt.setPassword.run(hashPassword(next), userId);
      revoke(userId);
      return auth.sign(userId);
    },

    logoutAll(userId) {
      revoke(userId);
    },

    /**
     * 비밀번호 찾기: 인증된 휴대폰(없으면 이메일)으로 인증번호 발송.
     * 가입 여부를 알 수 없도록 항상 같은 응답을 준다.
     */
    async requestReset(email) {
      const user = typeof email === 'string' ? stmt.byEmail.get(email.trim().toLowerCase()) : null;
      if (!user) return {};
      const prev = stmt.getReset.get(user.id);
      const now = Date.now();
      if (prev && now - new Date(prev.sent_at).getTime() < RESEND_COOLDOWN_MS) throw new HttpError(429, '잠시 후 다시 요청해 주세요.');
      const channel = user.phone_verified ? 'sms' : 'email';
      if (channel === 'sms' && stmt.smsCount.get(user.phone, new Date(now - 86400000).toISOString()).n >= MAX_SMS_PER_DAY) {
        throw new HttpError(429, '오늘 인증문자 발송 횟수를 초과했어요. 내일 다시 시도해 주세요.');
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      stmt.putReset.run(user.id, channel, hashCode(user.id, code), new Date(now + CODE_TTL_MS).toISOString(), new Date(now).toISOString());
      const text = `[MEET] 비밀번호 재설정 인증번호 ${code} (10분 안에 입력해 주세요)`;
      if (channel === 'sms') {
        stmt.logSms.run(user.phone, user.id, new Date(now).toISOString());
        await sms.send(user.phone, text);
      } else {
        await mailer.send({ to: user.email, subject: '[MEET] 비밀번호 재설정', text });
      }
      const sender = channel === 'sms' ? sms : mailer;
      return exposeDevCode && !sender.configured ? { devCode: code } : {};
    },

    /** 인증번호 확인 후 새 비밀번호 설정 → 모든 기기 로그아웃 */
    resetPassword(email, code, next) {
      const invalid = validatePassword(next);
      if (invalid) throw badRequest(invalid);
      const user = typeof email === 'string' ? stmt.byEmail.get(email.trim().toLowerCase()) : null;
      const reset = user && stmt.getReset.get(user.id);
      if (!reset || new Date(reset.expires_at).getTime() < Date.now() || reset.attempts >= MAX_ATTEMPTS) throw badRequest(RESET_INVALID);
      if (typeof code !== 'string' || hashCode(user.id, code.trim()) !== reset.code_hash) {
        stmt.bumpReset.run(user.id);
        throw badRequest(RESET_INVALID);
      }
      stmt.deleteReset.run(user.id);
      stmt.setPassword.run(hashPassword(next), user.id);
      revoke(user.id);
    },

    /**
     * 회원 탈퇴. 진행 중인 합승이 있거나 보내야 할 정산이 남아 있으면 먼저 정리해야 한다.
     * 개인정보는 즉시 파기하고, 노쇼·직전취소 횟수만 휴대폰 번호 해시와 함께 1년 보관한다.
     */
    withdraw(userId, password) {
      const user = stmt.byId.get(userId);
      if (typeof password !== 'string' || !verifyPassword(password, user.password_hash)) throw badRequest('비밀번호가 올바르지 않습니다.');
      if (stmt.activeRides.get(userId)) throw conflict('진행 중인 합승이 있어요. 합승에서 나오거나 도착 완료 후 탈퇴해 주세요.');
      if (stmt.unpaid.get(userId)) throw conflict('아직 송금하지 않은 정산이 있어요. 정산을 마친 뒤 탈퇴해 주세요.');

      const now = new Date().toISOString();
      transaction(db, () => {
        if (user.phone_verified && (user.no_show_count || user.late_cancel_count)) {
          stmt.saveWithdrawn.run(users.phoneHash(user.phone), user.no_show_count, user.late_cancel_count, now);
        }
        for (const cleanup of stmt.cleanups) cleanup.run(userId);
        stmt.deleteBlocks.run(userId, userId);
        stmt.anonymize.run(`deleted-${userId}-${randomBytes(4).toString('hex')}@deleted.invalid`,
          hashPassword(randomBytes(32).toString('hex')), now, userId);
      });
      revoke(userId);
    },

    purgeExpired(now = Date.now()) {
      stmt.purgeWithdrawn.run(new Date(now - WITHDRAWN_RECORD_MS).toISOString());
    },
  };
}
