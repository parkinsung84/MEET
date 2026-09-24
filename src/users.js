import { createHash, randomInt } from 'node:crypto';
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

export const orgDomainOf = (email) => {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain && !PUBLIC_EMAIL_DOMAINS.has(domain) ? domain : null;
};

export function createUserService(db, { secret, mailer, exposeDevCode = false }) {
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

  const hashCode = (userId, code) => createHash('sha256').update(`${secret}:${userId}:${code}`).digest('hex');

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

    /** 본인에게 보여주는 정보 */
    me(userId) {
      const u = load(userId);
      return {
        id: u.id, email: u.email, nickname: u.nickname, gender: u.gender,
        verified: Boolean(u.email_verified), org: u.org_domain, stats: stats(u.id),
      };
    },

    /** 다른 사용자에게 보여주는 정보 (이메일 제외) */
    profile(userId) {
      const u = load(userId);
      return { id: u.id, nickname: u.nickname, verified: Boolean(u.email_verified), org: u.org_domain, stats: stats(u.id) };
    },

    requireVerified(userId) {
      if (!load(userId).email_verified) throw forbidden('이메일 인증 후 이용할 수 있어요.');
    },

    async sendVerificationCode(userId) {
      const user = load(userId);
      if (user.email_verified) throw conflict('이미 인증이 완료되었습니다.');
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
