import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { estimateFare, haversineKm, projectOnRoute, splitByDropoffs, splitFare } from './geo.js';

const GENDERS = ['any', 'male', 'female'];
const MIN = 60 * 1000;
const MAX_ADVANCE_MS = 7 * 24 * 60 * MIN;
const DEFAULT_RADIUS_KM = 2;
const LATE_CANCEL_MS = 10 * MIN;      // 출발 10분 전 이후 나가면 '직전 취소'로 기록
const CHECKIN_OPEN_MS = 60 * MIN;     // 출발 1시간 전부터 도착 체크인 가능
const OVERLAP_MS = 60 * MIN;          // 앞뒤 1시간 안에 다른 합승이 있으면 참여 불가 (중복 예약 → 노쇼 방지)
const REMINDER_MS = 10 * MIN;         // 출발 10분 전 알림
const EXPIRE_AFTER_MS = 30 * MIN;     // 출발 30분이 지나도 '출발' 처리 안 된 방 정리
const AUTO_COMPLETE_MS = 3 * 60 * MIN; // 출발 3시간 후 자동 '도착 완료'
const MAX_DROPOFF_DETOUR_KM = 3;      // 경로에서 이보다 먼 하차 지점은 불가
const SAME_DEST_KM = 0.5;             // 도착지와 이만큼 가까우면 같은 도착지로 본다
const ON_THE_WAY_MIN_T = 0.2;         // 경로의 20% 이상은 같이 가야 '가는 길 하차'로 매칭

// 허용되는 상태 전이 (방장만 변경 가능)
const TRANSITIONS = {
  open: ['departed', 'cancelled'],
  departed: ['completed'],
  completed: [],
  cancelled: [],
};

const won = (n) => `${n.toLocaleString('ko-KR')}원`;
const kst = (iso) => new Date(iso).toLocaleString('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
});

function requireText(value, field, maxLength = 100) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field}을(를) 입력해 주세요.`);
  if (value.length > maxLength) throw badRequest(`${field}은(는) ${maxLength}자 이하로 입력해 주세요.`);
  return value.trim();
}

function requireCoord(value, field, limit) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n) || Math.abs(n) > limit) {
    throw badRequest(`${field} 좌표가 올바르지 않습니다.`);
  }
  return n;
}

function requirePlace(place, label) {
  if (!place || typeof place !== 'object') throw badRequest(`${label}를 입력해 주세요.`);
  return {
    name: requireText(place.name, label),
    lat: requireCoord(place.lat, label, 90),
    lng: requireCoord(place.lng, label, 180),
  };
}

function optionalTime(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) throw badRequest(`${field}이(가) 올바르지 않습니다.`);
  return t;
}

/** 합승 경로 좌표 목록 [{lat, lng}] — 네이버 길찾기 경로가 없으면 출발지→도착지 직선 */
function routeOf(ride) {
  if (ride.route_path) return JSON.parse(ride.route_path).map(([lng, lat]) => ({ lat, lng }));
  return [{ lat: ride.origin_lat, lng: ride.origin_lng }, { lat: ride.dest_lat, lng: ride.dest_lng }];
}

/**
 * 검색 조건(출발지/도착지/반경)과 합승방이 맞는지 판단한다.
 * → null(불일치) 또는 { type: 'same' | 'onTheWay', t, mismatchKm }
 *   onTheWay: 내 도착지가 합승 경로 중간에 있어 먼저 내리는 경우
 */
export function matchRoute(ride, { origin, destination, radiusKm }) {
  let mismatchKm = 0;
  if (origin) {
    const d = haversineKm(origin.lat, origin.lng, ride.origin_lat, ride.origin_lng);
    if (d > radiusKm) return null;
    mismatchKm += d;
  }
  if (!destination) return { type: 'same', t: 1, mismatchKm };
  const toDest = haversineKm(destination.lat, destination.lng, ride.dest_lat, ride.dest_lng);
  if (toDest <= radiusKm) return { type: 'same', t: 1, mismatchKm: mismatchKm + toDest };
  const { distanceKm, t } = projectOnRoute(routeOf(ride), destination);
  if (distanceKm > radiusKm || t < ON_THE_WAY_MIN_T) return null;
  return { type: 'onTheWay', t, mismatchKm: mismatchKm + distanceKm };
}

/**
 * findRoute(origin, destination): 실제 도로 경로를 돌려주는 선택적 함수
 *   → { distanceKm, durationMin, taxiFare, path } 또는 null (추정치 사용)
 * users: 사용자/신뢰 서비스, notifier: 알림 허브
 */
export function createRideService(db, { findRoute = null, users, notifier, log = console }) {
  const stmt = {
    rideById: db.prepare('SELECT * FROM rides WHERE id = ?'),
    members: db.prepare(`
      SELECT u.id, u.nickname, u.gender, u.email_verified, u.org_domain, m.joined_at, m.dropoff_name,
             m.dropoff_lat, m.dropoff_lng, m.dropoff_t, m.arrived_at, m.paid_at
      FROM ride_members m JOIN users u ON u.id = m.user_id
      WHERE m.ride_id = ? ORDER BY m.joined_at, u.id`),
    memberIds: db.prepare('SELECT user_id AS id FROM ride_members WHERE ride_id = ?'),
    member: db.prepare('SELECT * FROM ride_members WHERE ride_id = ? AND user_id = ?'),
    insertRide: db.prepare(`
      INSERT INTO rides (host_id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng,
                         depart_at, max_seats, gender_pref, memo, meeting_point, org_domain,
                         distance_km, duration_min, taxi_fare, route_path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertMember: db.prepare(`INSERT INTO ride_members (ride_id, user_id, dropoff_name, dropoff_lat, dropoff_lng, dropoff_t)
      VALUES (?, ?, ?, ?, ?, ?)`),
    deleteMember: db.prepare('DELETE FROM ride_members WHERE ride_id = ? AND user_id = ?'),
    setHost: db.prepare('UPDATE rides SET host_id = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE rides SET status = ? WHERE id = ?'),
    setCompleted: db.prepare(`UPDATE rides SET status = 'completed', completed_at = ? WHERE id = ?`),
    setMeetingPoint: db.prepare('UPDATE rides SET meeting_point = ? WHERE id = ?'),
    setReminded: db.prepare('UPDATE rides SET reminded_at = ? WHERE id = ?'),
    setSettlement: db.prepare('UPDATE rides SET payer_id = ?, actual_fare = ?, payer_account = ? WHERE id = ?'),
    resetPaid: db.prepare('UPDATE ride_members SET paid_at = NULL WHERE ride_id = ?'),
    setPaid: db.prepare('UPDATE ride_members SET paid_at = ? WHERE ride_id = ? AND user_id = ? AND paid_at IS NULL'),
    setArrived: db.prepare('UPDATE ride_members SET arrived_at = ? WHERE ride_id = ? AND user_id = ? AND arrived_at IS NULL'),
    bumpNoShow: db.prepare('UPDATE users SET no_show_count = no_show_count + 1 WHERE id = ?'),
    bumpLateCancel: db.prepare('UPDATE users SET late_cancel_count = late_cancel_count + 1 WHERE id = ?'),
    openRides: db.prepare(`SELECT * FROM rides WHERE status = 'open' AND depart_at >= ? AND depart_at <= ? ORDER BY depart_at`),
    myRides: db.prepare(`
      SELECT r.* FROM rides r JOIN ride_members m ON m.ride_id = r.id
      WHERE m.user_id = ? ORDER BY r.depart_at DESC LIMIT 100`),
    // 같은 사용자가 참여 중인, 시간이 겹치는 다른 모집 중 합승
    overlapping: db.prepare(`
      SELECT r.id FROM rides r JOIN ride_members m ON m.ride_id = r.id
      WHERE m.user_id = ? AND r.status = 'open' AND r.id != ? AND r.depart_at BETWEEN ? AND ? LIMIT 1`),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    messages: db.prepare(`
      SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM messages msg JOIN users u ON u.id = msg.user_id
      WHERE msg.ride_id = ? AND msg.id > ? ORDER BY msg.id LIMIT 200`),
    insertMessage: db.prepare('INSERT INTO messages (ride_id, user_id, body) VALUES (?, ?, ?)'),
    messageById: db.prepare(`
      SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM messages msg JOIN users u ON u.id = msg.user_id WHERE msg.id = ?`),
    dueReminders: db.prepare(`SELECT * FROM rides WHERE status = 'open' AND reminded_at IS NULL
      AND depart_at <= ? AND depart_at > ?`),
    expired: db.prepare(`SELECT * FROM rides WHERE status = 'open' AND depart_at < ?`),
    staleDeparted: db.prepare(`SELECT * FROM rides WHERE status = 'departed' AND depart_at < ?`),
  };

  /** 알림은 응답을 막지 않도록 비동기로 보내고, 실패는 로그만 남긴다 */
  function fire(userIds, notification) {
    if (!notifier || !userIds.length) return;
    notifier.notify(userIds, notification).catch((err) => log.error('[notify]', err.message));
  }
  const memberIdsOf = (rideId) => stmt.memberIds.all(rideId).map((r) => r.id);
  const nicknameOf = (userId) => stmt.userById.get(userId)?.nickname ?? '알 수 없음';
  const routeLabel = (ride) => `${ride.origin_name} → ${ride.dest_name}`;

  function loadRide(rideId) {
    const ride = stmt.rideById.get(Number(rideId));
    if (!ride) throw notFound('존재하지 않는 합승방입니다.');
    return ride;
  }

  function assertMember(rideId, userId) {
    if (!stmt.member.get(rideId, userId)) throw forbidden('합승 멤버만 이용할 수 있습니다.');
  }

  function assertNoOverlap(userId, departAt, rideId = 0) {
    const t = new Date(departAt).getTime();
    const hit = stmt.overlapping.get(userId, rideId,
      new Date(t - OVERLAP_MS).toISOString(), new Date(t + OVERLAP_MS).toISOString());
    if (hit) throw conflict('비슷한 시간에 참여 중인 다른 합승이 있어요. 먼저 그 합승에서 나와 주세요.');
  }

  /** 성별·소속·차단 조건으로 이 사용자가 참여할 수 있는 방인지 */
  function eligibility(ride, user, blocked = users.blockedSet(user.id)) {
    if (ride.gender_pref !== 'any' && ride.gender_pref !== user.gender) return '성별 조건이 맞지 않아 참여할 수 없습니다.';
    if (ride.org_domain && (!user.email_verified || user.org_domain !== ride.org_domain)) {
      return `@${ride.org_domain} 인증 사용자만 참여할 수 있는 합승입니다.`;
    }
    if (memberIdsOf(ride.id).some((id) => blocked.has(id))) return '참여할 수 없는 합승방입니다.';
    return null;
  }

  function fareOf(ride) {
    const fromNaver = ride.taxi_fare !== null && ride.taxi_fare !== undefined;
    const { distanceKm, fare } = fromNaver
      ? { distanceKm: ride.distance_km, fare: ride.taxi_fare }
      : estimateFare(ride.origin_lat, ride.origin_lng, ride.dest_lat, ride.dest_lng);
    return { source: fromNaver ? 'naver' : 'estimate', distanceKm, durationMin: ride.duration_min ?? null, total: fare };
  }

  function settlementOf(ride, members) {
    if (!ride.payer_id) return null;
    const shares = splitByDropoffs(ride.actual_fare, members.map((m) => ({ userId: m.id, t: m.dropoff_t })));
    const rows = members.map((m) => ({
      userId: m.id,
      nickname: m.nickname,
      amount: shares.get(m.id),
      // 결제한 사람은 자기 몫을 보낼 필요가 없다
      paid: m.id === ride.payer_id || Boolean(m.paid_at),
    }));
    return {
      payerId: ride.payer_id,
      payerNickname: nicknameOf(ride.payer_id),
      actualFare: ride.actual_fare,
      account: ride.payer_account,
      shares: rows,
      allPaid: rows.every((r) => r.paid),
    };
  }

  /**
   * memberView: 멤버에게만 보여줄 정보(만남 장소, 하차 지점, 정산 계좌 등) 포함 여부
   */
  function serialize(ride, { detail = false, memberView = false } = {}) {
    const members = stmt.members.all(ride.id);
    const fare = fareOf(ride);
    const host = users.profile(ride.host_id);
    const result = {
      id: ride.id,
      hostId: ride.host_id,
      host: { nickname: host.nickname, verified: host.verified, stats: host.stats },
      origin: { name: ride.origin_name, lat: ride.origin_lat, lng: ride.origin_lng },
      destination: { name: ride.dest_name, lat: ride.dest_lat, lng: ride.dest_lng },
      departAt: ride.depart_at,
      maxSeats: ride.max_seats,
      genderPref: ride.gender_pref,
      orgOnly: ride.org_domain,
      memo: ride.memo,
      status: ride.status,
      memberCount: members.length,
      fare: { ...fare, perPersonFull: splitFare(fare.total, ride.max_seats) },
    };
    if (!detail) return result;

    const shares = splitByDropoffs(fare.total, members.map((m) => ({ userId: m.id, t: m.dropoff_t })));
    result.fare.shares = Object.fromEntries(shares);
    result.routePath = ride.route_path ? JSON.parse(ride.route_path) : null;
    result.members = members.map((m) => {
      const profile = users.profile(m.id);
      return {
        id: m.id,
        nickname: m.nickname,
        verified: profile.verified,
        org: profile.org,
        stats: profile.stats,
        arrived: Boolean(m.arrived_at),
        dropoff: memberView && m.dropoff_name ? { name: m.dropoff_name, lat: m.dropoff_lat, lng: m.dropoff_lng } : null,
      };
    });
    result.meetingPoint = memberView ? ride.meeting_point || ride.origin_name : null;
    result.settlement = memberView ? settlementOf(ride, members) : null;
    return result;
  }

  const service = {
    async create(hostId, input = {}) {
      users.requireVerified(hostId);
      const origin = requirePlace(input.origin, '출발지');
      const destination = requirePlace(input.destination, '도착지');
      const departAt = new Date(input.departAt);
      if (Number.isNaN(departAt.getTime())) throw badRequest('출발 시간이 올바르지 않습니다.');
      const now = Date.now();
      if (departAt.getTime() < now) throw badRequest('출발 시간은 현재 이후여야 합니다.');
      if (departAt.getTime() > now + MAX_ADVANCE_MS) throw badRequest('출발 시간은 7일 이내로 설정해 주세요.');
      const maxSeats = Number(input.maxSeats ?? 4);
      if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 4) throw badRequest('정원은 2~4명입니다.');
      const genderPref = input.genderPref ?? 'any';
      if (!GENDERS.includes(genderPref)) throw badRequest('성별 조건이 올바르지 않습니다.');
      const memo = typeof input.memo === 'string' ? input.memo.trim().slice(0, 200) : '';
      const meetingPoint = typeof input.meetingPoint === 'string' ? input.meetingPoint.trim().slice(0, 100) : '';

      const host = stmt.userById.get(hostId);
      if (genderPref !== 'any' && host.gender !== genderPref) {
        throw badRequest('본인이 참여할 수 없는 성별 조건입니다.');
      }
      if (input.orgOnly && !host.org_domain) throw badRequest('학교/회사 이메일 인증을 한 사용자만 소속 전용 합승을 만들 수 있어요.');
      assertNoOverlap(hostId, departAt.toISOString());

      const route = findRoute ? await findRoute(origin, destination) : null;

      const rideId = transaction(db, () => {
        const { lastInsertRowid } = stmt.insertRide.run(
          hostId, origin.name, origin.lat, origin.lng, destination.name, destination.lat, destination.lng,
          departAt.toISOString(), maxSeats, genderPref, memo, meetingPoint, input.orgOnly ? host.org_domain : null,
          route?.distanceKm ?? null, route?.durationMin ?? null, route?.taxiFare ?? null,
          route?.path?.length ? JSON.stringify(route.path) : null,
        );
        stmt.insertMember.run(lastInsertRowid, hostId, null, null, null, 1);
        return Number(lastInsertRowid);
      });
      return serialize(loadRide(rideId), { detail: true, memberView: true });
    },

    get(rideId, viewerId) {
      const ride = loadRide(rideId);
      return serialize(ride, { detail: true, memberView: Boolean(stmt.member.get(ride.id, viewerId)) });
    },

    /** 채팅방(멤버 전용 소켓 room)으로 보내는 실시간 갱신용 */
    getForMembers(rideId) {
      return serialize(loadRide(rideId), { detail: true, memberView: true });
    },

    /**
     * 모집 중인 합승 검색.
     *  - originLat/originLng, destLat/destLng, radiusKm: 경로 조건 (도착지는 '가는 길 하차'도 매칭)
     *  - from/to: 출발 시간 범위 (기본: 지금부터 7일)
     * 참여할 수 없는 방(성별·소속·차단·만석)은 제외하고, 경로 차이 + 시간 차이가 작은 순으로 정렬한다.
     */
    search(query = {}, viewerId) {
      const radiusKm = Math.min(Number(query.radiusKm) || DEFAULT_RADIUS_KM, 10);
      const viewer = stmt.userById.get(viewerId);
      const blocked = users.blockedSet(viewerId);
      const hasOrigin = query.originLat !== undefined && query.originLng !== undefined;
      const hasDest = query.destLat !== undefined && query.destLng !== undefined;
      const origin = hasOrigin && { lat: requireCoord(query.originLat, '출발지', 90), lng: requireCoord(query.originLng, '출발지', 180) };
      const destination = hasDest && { lat: requireCoord(query.destLat, '도착지', 90), lng: requireCoord(query.destLng, '도착지', 180) };

      const now = Date.now();
      const qFrom = optionalTime(query.from, '시작 시간');
      const qTo = optionalTime(query.to, '종료 시간');
      const from = Math.max(now, qFrom ?? now);
      const to = qTo ?? now + MAX_ADVANCE_MS;
      // 시간 차이 기준점: 범위를 주면 그 가운데, 아니면 지금
      const center = qFrom !== null && qTo !== null ? (qFrom + qTo) / 2 : (qFrom ?? now);

      const results = [];
      for (const ride of stmt.openRides.all(new Date(from).toISOString(), new Date(to).toISOString())) {
        const members = stmt.members.all(ride.id);
        const joined = members.some((m) => m.id === viewerId);
        if (!joined && (members.length >= ride.max_seats || eligibility(ride, viewer, blocked))) continue;
        const match = matchRoute(ride, { origin, destination, radiusKm });
        if (!match) continue;
        const timeDiffMin = Math.round(Math.abs(new Date(ride.depart_at).getTime() - center) / MIN);
        const item = serialize(ride);
        // 내가 참여하면 내야 할 예상 금액 (하차 지점 반영)
        const riders = [...members.map((m) => ({ userId: m.id, t: m.dropoff_t })), { userId: 0, t: match.t }];
        item.fare.mine = joined ? null : splitByDropoffs(item.fare.total, riders).get(0);
        results.push({
          ...item,
          joined,
          match: { type: match.type, t: Math.round(match.t * 100) / 100, mismatchKm: Math.round(match.mismatchKm * 100) / 100 },
          timeDiffMin,
          score: match.mismatchKm + timeDiffMin / 15, // 1km 차이 ≈ 15분 차이로 본다
        });
      }
      return results.sort((a, b) => a.score - b.score);
    },

    mine(userId) {
      return stmt.myRides.all(userId).map((ride) => serialize(ride));
    },

    /** 참여. dropoff: 가는 길에 먼저 내릴 곳 (생략하면 최종 도착지) */
    join(rideId, userId, { dropoff } = {}) {
      users.requireVerified(userId);
      const place = dropoff ? requirePlace(dropoff, '하차 지점') : null;
      const ride = loadRide(rideId);
      let t = 1;
      if (place && haversineKm(place.lat, place.lng, ride.dest_lat, ride.dest_lng) > SAME_DEST_KM) {
        const projected = projectOnRoute(routeOf(ride), place);
        if (projected.distanceKm > MAX_DROPOFF_DETOUR_KM) throw badRequest('하차 지점이 합승 경로에서 너무 멀어요.');
        t = Math.max(0.05, Math.min(1, projected.t));
      }
      const onTheWay = t < 1;

      const count = transaction(db, () => {
        const fresh = loadRide(rideId);
        if (fresh.status !== 'open') throw conflict('모집이 끝난 합승방입니다.');
        if (new Date(fresh.depart_at).getTime() < Date.now()) throw conflict('이미 출발 시간이 지났습니다.');
        if (stmt.member.get(fresh.id, userId)) throw conflict('이미 참여 중입니다.');
        const members = memberIdsOf(fresh.id);
        if (members.length >= fresh.max_seats) throw conflict('정원이 가득 찼습니다.');
        const reason = eligibility(fresh, stmt.userById.get(userId));
        if (reason) throw forbidden(reason);
        assertNoOverlap(userId, fresh.depart_at, fresh.id);
        stmt.insertMember.run(fresh.id, userId, onTheWay ? place.name : null, onTheWay ? place.lat : null,
          onTheWay ? place.lng : null, t);
        return members.length + 1;
      });

      const others = memberIdsOf(ride.id).filter((id) => id !== userId);
      const nickname = nicknameOf(userId);
      fire(others, {
        type: 'join', rideId: ride.id, title: '👋 새 동승자',
        body: `${nickname}님이 참여했어요 (${count}/${ride.max_seats}명)${onTheWay ? ` · ${place.name}에서 하차` : ''}`,
      });
      if (count === ride.max_seats) {
        fire(memberIdsOf(ride.id), {
          type: 'full', rideId: ride.id, title: '🎉 인원이 모두 모였어요',
          body: `${routeLabel(ride)} · ${kst(ride.depart_at)} 출발. 만남 장소를 확인해 주세요.`,
        });
      }
      return service.get(ride.id, userId);
    },

    /**
     * 나가기. 출발 10분 전 이후에 나가면 '직전 취소'로 기록된다.
     * 방장이 나가면 가장 먼저 들어온 멤버에게 위임하고, 남은 사람이 없으면 방을 취소한다.
     */
    leave(rideId, userId) {
      const ride = loadRide(rideId);
      const late = new Date(ride.depart_at).getTime() - Date.now() < LATE_CANCEL_MS;
      let newHostId = null;
      transaction(db, () => {
        const fresh = loadRide(rideId);
        if (fresh.status !== 'open') throw conflict('출발 이후에는 나갈 수 없습니다.');
        assertMember(fresh.id, userId);
        stmt.deleteMember.run(fresh.id, userId);
        const remaining = stmt.members.all(fresh.id);
        if (remaining.length === 0) {
          stmt.setStatus.run('cancelled', fresh.id);
        } else {
          if (late) stmt.bumpLateCancel.run(userId);
          if (fresh.host_id === userId) {
            newHostId = remaining[0].id;
            stmt.setHost.run(newHostId, fresh.id);
          }
        }
      });
      const remaining = memberIdsOf(ride.id);
      fire(remaining, {
        type: 'leave', rideId: ride.id, title: '🚪 동승자가 나갔어요',
        body: `${nicknameOf(userId)}님이 합승에서 나갔어요 (${remaining.length}/${ride.max_seats}명)`,
      });
      if (newHostId) {
        fire([newHostId], { type: 'host', rideId: ride.id, title: '👑 방장이 되었어요', body: `${routeLabel(ride)} 합승의 방장이 되었어요.` });
      }
      return { ride: service.get(ride.id, userId), lateCancel: late && remaining.length > 0 };
    },

    setMeetingPoint(rideId, userId, text) {
      const ride = loadRide(rideId);
      if (ride.host_id !== userId) throw forbidden('방장만 만남 장소를 바꿀 수 있습니다.');
      if (ride.status !== 'open') throw conflict('모집 중일 때만 바꿀 수 있습니다.');
      const meetingPoint = requireText(text, '만남 장소');
      stmt.setMeetingPoint.run(meetingPoint, ride.id);
      fire(memberIdsOf(ride.id).filter((id) => id !== userId), {
        type: 'meeting', rideId: ride.id, title: '📍 만남 장소 변경', body: meetingPoint,
      });
      return service.get(ride.id, userId);
    },

    /** 만남 장소 도착 체크인 */
    arrive(rideId, userId) {
      const ride = loadRide(rideId);
      assertMember(ride.id, userId);
      if (ride.status !== 'open') throw conflict('모집 중인 합승에서만 체크인할 수 있습니다.');
      if (new Date(ride.depart_at).getTime() - Date.now() > CHECKIN_OPEN_MS) {
        throw conflict('출발 1시간 전부터 체크인할 수 있어요.');
      }
      const { changes } = stmt.setArrived.run(new Date().toISOString(), ride.id, userId);
      if (changes) {
        fire(memberIdsOf(ride.id).filter((id) => id !== userId), {
          type: 'arrive', rideId: ride.id, title: '📍 만남 장소 도착', body: `${nicknameOf(userId)}님이 도착했어요.`,
        });
      }
      return service.get(ride.id, userId);
    },

    /**
     * 상태 변경 (방장). 출발 시 오지 않은 멤버(noShowIds)를 노쇼로 기록하고 합승에서 제외한다.
     * 도착 체크인한 사람은 노쇼로 처리할 수 없다.
     */
    updateStatus(rideId, userId, status, { noShowIds = [] } = {}) {
      const ride = loadRide(rideId);
      if (ride.host_id !== userId) throw forbidden('방장만 상태를 변경할 수 있습니다.');
      if (!TRANSITIONS[ride.status]?.includes(status)) {
        throw conflict(`'${ride.status}' 상태에서 '${status}'(으)로 변경할 수 없습니다.`);
      }
      const noShows = status === 'departed' && Array.isArray(noShowIds) ? [...new Set(noShowIds.map(Number))] : [];
      transaction(db, () => {
        for (const id of noShows) {
          const m = stmt.member.get(ride.id, id);
          if (!m || id === ride.host_id) throw badRequest('노쇼 처리할 수 없는 사용자입니다.');
          if (m.arrived_at) throw badRequest(`${nicknameOf(id)}님은 도착 체크인을 했어요.`);
          stmt.deleteMember.run(ride.id, id);
          stmt.bumpNoShow.run(id);
        }
        if (status === 'completed') stmt.setCompleted.run(new Date().toISOString(), ride.id);
        else stmt.setStatus.run(status, ride.id);
      });

      const members = memberIdsOf(ride.id);
      const others = members.filter((id) => id !== userId);
      if (noShows.length) {
        fire(noShows, { type: 'noshow', rideId: ride.id, title: '⚠️ 노쇼로 기록되었어요', body: `${routeLabel(ride)} 합승이 회원님 없이 출발했어요.` });
      }
      const messages = {
        departed: { title: '🚕 출발했어요', body: `${routeLabel(ride)} · 도착하면 정산을 진행해 주세요.` },
        completed: { title: '✅ 도착 완료', body: '정산을 마무리하고 동승자를 평가해 주세요.' },
        cancelled: { title: '❌ 합승 취소', body: `${routeLabel(ride)} 합승이 취소되었어요.` },
      };
      fire(others, { type: status, rideId: ride.id, ...messages[status] });
      return service.get(ride.id, userId);
    },

    /** 정산 요청: 택시비를 결제한 사람이 실제 요금과 받을 계좌를 입력한다 */
    settle(rideId, userId, { actualFare, account } = {}) {
      const ride = loadRide(rideId);
      assertMember(ride.id, userId);
      if (!['departed', 'completed'].includes(ride.status)) throw conflict('출발 후에 정산할 수 있어요.');
      const fare = Number(actualFare);
      if (!Number.isInteger(fare) || fare < 1000 || fare > 1_000_000) throw badRequest('실제 요금을 원 단위로 입력해 주세요.');
      const accountText = typeof account === 'string' ? account.trim().slice(0, 100) : '';
      if (!accountText) throw badRequest('받을 계좌(또는 송금 방법)를 입력해 주세요.');
      const members = stmt.members.all(ride.id);
      if (ride.payer_id && ride.payer_id !== userId) throw conflict(`이미 ${nicknameOf(ride.payer_id)}님이 정산을 요청했어요.`);
      if (ride.payer_id && members.some((m) => m.paid_at)) throw conflict('이미 송금한 사람이 있어 수정할 수 없어요.');

      transaction(db, () => {
        stmt.setSettlement.run(userId, fare, accountText, ride.id);
        stmt.resetPaid.run(ride.id);
      });
      const settlement = settlementOf(loadRide(ride.id), stmt.members.all(ride.id));
      const payer = nicknameOf(userId);
      for (const share of settlement.shares.filter((s) => s.userId !== userId)) {
        fire([share.userId], {
          type: 'settle', rideId: ride.id, title: '💸 정산 요청',
          body: `${payer}님에게 ${won(share.amount)}을 보내주세요 (총 ${won(fare)}) · ${accountText}`,
        });
      }
      return service.get(ride.id, userId);
    },

    /** 송금 완료 표시. 본인이 누르거나, 결제한 사람이 받은 것을 확인해 누른다. */
    markPaid(rideId, userId, targetId = userId) {
      const ride = loadRide(rideId);
      assertMember(ride.id, userId);
      if (!ride.payer_id) throw conflict('아직 정산 요청이 없어요.');
      const target = Number(targetId);
      if (target !== userId && userId !== ride.payer_id) throw forbidden('결제한 사람만 다른 사람의 송금을 확인할 수 있어요.');
      if (target === ride.payer_id) throw badRequest('결제한 사람은 송금할 필요가 없어요.');
      assertMember(ride.id, target);
      stmt.setPaid.run(new Date().toISOString(), ride.id, target);

      const settlement = settlementOf(loadRide(ride.id), stmt.members.all(ride.id));
      if (target === userId) {
        const amount = settlement.shares.find((s) => s.userId === target).amount;
        fire([ride.payer_id], { type: 'paid', rideId: ride.id, title: '💰 송금 완료', body: `${nicknameOf(target)}님이 ${won(amount)} 송금 완료를 눌렀어요.` });
      }
      if (settlement.allPaid) {
        fire(memberIdsOf(ride.id), { type: 'settled', rideId: ride.id, title: '🎉 정산 완료', body: `${routeLabel(ride)} 합승 정산이 모두 끝났어요.` });
      }
      return service.get(ride.id, userId);
    },

    memberIds(rideId) {
      return memberIdsOf(Number(rideId));
    },

    isMember(rideId, userId) {
      return Boolean(stmt.member.get(Number(rideId), userId));
    },

    /** 이 사용자에게 보여줄 수 있는 방인지 (경로 알림용) */
    canJoin(rideId, userId) {
      const ride = loadRide(rideId);
      const user = stmt.userById.get(userId);
      return Boolean(user?.email_verified) && !stmt.member.get(ride.id, userId) && !eligibility(ride, user);
    },

    rideRow(rideId) {
      return loadRide(rideId);
    },

    messages(rideId, userId, afterId = 0) {
      const ride = loadRide(rideId);
      assertMember(ride.id, userId);
      return stmt.messages.all(ride.id, Number(afterId) || 0);
    },

    postMessage(rideId, userId, body) {
      const ride = loadRide(rideId);
      assertMember(ride.id, userId);
      const text = requireText(body, '메시지', 500);
      const { lastInsertRowid } = stmt.insertMessage.run(ride.id, userId, text);
      const message = stmt.messageById.get(lastInsertRowid);
      // 채팅방을 보고 있지 않은 멤버에게만 푸시 (알림함에는 저장하지 않음)
      fire(memberIdsOf(ride.id).filter((id) => id !== userId), {
        type: 'chat', rideId: ride.id, title: `💬 ${message.nickname}`, body: text.slice(0, 100),
        skipViewers: true, store: false,
      });
      return message;
    },

    /**
     * 주기 작업 (1분마다):
     *  - 출발 10분 전 알림
     *  - 출발 30분이 지났는데 '출발' 처리가 안 된 방: 2명 이상 체크인했으면 출발로, 아니면 취소
     *  - 출발 3시간 지난 방은 도착 완료 처리 (정산·평가 안내)
     * → 변경된 합승 id 목록 (실시간 갱신용)
     */
    tick(now = Date.now()) {
      const changed = [];
      for (const ride of stmt.dueReminders.all(new Date(now + REMINDER_MS).toISOString(), new Date(now).toISOString())) {
        stmt.setReminded.run(new Date(now).toISOString(), ride.id);
        const members = stmt.members.all(ride.id);
        if (members.length < 2) continue;
        fire(members.map((m) => m.id), {
          type: 'reminder', rideId: ride.id, title: '⏰ 곧 출발해요',
          body: `${kst(ride.depart_at)} 출발 · 만남 장소: ${ride.meeting_point || ride.origin_name}. 도착하면 '도착했어요'를 눌러주세요.`,
        });
      }
      for (const ride of stmt.expired.all(new Date(now - EXPIRE_AFTER_MS).toISOString())) {
        const members = stmt.members.all(ride.id);
        const arrived = members.filter((m) => m.arrived_at).length;
        const departed = arrived >= 2;
        stmt.setStatus.run(departed ? 'departed' : 'cancelled', ride.id);
        changed.push(ride.id);
        fire(members.map((m) => m.id), departed
          ? { type: 'departed', rideId: ride.id, title: '🚕 출발 처리되었어요', body: '도착하면 정산을 진행해 주세요.' }
          : { type: 'cancelled', rideId: ride.id, title: '⌛ 합승이 종료되었어요', body: `${routeLabel(ride)} 합승이 출발 처리되지 않아 자동 종료되었어요.` });
      }
      for (const ride of stmt.staleDeparted.all(new Date(now - AUTO_COMPLETE_MS).toISOString())) {
        stmt.setCompleted.run(new Date(now).toISOString(), ride.id);
        changed.push(ride.id);
        fire(memberIdsOf(ride.id), { type: 'completed', rideId: ride.id, title: '✅ 도착 완료', body: '정산을 마무리하고 동승자를 평가해 주세요.' });
      }
      return changed;
    },
  };
  return service;
}
