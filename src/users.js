import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { CONSENT_KINDS, CONSENTS } from './legal.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from './errors.js';

// 누구나 가입할 수 있는 메일 서비스 — 소속(학교/회사) 인증으로 보지 않는다
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com', 'naver.com', 'daum.net', 'hanmail.net', 'kakao.com', 'nate.com', 'hotmail.com',
  'outlook.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'yahoo.co.kr', 'proton.me', 'protonmail.com',
]);

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MIN_RATINGS_FOR_SCORE = 3;
const WITHDRAWN_RECORD_MS = 365 * 24 * 3600 * 1000; // 탈퇴 후 노쇼 기록 보관 기간
const MAX_SMS_PER_DAY = 5;        // 번호별 하루 인증문자 발송 한도
const MAX_SMS_PER_USER_DAY = 10;  // 계정별 하루 한도 (번호를 바꿔 가며 보내는 것 방지)
const IDENTITY_TTL_MS = 30 * 60 * 1000; // 본인확인 요청 유효시간
export const MIN_AGE = 19;        // 모르는 사람과 타는 서비스이므로 성인만 가입 (민법상 성년)

const NAME_RE = /^[가-힣a-zA-Z][가-힣a-zA-Z\s]{0,18}[가-힣a-zA-Z]$/;
const PHONE_RE = /^01[016789]\d{7,8}$/;

/** 만 나이 */
export function ageOn(birthDate, today = new Date()) {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) age -= 1;
  return age;
}

/** 본인정보 검증·정규화: { name, birthDate: 'YYYY-MM-DD', phone: '01012345678' } */
export function normalizeIdentity({ name, birthDate, phone } = {}) {
  const realName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!NAME_RE.test(realName)) throw badRequest('이름을 정확히 입력해 주세요. (한글/영문 2~20자)');
  const birth = typeof birthDate === 'string' ? birthDate.trim() : '';
  const date = new Date(`${birth}T00:00:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birth) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== birth) {
    throw badRequest('생년월일을 정확히 입력해 주세요.');
  }
  const age = ageOn(birth);
  if (age > 120 || age < 0) throw badRequest('생년월일을 정확히 입력해 주세요.');
  if (age < MIN_AGE) throw badRequest(`만 ${MIN_AGE}세 이상만 가입할 수 있어요.`);
  const digits = typeof phone === 'string' ? phone.replace(/\D/g, '') : '';
  if (!PHONE_RE.test(digits)) throw badRequest('휴대폰 번호를 정확히 입력해 주세요.');
  return { name: realName, birthDate: birth, phone: digits };
}

export const maskPhone = (phone) => (phone ? `${phone.slice(0, 3)}-****-${phone.slice(-4)}` : null);

export const orgDomainOf = (email) => {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && !PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : null;
};

/**
 * identity: 본인확인 업체 연동 (src/identity.js). 켜져 있으면 문자 인증 대신 본인확인으로만 인증한다.
 * verificationRequired: false 면 휴대폰 인증 없이도 합승을 이용할 수 있다 (인증 수단이 준비되기 전 시범 운영용).
 */
export function createUserService(db, {
  secret, mailer, sms, identity = { enabled: false }, exposeDevCode = false, verificationRequired = true,
}) {
  const stmt = {
    byId: db.prepare('SELECT * FROM users WHERE id = ?'),
    completedRides: db.prepare(`
      SELECT COUNT(*) AS n FROM ride_members m JOIN rides r ON r.id = m.ride_id
      WHERE m.user_id = ? AND r.status = 'completed'`),
    ratingCounts: db.prepare('SELECT SUM(good) AS good, COUNT(*) AS total FROM ratings WHERE ratee_id = ?'),
    getVerification: db.prepare('SELECT * FROM email_verifications WHERE user_id = ?'),
    putVerification: db.prepare(`INSERT OR REPLACE INTO email_verifications (user_id, code_hash, expires_at, attempts, sent_at)
      VALUES (?, ?, ?, 0, ?)`),
    bumpAttempts: db.prepare('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ?'),
    deleteVerification: db.prepare('DELETE FROM email_verifications WHERE user_id = ?'),
    markVerified: db.prepare('UPDATE users SET email_verified = 1, org_domain = ? WHERE id = ?'),
    setIdentity: db.prepare('UPDATE users SET real_name = ?, birth_date = ?, phone = ? WHERE id = ?'),
    phoneTaken: db.prepare('SELECT id FROM users WHERE phone = ? AND phone_verified = 1 AND id != ?'),
    getPhoneVerification: db.prepare('SELECT * FROM phone_verifications WHERE user_id = ?'),
    putPhoneVerification: db.prepare(`INSERT OR REPLACE INTO phone_verifications (user_id, phone, code_hash, expires_at, attempts, sent_at)
      VALUES (?, ?, ?, ?, 0, ?)`),
    bumpPhoneAttempts: db.prepare('UPDATE phone_verifications SET attempts = attempts + 1 WHERE user_id = ?'),
    deletePhoneVerification: db.prepare('DELETE FROM phone_verifications WHERE user_id = ?'),
    markPhoneVerified: db.prepare("UPDATE users SET phone_verified = 1, identity_method = 'sms', identity_verified_at = ? WHERE id = ?"),
    putIdentityRequest: db.prepare('INSERT INTO identity_verifications (id, user_id, created_at) VALUES (?, ?, ?)'),
    getIdentityRequest: db.prepare('SELECT * FROM identity_verifications WHERE id = ?'),
    useIdentityRequest: db.prepare('UPDATE identity_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL'),
    identityTaken: db.prepare('SELECT id FROM users WHERE identity_key = ? AND id != ?'),
    markIdentityVerified: db.prepare(`UPDATE users SET real_name = ?, birth_date = ?, gender = ?, phone = ?,
      phone_verified = 1, identity_key = ?, identity_method = 'pass', identity_verified_at = ? WHERE id = ?`),
    consents: db.prepare('SELECT kind, version FROM user_consents WHERE user_id = ?'),
    putConsent: db.prepare(`INSERT INTO user_consents (user_id, kind, version, agreed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET version = excluded.version, agreed_at = excluded.agreed_at`),
    withdrawnRecord: db.prepare(`SELECT SUM(no_show_count) AS noShows, SUM(late_cancel_count) AS lateCancels
      FROM withdrawn_accounts WHERE phone_hash = ? AND withdrawn_at > ?`),
    restoreCounts: db.prepare(`UPDATE users SET no_show_count = no_show_count + ?, late_cancel_count = late_cancel_count + ?
      WHERE id = ?`),
    smsCount: db.prepare('SELECT COUNT(*) AS n FROM sms_sends WHERE phone = ? AND sent_at > ?'),
    smsCountByUser: db.prepare('SELECT COUNT(*) AS n FROM sms_sends WHERE user_id = ? AND sent_at > ?'),
    logSms: db.prepare('INSERT INTO sms_sends (phone, user_id, sent_at) VALUES (?, ?, ?)'),
    blockedEitherWay: db.prepare(`
      SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?
      UNION SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?`),
    block: db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id) VALUES (?, ?)'),
    unblock: db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?'),
    listBlocked: db.prepare(`SELECT u.id, u.nickname FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC`),
    report: db.prepare('INSERT INTO reports (reporter_id, reported_id, ride_id, reason) VALUES (?, ?, ?, ?)'),
    rideById: db.prepare('SELECT * FROM rides WHERE id = ?'),
    isMember: db.prepare('SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id = ?'),
    rate: db.prepare(`INSERT INTO ratings (ride_id, rater_id, ratee_id, good) VALUES (?, ?, ?, ?)
      ON CONFLICT(ride_id, rater_id, ratee_id) DO UPDATE SET good = excluded.good`),
    myRatings: db.prepare('SELECT ratee_id AS userId, good FROM ratings WHERE ride_id = ? AND rater_id = ?'),
  };

  const hashCode = (userId, code, kind = 'email') => createHash('sha256').update(`${secret}:${kind}:${userId}:${code}`).digest('hex');
  const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
  /** 휴대폰 번호 해시 (탈퇴자 기록 대조용 — 번호 자체는 저장하지 않음) */
  const phoneHash = (phone) => createHmac('sha256', secret).update(`phone:${phone}`).digest('hex');
  const identityKeyHash = (key) => createHmac('sha256', secret).update(`identity:${key}`).digest('hex');
  const requirePassInstead = () => {
    if (identity.enabled) throw badRequest('휴대폰 본인확인(PASS)으로 인증해 주세요.');
  };

  /** 1년 안에 탈퇴한 같은 번호의 노쇼·직전취소 기록을 이어받는다 (재가입으로 기록 세탁 방지) */
  function restoreWithdrawnRecord(userId, phone) {
    const prev = stmt.withdrawnRecord.get(phoneHash(phone), new Date(Date.now() - WITHDRAWN_RECORD_MS).toISOString());
    if (prev.noShows || prev.lateCancels) stmt.restoreCounts.run(prev.noShows ?? 0, prev.lateCancels ?? 0, userId);
  }

  /** 아직 동의하지 않았거나 약관 버전이 바뀐 동의 항목 */
  function missingConsents(userId) {
    const agreed = new Map(stmt.consents.all(userId).map((c) => [c.kind, c.version]));
    return CONSENT_KINDS.filter((kind) => agreed.get(kind) !== CONSENTS[kind].version);
  }

  function load(userId) {
    const user = stmt.byId.get(userId);
    if (!user) throw notFound('존재하지 않는 사용자입니다.');
    return user;
  }

  /** 매너 지표. 평가가 적을 때는 점수를 보여주지 않는다. */
  function stats(userId) {
    const user = load(userId);
    const { good, total } = stmt.ratingCounts.get(userId);
    return {
      completedRides: stmt.completedRides.get(userId).n,
      ratings: total,
      mannerPercent: total >= MIN_RATINGS_FOR_SCORE ? Math.round(((good ?? 0) / total) * 100) : null,
      noShows: user.no_show_count,
      lateCancels: user.late_cancel_count,
    };
  }

  const service = {
    stats,
    /** 본인확인 업체 연동 여부 (켜져 있으면 가입 시 본인정보 입력·문자 인증 대신 본인확인) */
    identityEnabled: identity.enabled,
    verificationRequired,

    /** 본인에게 보여주는 정보 */
    me(userId) {
      const u = load(userId);
      return {
        id: u.id, email: u.email, nickname: u.nickname, gender: u.gender,
        name: u.real_name, birthDate: u.birth_date, phone: maskPhone(u.phone),
        identityComplete: Boolean(u.real_name && u.birth_date && u.phone),
        // verified: 휴대폰 본인 확인 완료 (합승 이용 조건)
        verified: Boolean(u.phone_verified),
        // 'pass': 본인확인 업체로 이름·생년월일·성별까지 확인 / 'sms': 휴대폰 번호만 확인
        identityMethod: u.phone_verified ? (u.identity_method ?? 'sms') : null,
        emailVerified: Boolean(u.email_verified),
        // 학교/회사 메일이면 소속 인증 가능
        orgCandidate: orgDomainOf(u.email),
        org: u.org_domain, stats: stats(u.id),
        // 다시 동의해야 하는 약관 (약관 개정 시)
        consentsRequired: missingConsents(u.id),
      };
    },

    phoneHash,
    missingConsents,

    /** 약관 동의 기록. kinds 에 필수 항목이 모두 있어야 한다 */
    agree(userId, kinds) {
      const set = new Set(Array.isArray(kinds) ? kinds : []);
      const missing = CONSENT_KINDS.filter((k) => !set.has(k));
      if (missing.length) throw badRequest(`필수 항목에 동의해 주세요: ${missing.map((k) => CONSENTS[k].label).join(', ')}`);
      const now = new Date().toISOString();
      for (const kind of CONSENT_KINDS) stmt.putConsent.run(userId, kind, CONSENTS[kind].version, now);
      return service.me(userId);
    },

    /** 다른 사용자에게 보여주는 정보 (실명·생년월일·연락처 제외) */
    profile(userId) {
      const u = load(userId);
      return {
        id: u.id, nickname: u.nickname, gender: u.gender,
        verified: Boolean(u.phone_verified), org: u.org_domain, stats: stats(u.id),
      };
    },

    requireVerified(userId) {
      if (verificationRequired && !load(userId).phone_verified) throw forbidden('휴대폰 본인 확인 후 이용할 수 있어요.');
      if (missingConsents(userId).length) throw forbidden('바뀐 약관에 동의한 뒤 이용할 수 있어요.');
    },

    /** 본인정보 입력/수정 (휴대폰 인증 전까지만) */
    setIdentity(userId, input) {
      requirePassInstead();
      const user = load(userId);
      if (user.phone_verified) throw conflict('본인 확인이 끝난 정보는 바꿀 수 없어요.');
      const identity = normalizeIdentity(input);
      if (stmt.phoneTaken.get(identity.phone, userId)) throw conflict('이미 다른 계정에서 인증된 휴대폰 번호예요.');
      // 이전 인증번호는 번호가 달라지면 verifyPhone 에서 무효 처리된다 (재발송 대기시간은 계정 기준으로 유지)
      stmt.setIdentity.run(identity.name, identity.birthDate, identity.phone, userId);
      return service.me(userId);
    },

    async sendPhoneCode(userId) {
      requirePassInstead();
      const user = load(userId);
      if (user.phone_verified) throw conflict('이미 본인 확인이 완료되었습니다.');
      if (!user.phone) throw badRequest('먼저 본인정보를 입력해 주세요.');
      if (stmt.phoneTaken.get(user.phone, userId)) throw conflict('이미 다른 계정에서 인증된 휴대폰 번호예요.');
      const prev = stmt.getPhoneVerification.get(userId);
      const now = Date.now();
      if (prev && now - new Date(prev.sent_at).getTime() < RESEND_COOLDOWN_MS) {
        throw new HttpError(429, '잠시 후 다시 요청해 주세요.');
      }
      const dayAgo = new Date(now - 24 * 3600 * 1000).toISOString();
      if (stmt.smsCount.get(user.phone, dayAgo).n >= MAX_SMS_PER_DAY
        || stmt.smsCountByUser.get(userId, dayAgo).n >= MAX_SMS_PER_USER_DAY) {
        throw new HttpError(429, '오늘 인증문자 발송 횟수를 초과했어요. 내일 다시 시도해 주세요.');
      }
      const code = newCode();
      stmt.putPhoneVerification.run(userId, user.phone, hashCode(userId, code, 'phone'),
        new Date(now + CODE_TTL_MS).toISOString(), new Date(now).toISOString());
      stmt.logSms.run(user.phone, userId, new Date(now).toISOString());
      await sms.send(user.phone, `[MEET] 인증번호 ${code} (10분 안에 입력해 주세요)`);
      return exposeDevCode && !sms.configured ? { devCode: code } : {};
    },

    verifyPhone(userId, code) {
      const user = load(userId);
      if (user.phone_verified) return service.me(userId);
      requirePassInstead();
      const v = stmt.getPhoneVerification.get(userId);
      if (!v || v.phone !== user.phone || new Date(v.expires_at).getTime() < Date.now()) {
        throw badRequest('인증번호가 만료되었어요. 다시 받아 주세요.');
      }
      if (v.attempts >= MAX_ATTEMPTS) throw badRequest('시도 횟수를 초과했어요. 인증번호를 다시 받아 주세요.');
      if (typeof code !== 'string' || hashCode(userId, code.trim(), 'phone') !== v.code_hash) {
        stmt.bumpPhoneAttempts.run(userId);
        throw badRequest('인증번호가 올바르지 않습니다.');
      }
      stmt.deletePhoneVerification.run(userId);
      try {
        stmt.markPhoneVerified.run(new Date().toISOString(), userId);
      } catch {
        // 동시에 같은 번호로 인증한 다른 계정이 있는 경우 (유니크 인덱스)
        throw conflict('이미 다른 계정에서 인증된 휴대폰 번호예요.');
      }
      restoreWithdrawnRecord(userId, user.phone);
      return service.me(userId);
    },

    /** 본인확인 시작: 이 계정 전용 인증 건 번호를 발급한다 (브라우저가 이 번호로 본인인증 창을 연다) */
    startIdentity(userId) {
      if (!identity.enabled) throw badRequest('본인확인 서비스가 아직 설정되지 않았어요.');
      if (load(userId).phone_verified) throw conflict('이미 본인 확인이 완료되었습니다.');
      const id = `meet-${userId}-${randomBytes(12).toString('hex')}`;
      stmt.putIdentityRequest.run(id, userId, new Date().toISOString());
      return { identityVerificationId: id };
    },

    /**
     * 본인확인 완료: 인증 업체에 결과를 직접 조회해서 확인된 이름·생년월일·성별·번호로 계정을 확정한다.
     * 가입할 때 입력한 성별이 달라도 확인된 성별로 바뀐다 (동승자에게 보이는 성별·성별 조건 합승).
     */
    async completeIdentity(userId, identityVerificationId) {
      if (!identity.enabled) throw badRequest('본인확인 서비스가 아직 설정되지 않았어요.');
      const user = load(userId);
      if (user.phone_verified) return service.me(userId);
      const request = typeof identityVerificationId === 'string' && stmt.getIdentityRequest.get(identityVerificationId);
      if (!request || request.user_id !== userId) throw badRequest('본인확인 요청을 찾을 수 없어요. 다시 시도해 주세요.');
      if (request.used_at) throw conflict('이미 사용된 본인확인이에요. 다시 시도해 주세요.');
      if (Date.now() - new Date(request.created_at).getTime() > IDENTITY_TTL_MS) {
        throw badRequest('본인확인 시간이 지났어요. 다시 시도해 주세요.');
      }
      const verified = await identity.fetchVerified(identityVerificationId);
      if (!verified) throw badRequest('본인확인이 완료되지 않았어요. 다시 시도해 주세요.');
      if (!verified.name || !verified.birthDate || !verified.gender) {
        throw badRequest('본인확인 결과에 이름·생년월일·성별이 없어요. 다른 인증 수단으로 다시 시도해 주세요.');
      }
      if (ageOn(verified.birthDate) < MIN_AGE) throw forbidden(`만 ${MIN_AGE}세 이상만 이용할 수 있어요.`);
      // 번호를 제공하지 않는 인증 수단이면 가입 때 입력한 번호를 쓴다
      const phone = verified.phone || user.phone;
      if (!phone || !PHONE_RE.test(phone)) throw badRequest('휴대폰 번호를 확인할 수 없어요. 휴대폰 본인인증으로 다시 시도해 주세요.');
      const key = verified.key ? identityKeyHash(verified.key) : null;
      if (key && stmt.identityTaken.get(key, userId)) throw conflict('이미 가입된 계정이 있어요. 기존 계정으로 로그인해 주세요.');
      if (stmt.phoneTaken.get(phone, userId)) throw conflict('이미 다른 계정에서 인증된 휴대폰 번호예요.');
      if (!stmt.useIdentityRequest.run(new Date().toISOString(), identityVerificationId).changes) {
        throw conflict('이미 사용된 본인확인이에요. 다시 시도해 주세요.');
      }
      try {
        stmt.markIdentityVerified.run(verified.name, verified.birthDate, verified.gender, phone, key,
          new Date().toISOString(), userId);
      } catch {
        // 동시에 같은 사람·번호로 인증한 다른 계정이 있는 경우 (유니크 인덱스)
        throw conflict('이미 가입된 계정이 있어요. 기존 계정으로 로그인해 주세요.');
      }
      restoreWithdrawnRecord(userId, phone);
      return service.me(userId);
    },

    async sendVerificationCode(userId) {
      const user = load(userId);
      if (user.email_verified) throw conflict('이미 이메일 인증이 완료되었습니다.');
      const prev = stmt.getVerification.get(userId);
      if (prev && Date.now() - new Date(prev.sent_at).getTime() < RESEND_COOLDOWN_MS) {
        throw new HttpError(429, '잠시 후 다시 요청해 주세요.');
      }
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const now = Date.now();
      stmt.putVerification.run(userId, hashCode(userId, code), new Date(now + CODE_TTL_MS).toISOString(), new Date(now).toISOString());
      await mailer.send({
        to: user.email,
        subject: `[MEET] 인증번호 ${code}`,
        text: `MEET 이메일 인증번호는 ${code} 입니다. 10분 안에 입력해 주세요.`,
      });
      // SMTP 미설정 개발 환경에서만 화면에 코드를 보여준다
      return exposeDevCode && !mailer.configured ? { devCode: code } : {};
    },

    verify(userId, code) {
      const user = load(userId);
      if (user.email_verified) return service.me(userId);
      const v = stmt.getVerification.get(userId);
      if (!v || new Date(v.expires_at).getTime() < Date.now()) throw badRequest('인증번호가 만료되었어요. 다시 받아 주세요.');
      if (v.attempts >= MAX_ATTEMPTS) throw badRequest('시도 횟수를 초과했어요. 인증번호를 다시 받아 주세요.');
      if (typeof code !== 'string' || hashCode(userId, code.trim()) !== v.code_hash) {
        stmt.bumpAttempts.run(userId);
        throw badRequest('인증번호가 올바르지 않습니다.');
      }
      stmt.deleteVerification.run(userId);
      stmt.markVerified.run(orgDomainOf(user.email), userId);
      return service.me(userId);
    },

    /** 내가 차단했거나 나를 차단한 사용자 id 집합 */
    blockedSet(userId) {
      return new Set(stmt.blockedEitherWay.all(userId, userId).map((r) => r.id));
    },
    block(userId, targetId) {
      if (userId === targetId) throw badRequest('자기 자신은 차단할 수 없습니다.');
      load(targetId);
      stmt.block.run(userId, targetId);
    },
    unblock(userId, targetId) { stmt.unblock.run(userId, targetId); },
    listBlocked(userId) { return stmt.listBlocked.all(userId); },

    report(userId, targetId, { reason, rideId } = {}) {
      if (userId === targetId) throw badRequest('자기 자신은 신고할 수 없습니다.');
      load(targetId);
      if (typeof reason !== 'string' || !reason.trim()) throw badRequest('신고 사유를 입력해 주세요.');
      const ride = rideId ? stmt.rideById.get(Number(rideId)) : null;
      stmt.report.run(userId, targetId, ride?.id ?? null, reason.trim().slice(0, 500));
    },

    /** 완료된 합승의 동승자 평가. ratings: [{ userId, good }] */
    rate(rideId, raterId, ratings) {
      const ride = stmt.rideById.get(Number(rideId));
      if (!ride) throw notFound('존재하지 않는 합승방입니다.');
      if (ride.status !== 'completed') throw conflict('도착 완료 후에 평가할 수 있어요.');
      if (!stmt.isMember.get(ride.id, raterId)) throw forbidden('합승 멤버만 평가할 수 있습니다.');
      if (!Array.isArray(ratings) || !ratings.length) throw badRequest('평가 내용이 없습니다.');
      for (const { userId, good } of ratings) {
        if (userId === raterId || !stmt.isMember.get(ride.id, userId)) throw badRequest('함께 탄 사람만 평가할 수 있습니다.');
        stmt.rate.run(ride.id, raterId, userId, good ? 1 : 0);
      }
      return service.myRatings(ride.id, raterId);
    },
    myRatings(rideId, raterId) {
      return stmt.myRatings.all(Number(rideId), raterId).map((r) => ({ userId: r.userId, good: Boolean(r.good) }));
    },
  };
  return service;
}
