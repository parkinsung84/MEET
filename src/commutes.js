import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { getDong } from './dongs.js';
import { estimateFare, haversineKm, splitFare } from './geo.js';

/**
 * 정기 노선 (출퇴근 택시 크루).
 * 서울 행정동 427개 사이의 "출발 동 → 도착 동" 노선이 미리 깔려 있고, 그 노선에서 요일·시각을 정한 크루를
 * 만들거나 참여한다 (예: 강남구 역삼1동 → 종로구 종로1·2·3·4가동, 월~금 08:00).
 * 노선 목록·상세는 로그인 없이도 볼 수 있어 링크로 퍼뜨릴 수 있고, 정확한 출발 위치·만남 장소는 멤버에게만 보인다.
 * 운행하는 날에는 출발 1시간 전에 멤버들로 합승방을 자동으로 연다 (못 타는 사람은 그 합승방에서 나가면 된다)
 * → 체크인·차량번호·정산·긴급신고 등 기존 합승 기능을 그대로 쓴다.
 */

const MIN = 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * MIN;
export const DAY_BITS = { mon: 1, tue: 2, wed: 4, thu: 8, fri: 16, sat: 32, sun: 64 };
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토', sun: '일' };
const GENDERS = ['any', 'male', 'female'];
const TRIP_OPEN_BEFORE_MS = 60 * MIN;  // 출발 1시간 전에 그날 합승방을 연다
const SEARCH_RADIUS_KM = 3;
const SEARCH_TIME_WINDOW_MIN = 30;
const MAX_MEMBERSHIPS = 6;              // 한 사람이 참여할 수 있는 노선 수

// ---------- 한국 시간 도우미 (서버 시간대와 무관하게 KST 기준) ----------

/** 시각(ms) → 한국 시간 { date: 'YYYY-MM-DD', dayKey: 'mon'…, minutes: 0~1439 } */
export function kstParts(ms) {
  const d = new Date(ms + KST_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  const dayKey = DAY_ORDER[(d.getUTCDay() + 6) % 7];
  return { date, dayKey, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

/** 한국 날짜 'YYYY-MM-DD' + 'HH:MM' → 그 순간(ms) */
export function kstInstant(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - KST_OFFSET_MS;
}

const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const dayKeyOf = (date) => DAY_ORDER[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
const runsOn = (days, date) => Boolean(days & DAY_BITS[dayKeyOf(date)]);
const minutesOf = (time) => { const [h, m] = time.split(':').map(Number); return h * 60 + m; };

/** 요일 비트 → "월~금", "월·수·금", "매일" */
export function daysLabel(days) {
  const keys = DAY_ORDER.filter((k) => days & DAY_BITS[k]);
  if (keys.length === 7) return '매일';
  if (days === 31) return '월~금';
  if (days === 96) return '주말';
  return keys.map((k) => DAY_LABELS[k]).join('·');
}

/** 다음 운행 일시 (지금 이후) → { date, at } */
export function nextRun(days, time, now = Date.now()) {
  const today = kstParts(now).date;
  for (let i = 0; i < 8; i += 1) {
    const date = addDays(today, i);
    const at = kstInstant(date, time);
    if (runsOn(days, date) && at > now) return { date, at };
  }
  return null;
}

/** 서울 행정동 코드 → 동 (없으면 400) */
function requireDong(code, label) {
  const dong = getDong(code);
  if (!dong) throw badRequest(`${label} 동을 골라 주세요.`);
  return dong;
}

function parseDays(input) {
  const list = Array.isArray(input) ? input : [];
  let bits = 0;
  for (const key of list) {
    if (!(key in DAY_BITS)) throw badRequest('요일이 올바르지 않습니다.');
    bits |= DAY_BITS[key];
  }
  if (!bits) throw badRequest('타는 요일을 하나 이상 골라 주세요.');
  return bits;
}

function parseTime(input) {
  if (typeof input !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input)) throw badRequest('출발 시각을 HH:MM 형식으로 입력해 주세요.');
  return input;
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/**
 * rides: 합승방 서비스 (그날 합승방 자동 생성), users, notifier, findRoute(선택: 네이버 길찾기)
 */
export function createCommuteService(db, { rides, users, notifier, findRoute = null, locationLog = null, log = console }) {
  const stmt = {
    insert: db.prepare(`INSERT INTO commutes (owner_id, origin_name, origin_lat, origin_lng, origin_area, origin_code, dest_name, dest_lat, dest_lng,
      dest_area, dest_code, days, depart_time, max_seats, gender_pref, meeting_point, memo, distance_km, taxi_fare)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    popular: db.prepare(`SELECT c.origin_code AS "from", c.dest_code AS "to", COUNT(DISTINCT c.id) AS crews, COUNT(m.user_id) AS riders
      FROM commutes c JOIN commute_members m ON m.commute_id = c.id
      WHERE c.status = 'open' AND c.origin_code IS NOT NULL GROUP BY c.origin_code, c.dest_code ORDER BY riders DESC, crews DESC LIMIT ?`),
    byId: db.prepare('SELECT * FROM commutes WHERE id = ?'),
    open: db.prepare(`SELECT * FROM commutes WHERE status = 'open' ORDER BY id DESC LIMIT 500`),
    update: db.prepare(`UPDATE commutes SET days = ?, depart_time = ?, max_seats = ?, gender_pref = ?, meeting_point = ?, memo = ?,
      status = ? WHERE id = ?`),
    setOwner: db.prepare('UPDATE commutes SET owner_id = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE commutes SET status = ? WHERE id = ?'),
    members: db.prepare(`SELECT u.id, u.nickname, u.gender, m.joined_at AS joinedAt FROM commute_members m
      JOIN users u ON u.id = m.user_id WHERE m.commute_id = ? ORDER BY m.joined_at, u.id`),
    memberIds: db.prepare('SELECT user_id AS id FROM commute_members WHERE commute_id = ? ORDER BY joined_at, user_id'),
    isMember: db.prepare('SELECT 1 FROM commute_members WHERE commute_id = ? AND user_id = ?'),
    addMember: db.prepare('INSERT INTO commute_members (commute_id, user_id) VALUES (?, ?)'),
    removeMember: db.prepare('DELETE FROM commute_members WHERE commute_id = ? AND user_id = ?'),
    countMemberships: db.prepare(`SELECT COUNT(*) AS n FROM commute_members m JOIN commutes c ON c.id = m.commute_id
      WHERE m.user_id = ? AND c.status = 'open'`),
    mine: db.prepare(`SELECT c.* FROM commutes c JOIN commute_members m ON m.commute_id = c.id WHERE m.user_id = ? ORDER BY c.depart_time`),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    messages: db.prepare(`SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM commute_messages msg JOIN users u ON u.id = msg.user_id WHERE msg.commute_id = ? AND msg.id > ? ORDER BY msg.id LIMIT 200`),
    insertMessage: db.prepare('INSERT INTO commute_messages (commute_id, user_id, body) VALUES (?, ?, ?)'),
    messageById: db.prepare(`SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM commute_messages msg JOIN users u ON u.id = msg.user_id WHERE msg.id = ?`),
    trip: db.prepare('SELECT * FROM commute_trips WHERE commute_id = ? AND date = ?'),
    putTrip: db.prepare('INSERT OR IGNORE INTO commute_trips (commute_id, date, ride_id) VALUES (?, ?, ?)'),
    setTripRide: db.prepare('UPDATE commute_trips SET ride_id = ? WHERE commute_id = ? AND date = ?'),
  };

  function fire(userIds, notification) {
    if (!notifier || !userIds.length) return;
    notifier.notify(userIds, notification).catch((err) => log.error('[notify]', err.message));
  }

  function load(id) {
    const c = stmt.byId.get(Number(id));
    if (!c) throw notFound('존재하지 않는 노선입니다.');
    return c;
  }
  const memberIdsOf = (id) => stmt.memberIds.all(id).map((r) => r.id);
  const label = (c) => `${c.origin_area} → ${c.dest_area} ${daysLabel(c.days)} ${c.depart_time}`;

  function assertMember(c, userId) {
    if (!stmt.isMember.get(c.id, userId)) throw forbidden('노선 멤버만 이용할 수 있어요.');
  }
  function assertOwner(c, userId) {
    if (c.owner_id !== userId) throw forbidden('노선을 만든 사람만 할 수 있어요.');
  }

  /** 참여할 수 없는 이유 (없으면 null) */
  function joinBlocker(c, user) {
    if (c.status !== 'open') return '모집을 마친 노선이에요.';
    const members = memberIdsOf(c.id);
    if (members.length >= c.max_seats) return '자리가 모두 찼어요.';
    if (c.gender_pref !== 'any' && user.gender !== c.gender_pref) return '성별 조건이 맞지 않아 참여할 수 없어요.';
    const blocked = users.blockedSet(user.id);
    if (members.some((id) => blocked.has(id))) return '참여할 수 없는 노선이에요.';
    return null;
  }

  /**
   * 목록·상세 공통 정보. 로그인하지 않은 사람도 볼 수 있는 정보만 (정확한 위치·만남 장소 제외).
   * member: 멤버에게만 보이는 정보 포함
   */
  function serialize(c, { viewerId = null, detail = false } = {}) {
    const members = stmt.members.all(c.id);
    const owner = users.profile(c.owner_id);
    const fare = c.taxi_fare ?? estimateFare(c.origin_lat, c.origin_lng, c.dest_lat, c.dest_lng).fare;
    const next = c.status === 'open' ? nextRun(c.days, c.depart_time) : null;
    const isMember = viewerId != null && members.some((m) => m.id === viewerId);
    const out = {
      id: c.id,
      origin: { area: c.origin_area, code: c.origin_code },
      destination: { area: c.dest_area, code: c.dest_code },
      days: DAY_ORDER.filter((k) => c.days & DAY_BITS[k]),
      daysLabel: daysLabel(c.days),
      departTime: c.depart_time,
      maxSeats: c.max_seats,
      memberCount: members.length,
      seatsLeft: Math.max(0, c.max_seats - members.length),
      genderPref: c.gender_pref,
      memo: c.memo,
      status: c.status,
      distanceKm: c.distance_km ?? estimateFare(c.origin_lat, c.origin_lng, c.dest_lat, c.dest_lng).distanceKm,
      fare: { total: fare, perPerson: splitFare(fare, c.max_seats), perPersonNow: splitFare(fare, Math.max(2, members.length)) },
      owner: { nickname: owner.nickname, gender: owner.gender, verified: owner.verified, stats: owner.stats },
      nextRun: next ? new Date(next.at).toISOString() : null,
      createdAt: c.created_at,
      joined: isMember,
      isOwner: viewerId === c.owner_id,
    };
    if (detail) {
      out.members = members.map((m) => {
        const p = users.profile(m.id);
        return { id: m.id, nickname: m.nickname, gender: m.gender, verified: p.verified, stats: p.stats, isOwner: m.id === c.owner_id };
      });
    }
    if (isMember) {
      out.origin = { ...out.origin, name: c.origin_name, lat: c.origin_lat, lng: c.origin_lng };
      out.destination = { ...out.destination, name: c.dest_name, lat: c.dest_lat, lng: c.dest_lng };
      out.meetingPoint = c.meeting_point || c.origin_name;
      if (detail) out.currentRide = currentRide(c);
    }
    return out;
  }

  /** 멤버에게: 지금 열려 있는 그날 합승방 (출발 후 3시간까지) → { rideId, departAt } 또는 null */
  function currentRide(c) {
    const now = Date.now();
    const today = kstParts(now).date;
    for (const date of [addDays(today, -1), today, addDays(today, 1)]) {
      const trip = stmt.trip.get(c.id, date);
      const at = kstInstant(date, c.depart_time);
      if (trip?.ride_id && at > now - 3 * 60 * MIN) return { rideId: trip.ride_id, departAt: new Date(at).toISOString() };
    }
    return null;
  }

  function nearEnough(c, q) {
    const radius = Math.min(Math.max(Number(q.radiusKm) || SEARCH_RADIUS_KM, 0.5), 10);
    if (q.originLat != null && haversineKm(Number(q.originLat), Number(q.originLng), c.origin_lat, c.origin_lng) > radius) return false;
    if (q.destLat != null && haversineKm(Number(q.destLat), Number(q.destLng), c.dest_lat, c.dest_lng) > radius) return false;
    if (q.time && /^\d{2}:\d{2}$/.test(q.time) && Math.abs(minutesOf(q.time) - minutesOf(c.depart_time)) > SEARCH_TIME_WINDOW_MIN) return false;
    if (q.days) {
      const bits = parseDays(String(q.days).split(','));
      if (!(bits & c.days)) return false;
    }
    return true;
  }

  const service = {
    /** 노선 올리기 → 만든 사람이 첫 멤버 */
    async create(ownerId, input = {}) {
      users.requireVerified(ownerId);
      const origin = requireDong(input.from, '출발');
      const destination = requireDong(input.to, '도착');
      if (origin.code === destination.code) throw badRequest('출발 동과 도착 동이 같아요.');
      const days = parseDays(input.days);
      const time = parseTime(input.departTime);
      const maxSeats = Number(input.maxSeats ?? 4);
      if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 4) throw badRequest('정원은 2~4명입니다.');
      const genderPref = input.genderPref ?? 'any';
      if (!GENDERS.includes(genderPref)) throw badRequest('성별 조건이 올바르지 않습니다.');
      const owner = stmt.userById.get(ownerId);
      if (genderPref !== 'any' && owner.gender !== genderPref) throw badRequest('본인이 참여할 수 없는 성별 조건입니다.');
      if (stmt.countMemberships.get(ownerId).n >= MAX_MEMBERSHIPS) throw conflict(`노선은 ${MAX_MEMBERSHIPS}개까지 참여할 수 있어요.`);

      const route = findRoute ? await findRoute(origin, destination) : null;
      const id = transaction(db, () => {
        const { lastInsertRowid } = stmt.insert.run(ownerId, origin.name, origin.lat, origin.lng, origin.name, origin.code,
          destination.name, destination.lat, destination.lng, destination.name, destination.code, days, time, maxSeats, genderPref,
          text(input.meetingPoint, 100), text(input.memo, 300), route?.distanceKm ?? null, route?.taxiFare ?? null);
        stmt.addMember.run(lastInsertRowid, ownerId);
        return Number(lastInsertRowid);
      });
      locationLog?.record(ownerId, { action: 'commute_create', purpose: '정기 노선 크루 만들기 — 출발·도착 동을 누구나 볼 수 있게 공개' });
      return service.get(id, ownerId);
    },

    /**
     * 노선 찾기 (로그인 없이도 가능).
     * 조건 없이 부르면 올라온 노선 전체. originLat 등을 주면 출발지·도착지 3km, 시각 ±30분, 겹치는 요일로 거른다.
     * nearLat/nearLng 는 거르지 않고 출발지가 가까운 순으로 정렬만 한다.
     */
    search(query = {}, viewerId = null) {
      const list = stmt.open.all().filter((c) => nearEnough(c, query)
        && (!query.from || c.origin_code === String(query.from)) && (!query.to || c.dest_code === String(query.to)));
      const near = query.nearLat != null ? { lat: Number(query.nearLat), lng: Number(query.nearLng) } : null;
      const score = (c) => (query.originLat != null ? haversineKm(Number(query.originLat), Number(query.originLng), c.origin_lat, c.origin_lng) : 0)
        + (query.destLat != null ? haversineKm(Number(query.destLat), Number(query.destLng), c.dest_lat, c.dest_lng) : 0)
        + (near && Number.isFinite(near.lat) ? haversineKm(near.lat, near.lng, c.origin_lat, c.origin_lng) : 0);
      // 가까운 순(위치를 줬을 때) → 자리 남은 노선 먼저 → 최신순
      const sorted = query.originLat != null || query.destLat != null || near ? list.sort((a, b) => score(a) - score(b)) : list;
      return sorted.map((c) => serialize(c, { viewerId }))
        .sort((a, b) => (b.seatsLeft > 0) - (a.seatsLeft > 0))
        .slice(0, 300);
    },

    get(id, viewerId = null) {
      return serialize(load(id), { viewerId, detail: true });
    },

    /**
     * 미리 깔린 노선 (출발 동 → 도착 동): 이 노선의 크루들(출발 시각 순)과,
     * 양 끝이 1.5km 안인 이웃 동 노선의 크루(같이 타기 괜찮은 경우)를 함께 보여준다.
     */
    route(fromCode, toCode, viewerId = null) {
      const from = requireDong(fromCode, '출발');
      const to = requireDong(toCode, '도착');
      if (from.code === to.code) throw badRequest('출발 동과 도착 동이 같아요.');
      const { fare, distanceKm } = estimateFare(from.lat, from.lng, to.lat, to.lng);
      const open = stmt.open.all();
      const exact = open.filter((c) => c.origin_code === from.code && c.dest_code === to.code);
      const nearby = open.filter((c) => !(c.origin_code === from.code && c.dest_code === to.code)
        && haversineKm(from.lat, from.lng, c.origin_lat, c.origin_lng) <= 1.5
        && haversineKm(to.lat, to.lng, c.dest_lat, c.dest_lng) <= 1.5);
      const byTime = (a, b) => a.depart_time.localeCompare(b.depart_time);
      return {
        from: { code: from.code, gu: from.gu, dong: from.dong },
        to: { code: to.code, gu: to.gu, dong: to.dong },
        distanceKm, fare: { total: fare, perPerson: splitFare(fare, 4) },
        commutes: exact.sort(byTime).map((c) => serialize(c, { viewerId })),
        nearby: nearby.sort(byTime).slice(0, 20).map((c) => serialize(c, { viewerId })),
      };
    },

    /** 사람이 많이 모인 노선 */
    popular(limit = 10) {
      return stmt.popular.all(limit).map((r) => {
        const from = getDong(r.from);
        const to = getDong(r.to);
        return from && to ? { from: { code: from.code, gu: from.gu, dong: from.dong }, to: { code: to.code, gu: to.gu, dong: to.dong }, crews: r.crews, riders: r.riders } : null;
      }).filter(Boolean);
    },

    mine(userId) {
      return stmt.mine.all(userId).map((c) => serialize(c, { viewerId: userId }));
    },

    join(id, userId) {
      users.requireVerified(userId);
      const c = load(id);
      transaction(db, () => {
        const fresh = load(id);
        if (stmt.isMember.get(fresh.id, userId)) throw conflict('이미 참여 중이에요.');
        const reason = joinBlocker(fresh, stmt.userById.get(userId));
        if (reason) throw conflict(reason);
        if (stmt.countMemberships.get(userId).n >= MAX_MEMBERSHIPS) throw conflict(`노선은 ${MAX_MEMBERSHIPS}개까지 참여할 수 있어요.`);
        stmt.addMember.run(fresh.id, userId);
      });
      const nickname = stmt.userById.get(userId).nickname;
      const members = memberIdsOf(c.id);
      fire(members.filter((m) => m !== userId), {
        type: 'commute_join', commuteId: c.id, title: '👋 노선에 새 멤버',
        body: `${nickname}님이 ${label(c)} 노선에 참여했어요 (${members.length}/${c.max_seats}명)`,
      });
      return service.get(c.id, userId);
    },

    /** 나가기. 만든 사람이 나가면 가장 먼저 들어온 멤버에게 넘기고, 아무도 없으면 노선을 닫는다 */
    leave(id, userId) {
      const c = load(id);
      assertMember(c, userId);
      stmt.removeMember.run(c.id, userId);
      const rest = memberIdsOf(c.id);
      if (c.owner_id === userId) {
        if (rest.length) stmt.setOwner.run(rest[0], c.id);
        else stmt.setStatus.run('closed', c.id);
      }
      const nickname = stmt.userById.get(userId).nickname;
      fire(rest, { type: 'commute_leave', commuteId: c.id, title: '🚪 멤버가 나갔어요', body: `${nickname}님이 ${label(c)} 노선에서 나갔어요.` });
      return { ok: true };
    },

    /** 만든 사람: 요일·시각·정원·조건·메모 수정, 모집 마감/재개 */
    update(id, userId, input = {}) {
      const c = load(id);
      assertOwner(c, userId);
      const days = input.days ? parseDays(input.days) : c.days;
      const time = input.departTime ? parseTime(input.departTime) : c.depart_time;
      const maxSeats = input.maxSeats != null ? Number(input.maxSeats) : c.max_seats;
      if (!Number.isInteger(maxSeats) || maxSeats < 2 || maxSeats > 4) throw badRequest('정원은 2~4명입니다.');
      if (maxSeats < memberIdsOf(c.id).length) throw badRequest('지금 멤버 수보다 적게 줄일 수 없어요.');
      const genderPref = input.genderPref ?? c.gender_pref;
      if (!GENDERS.includes(genderPref)) throw badRequest('성별 조건이 올바르지 않습니다.');
      const status = input.status ?? c.status;
      if (!['open', 'closed'].includes(status)) throw badRequest('상태가 올바르지 않습니다.');
      stmt.update.run(days, time, maxSeats, genderPref,
        input.meetingPoint != null ? text(input.meetingPoint, 100) : c.meeting_point,
        input.memo != null ? text(input.memo, 300) : c.memo, status, c.id);
      const changedSchedule = days !== c.days || time !== c.depart_time;
      if (changedSchedule) {
        const updated = load(c.id);
        fire(memberIdsOf(c.id).filter((m) => m !== userId), {
          type: 'commute_update', commuteId: c.id, title: '🗓️ 노선 일정이 바뀌었어요', body: label(updated),
        });
      }
      return service.get(c.id, userId);
    },

    /** 만든 사람: 멤버 내보내기 */
    removeMember(id, userId, targetId) {
      const c = load(id);
      assertOwner(c, userId);
      if (targetId === userId) throw badRequest('본인은 나가기를 이용해 주세요.');
      if (!stmt.isMember.get(c.id, targetId)) throw notFound('멤버가 아니에요.');
      stmt.removeMember.run(c.id, targetId);
      fire([targetId], { type: 'commute_removed', commuteId: c.id, title: '노선에서 제외되었어요', body: `${label(c)} 노선에서 제외되었어요.` });
      return service.get(c.id, userId);
    },

    isMember(id, userId) {
      return Boolean(stmt.isMember.get(Number(id), userId));
    },

    messages(id, userId, afterId = 0) {
      const c = load(id);
      assertMember(c, userId);
      return stmt.messages.all(c.id, Number(afterId) || 0);
    },

    postMessage(id, userId, body) {
      const c = load(id);
      assertMember(c, userId);
      const msg = text(body, 500);
      if (!msg) throw badRequest('메시지를 입력해 주세요.');
      const { lastInsertRowid } = stmt.insertMessage.run(c.id, userId, msg);
      const message = { commuteId: c.id, ...stmt.messageById.get(lastInsertRowid) };
      fire(memberIdsOf(c.id).filter((m) => m !== userId), {
        type: 'commute_chat', commuteId: c.id, title: `💬 ${message.nickname} (${c.origin_area} → ${c.dest_area})`,
        body: msg.slice(0, 100), skipViewers: true, store: false,
      });
      return message;
    },

    /**
     * 주기 작업: 운행일 출발 1시간 전에 멤버들로 합승방을 연다.
     * 2명 이상이면 합승방을 만들고(첫 탑승자가 방장) 나머지를 참여시킨다. 1명뿐이면 열지 않고 알려 준다.
     * → 새로 연 합승방 id 목록
     */
    async tick(now = Date.now()) {
      const opened = [];
      const today = kstParts(now).date;
      for (const c of stmt.open.all()) {
        for (const date of [today, addDays(today, 1)]) {
          if (!runsOn(c.days, date)) continue;
          const at = kstInstant(date, c.depart_time);
          if (at <= now || at - TRIP_OPEN_BEFORE_MS > now) continue;
          // 먼저 기록해서 다음 tick 에서 중복으로 열지 않게
          if (!stmt.putTrip.run(c.id, date, null).changes) continue;
          const riders = memberIdsOf(c.id);
          const when = `${date.slice(5).replace('-', '/')} ${c.depart_time}`;
          if (riders.length < 2) {
            fire(riders, {
              type: 'commute_trip_skipped', commuteId: c.id, title: '🙅 오늘은 합승방을 열지 않았어요',
              body: `${label(c)} · ${when} 아직 멤버가 1명뿐이에요. 노선 링크를 공유해서 같이 탈 사람을 모아 보세요.`,
            });
            continue;
          }
          try {
            const host = riders.includes(c.owner_id) ? c.owner_id : riders[0];
            const ride = await rides.create(host, {
              origin: { name: c.origin_name, lat: c.origin_lat, lng: c.origin_lng },
              destination: { name: c.dest_name, lat: c.dest_lat, lng: c.dest_lng },
              departAt: new Date(at).toISOString(),
              maxSeats: Math.min(4, Math.max(2, c.max_seats)),
              genderPref: c.gender_pref,
              meetingPoint: c.meeting_point || c.origin_name,
              memo: `🔁 정기 노선 (${c.origin_area} → ${c.dest_area} ${daysLabel(c.days)} ${c.depart_time}) 오늘 합승이에요.`,
            });
            const joined = [host];
            for (const id of riders.filter((r) => r !== host)) {
              try {
                rides.join(ride.id, id, { quiet: true });
                joined.push(id);
              } catch (err) {
                log.warn?.(`[commute] ${c.id} ${date} user ${id} 참여 실패: ${err.message}`);
              }
            }
            stmt.setTripRide.run(ride.id, c.id, date);
            opened.push(ride.id);
            fire(joined, {
              type: 'commute_trip', commuteId: c.id, rideId: ride.id, title: '🚕 오늘 합승방이 열렸어요',
              body: `${label(c)} · ${when} 출발 · ${joined.length}명. 만남 장소: ${c.meeting_point || c.origin_name}`,
            });
          } catch (err) {
            log.error('[commute] 합승방 생성 실패', c.id, date, err.message);
          }
        }
      }
      return opened;
    },
  };
  return service;
}
