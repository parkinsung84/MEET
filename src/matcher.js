import { badRequest, conflict, notFound } from './errors.js';
import { haversineKm } from './geo.js';

const MIN = 60 * 1000;
const MAX_WINDOW_MS = 3 * 60 * MIN;     // 요청은 최대 3시간 범위
const MIN_LEAD_MS = 5 * MIN;            // 자동으로 만드는 방은 최소 5분 뒤 출발 (만날 시간)
const DEMAND_KM = 2;                    // 수요 표시: 출발·도착 2km 안의 요청·알림

/**
 * 자동 매칭.
 *  1) 요청을 올리면 맞는 방이 있을 때 바로 참여시킨다 (가는 길 하차 포함).
 *  2) 없으면 조건이 맞는 다른 대기 요청과 짝지어 방을 만들고, 나머지 대기 요청도 그 방에 넣어 본다.
 *  3) 그래도 없으면 기다리다가 새 방·새 요청이 생기거나 주기 작업 때 다시 시도한다.
 * 같은 성별끼리만 자동으로 방을 만든다 (일반 택시 합승 기준).
 */
export function createMatcher(db, { rides, users, notifier, onChange = () => {}, log = console }) {
  const stmt = {
    insert: db.prepare(`INSERT INTO ride_requests (user_id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng,
      window_from, window_to, radius_km, org_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    byId: db.prepare('SELECT * FROM ride_requests WHERE id = ?'),
    active: db.prepare(`SELECT * FROM ride_requests WHERE user_id = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1`),
    latest: db.prepare('SELECT * FROM ride_requests WHERE user_id = ? ORDER BY id DESC LIMIT 1'),
    waiting: db.prepare(`SELECT * FROM ride_requests WHERE status = 'waiting' AND window_to > ? ORDER BY id`),
    expired: db.prepare(`SELECT * FROM ride_requests WHERE status = 'waiting' AND window_to <= ?`),
    setStatus: db.prepare('UPDATE ride_requests SET status = ?, ride_id = ? WHERE id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    alerts: db.prepare('SELECT * FROM ride_alerts WHERE depart_to > ? AND depart_from < ?'),
  };
  const locked = new Set(); // 방을 만드는 중(비동기)인 요청

  const fire = (userIds, n) => notifier.notify(userIds, n).catch((err) => log.error('[notify]', err.message));
  const place = (r, kind) => ({ name: r[`${kind}_name`], lat: r[`${kind}_lat`], lng: r[`${kind}_lng`] });
  const toJson = (r) => r && {
    id: r.id, status: r.status, rideId: r.ride_id, radiusKm: r.radius_km, orgOnly: Boolean(r.org_only),
    origin: place(r, 'origin'), destination: place(r, 'dest'), from: r.window_from, to: r.window_to, createdAt: r.created_at,
  };

  function markMatched(request, rideId) {
    stmt.setStatus.run('matched', rideId, request.id);
    onChange(rideId);
    const ride = rides.rideRow(rideId);
    fire([request.user_id], {
      type: 'matched', rideId, title: '🎉 합승이 매칭됐어요',
      body: `${ride.origin_name} → ${ride.dest_name} · 만남 장소와 출발 시간을 확인해 주세요.`,
    });
  }

  /** 1) 기존 방 중 가장 잘 맞는 곳에 참여 */
  function joinExisting(request, onlyRideId = null) {
    const user = stmt.userById.get(request.user_id);
    const candidates = rides.search({
      originLat: request.origin_lat, originLng: request.origin_lng, destLat: request.dest_lat, destLng: request.dest_lng,
      radiusKm: request.radius_km, from: request.window_from, to: request.window_to,
    }, request.user_id, { log: onlyRideId === null }).filter((r) => !r.joined && r.memberCount < r.maxSeats
      && (onlyRideId === null || r.id === onlyRideId)
      && (!request.org_only || (user.org_domain && r.orgOnly === user.org_domain)));
    for (const ride of candidates) {
      try {
        // 도착지가 방 도착지와 다르면 하차 지점으로 참여 (같으면 서버가 알아서 최종 도착지로 처리)
        rides.join(ride.id, request.user_id, { dropoff: place(request, 'dest') });
        markMatched(request, ride.id);
        return ride.id;
      } catch (err) {
        // 시간이 겹치는 다른 합승 등 — 다음 후보
        log.debug?.('[match] join failed', err.message);
      }
    }
    return null;
  }

  /** 두 요청이 같이 탈 수 있는지 → 가능하면 { from, to, score } */
  function compatible(a, b) {
    if (a.user_id === b.user_id) return null;
    const ua = stmt.userById.get(a.user_id);
    const ub = stmt.userById.get(b.user_id);
    if (ua.gender !== ub.gender) return null;
    if (users.blockedSet(a.user_id).has(b.user_id)) return null;
    if ((a.org_only || b.org_only) && (!ua.org_domain || ua.org_domain !== ub.org_domain)) return null;
    const radius = Math.min(a.radius_km, b.radius_km);
    const o = haversineKm(a.origin_lat, a.origin_lng, b.origin_lat, b.origin_lng);
    const d = haversineKm(a.dest_lat, a.dest_lng, b.dest_lat, b.dest_lng);
    if (o > radius || d > radius) return null;
    const from = Math.max(Date.parse(a.window_from), Date.parse(b.window_from), Date.now() + MIN_LEAD_MS);
    const to = Math.min(Date.parse(a.window_to), Date.parse(b.window_to));
    if (from > to) return null;
    return { from, to, score: o + d };
  }

  /** 2) 대기 중인 요청과 짝지어 방 만들기 (먼저 기다린 사람이 방장, 그 사람 출발지가 만남 장소) */
  async function pairWithWaiting(request) {
    let best = null;
    for (const other of stmt.waiting.all(new Date().toISOString())) {
      if (other.id === request.id || locked.has(other.id)) continue;
      const fit = compatible(other, request);
      if (fit && (!best || fit.score < best.fit.score)) best = { other, fit };
    }
    if (!best) return null;
    const { other, fit } = best;
    locked.add(other.id);
    locked.add(request.id);
    try {
      const ride = await rides.create(other.user_id, {
        origin: place(other, 'origin'),
        destination: place(other, 'dest'),
        departAt: new Date(fit.from).toISOString(),
        maxSeats: 4,
        taxiType: 'standard',
        meetingPoint: other.origin_name,
        orgOnly: Boolean(other.org_only || request.org_only),
        memo: '🤖 자동 매칭으로 만들어진 합승방이에요. 채팅으로 인사하고 만남 장소를 확인해 주세요.',
      });
      markMatched(other, ride.id);
      try {
        rides.join(ride.id, request.user_id, { dropoff: place(request, 'dest') });
        markMatched(request, ride.id);
      } catch (err) {
        log.warn?.('[match] pair join failed', err.message);
      }
      return ride.id;
    } catch (err) {
      log.warn?.('[match] create failed', err.message);
      return null;
    } finally {
      locked.delete(other.id);
      locked.delete(request.id);
    }
  }

  async function tryMatch(request) {
    if (locked.has(request.id)) return null;
    const fresh = stmt.byId.get(request.id);
    if (fresh.status !== 'waiting') return fresh.ride_id;
    const joined = joinExisting(fresh);
    if (joined) return joined;
    const created = await pairWithWaiting(fresh);
    if (created) await matcher.onRideCreated(created, { notifySimilar: false });
    return created;
  }

  const matcher = {
    /** 매칭 요청 (한 사람당 대기 중인 요청 하나) → 바로 매칭 시도 */
    async request(userId, input = {}) {
      users.requireVerified(userId);
      if (stmt.active.get(userId)) throw conflict('이미 매칭을 기다리는 요청이 있어요. 취소 후 다시 요청해 주세요.');
      const origin = input.origin;
      const destination = input.destination;
      for (const [p, label] of [[origin, '출발지'], [destination, '도착지']]) {
        if (typeof p?.name !== 'string' || !p.name.trim() || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lng))) {
          throw badRequest(`${label}를 선택해 주세요.`);
        }
      }
      const now = Date.now();
      const from = Math.max(now, Date.parse(input.from ?? now));
      const to = Date.parse(input.to ?? now + 30 * MIN);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from + MIN_LEAD_MS) throw badRequest('출발 가능 시간 범위를 10분 이상으로 정해 주세요.');
      if (to - from > MAX_WINDOW_MS) throw badRequest('출발 가능 시간은 최대 3시간 범위로 정해 주세요.');
      const radiusKm = Math.min(Math.max(Number(input.radiusKm) || 1, 0.3), 3);
      const user = stmt.userById.get(userId);
      if (input.orgOnly && !user.org_domain) throw badRequest('학교·회사 이메일 인증을 해야 소속 전용 매칭을 쓸 수 있어요.');

      const { lastInsertRowid } = stmt.insert.run(userId, origin.name.trim(), Number(origin.lat), Number(origin.lng),
        destination.name.trim(), Number(destination.lat), Number(destination.lng),
        new Date(from).toISOString(), new Date(to).toISOString(), radiusKm, input.orgOnly ? 1 : 0);
      const request = stmt.byId.get(lastInsertRowid);
      await tryMatch(request);
      return toJson(stmt.byId.get(request.id));
    },

    /** 내 최근 요청 (대기 중이거나 방금 매칭된 것) */
    current(userId) {
      return toJson(stmt.latest.get(userId)) ?? null;
    },

    cancel(userId) {
      const request = stmt.active.get(userId);
      if (!request) throw notFound('기다리는 매칭 요청이 없어요.');
      stmt.setStatus.run('cancelled', null, request.id);
      return toJson(stmt.byId.get(request.id));
    },

    /**
     * 새 합승방이 생겼을 때: 대기 중인 요청을 그 방에 넣어 보고,
     * 근처에 비슷한 방이 있으면 그 방장들에게 "합치면 더 싸져요" 알림.
     */
    async onRideCreated(rideId, { notifySimilar = true } = {}) {
      for (const request of stmt.waiting.all(new Date().toISOString())) {
        if (locked.has(request.id)) continue;
        const row = rides.rideRow(rideId);
        if (row.status !== 'open' || rides.memberIds(rideId).length >= row.max_seats) break;
        joinExisting(request, rideId);
      }
      if (!notifySimilar) return;
      const ride = rides.rideRow(rideId);
      for (const other of rides.similarRides(rideId, ride.host_id)) {
        fire([other.hostId], {
          type: 'similar', rideId: other.id, title: '🔀 근처에 비슷한 합승방이 생겼어요',
          body: `${ride.origin_name} → ${ride.dest_name} · 방을 합치면 1인당 요금이 줄어요. 방장이면 '이 방으로 합치기'를 눌러 보세요.`,
        });
      }
    },

    /** 이 경로를 찾고 있는 다른 사람 수 (대기 중인 매칭 요청 + 경로 알림) */
    demand({ origin, destination, from, to }, userId) {
      const now = Date.now();
      const start = new Date(from ? Math.max(now, Date.parse(from)) : now).toISOString();
      const end = new Date(to ? Date.parse(to) : now + 24 * 60 * MIN).toISOString();
      const near = (r, kind, p) => haversineKm(r[`${kind}_lat`], r[`${kind}_lng`], p.lat, p.lng) <= DEMAND_KM;
      const people = new Set();
      for (const r of stmt.waiting.all(new Date(now).toISOString())) {
        if (r.window_from < end && r.window_to > start && near(r, 'origin', origin) && near(r, 'dest', destination)) people.add(r.user_id);
      }
      for (const a of stmt.alerts.all(start, end)) {
        if (near(a, 'origin', origin) && near(a, 'dest', destination)) people.add(a.user_id);
      }
      people.delete(userId);
      return people.size;
    },

    /** 주기 작업: 만료 처리 + 대기 요청 재시도 */
    async tick(now = Date.now()) {
      for (const request of stmt.expired.all(new Date(now).toISOString())) {
        stmt.setStatus.run('expired', null, request.id);
        fire([request.user_id], {
          type: 'match-expired', title: '⌛ 매칭 시간이 끝났어요',
          body: `${request.origin_name} → ${request.dest_name} 요청에 맞는 동승자를 찾지 못했어요. 직접 방을 만들거나 다시 요청해 보세요.`,
        });
      }
      for (const request of stmt.waiting.all(new Date(now).toISOString())) await tryMatch(request);
    },
  };
  return matcher;
}
