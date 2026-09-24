import { transaction } from './db.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { estimateFare, haversineKm, splitFare } from './geo.js';

const GENDERS = ['any', 'male', 'female'];
const MAX_ADVANCE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RADIUS_KM = 2;

// 허용되는 상태 전이 (방장만 변경 가능)
const TRANSITIONS = {
  open: ['departed', 'cancelled'],
  departed: ['completed'],
  completed: [],
  cancelled: [],
};

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

export function createRideService(db) {
  const stmt = {
    rideById: db.prepare('SELECT * FROM rides WHERE id = ?'),
    members: db.prepare(`
      SELECT u.id, u.nickname, u.gender, m.joined_at AS joinedAt
      FROM ride_members m JOIN users u ON u.id = m.user_id
      WHERE m.ride_id = ? ORDER BY m.joined_at, u.id`),
    memberCount: db.prepare('SELECT COUNT(*) AS n FROM ride_members WHERE ride_id = ?'),
    isMember: db.prepare('SELECT 1 FROM ride_members WHERE ride_id = ? AND user_id = ?'),
    insertRide: db.prepare(`
      INSERT INTO rides (host_id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng,
                         depart_at, max_seats, gender_pref, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertMember: db.prepare('INSERT INTO ride_members (ride_id, user_id) VALUES (?, ?)'),
    deleteMember: db.prepare('DELETE FROM ride_members WHERE ride_id = ? AND user_id = ?'),
    setHost: db.prepare('UPDATE rides SET host_id = ? WHERE id = ?'),
    setStatus: db.prepare('UPDATE rides SET status = ? WHERE id = ?'),
    openRides: db.prepare(`SELECT * FROM rides WHERE status = 'open' AND depart_at >= ? ORDER BY depart_at`),
    myRides: db.prepare(`
      SELECT r.* FROM rides r JOIN ride_members m ON m.ride_id = r.id
      WHERE m.user_id = ? ORDER BY r.depart_at DESC`),
    userById: db.prepare('SELECT id, nickname, gender FROM users WHERE id = ?'),
    messages: db.prepare(`
      SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM messages msg JOIN users u ON u.id = msg.user_id
      WHERE msg.ride_id = ? AND msg.id > ? ORDER BY msg.id LIMIT 200`),
    insertMessage: db.prepare('INSERT INTO messages (ride_id, user_id, body) VALUES (?, ?, ?)'),
    messageById: db.prepare(`
      SELECT msg.id, msg.body, msg.created_at AS createdAt, u.id AS userId, u.nickname
      FROM messages msg JOIN users u ON u.id = msg.user_id WHERE msg.id = ?`),
  };

  function loadRide(rideId) {
    const ride = stmt.rideById.get(Number(rideId));
    if (!ride) throw notFound('존재하지 않는 합승방입니다.');
    return ride;
  }

  function serialize(ride, { withMembers = false } = {}) {
    const memberCount = stmt.memberCount.get(ride.id).n;
    const { distanceKm, fare } = estimateFare(ride.origin_lat, ride.origin_lng, ride.dest_lat, ride.dest_lng);
    const result = {
      id: ride.id,
      hostId: ride.host_id,
      origin: { name: ride.origin_name, lat: ride.origin_lat, lng: ride.origin_lng },
      destination: { name: ride.dest_name, lat: ride.dest_lat, lng: ride.dest_lng },
      departAt: ride.depart_at,
      maxSeats: ride.max_seats,
      genderPref: ride.gender_pref,
      memo: ride.memo,
      status: ride.status,
      memberCount,
      fare: {
        distanceKm,
        total: fare,
        // 지금 인원 기준 1인 부담금과, 정원이 모두 찼을 때의 1인 부담금
        perPersonNow: splitFare(fare, memberCount),
        perPersonFull: splitFare(fare, ride.max_seats),
      },
    };
    if (withMembers) result.members = stmt.members.all(ride.id);
    return result;
  }

  function assertMember(rideId, userId) {
    if (!stmt.isMember.get(rideId, userId)) throw forbidden('합승 멤버만 이용할 수 있습니다.');
  }

  return {
    create(hostId, input = {}) {
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

      const host = stmt.userById.get(hostId);
      if (genderPref !== 'any' && host.gender !== genderPref) {
        throw badRequest('본인이 참여할 수 없는 성별 조건입니다.');
      }

      const rideId = transaction(db, () => {
        const { lastInsertRowid } = stmt.insertRide.run(
          hostId, origin.name, origin.lat, origin.lng, destination.name, destination.lat, destination.lng,
          departAt.toISOString(), maxSeats, genderPref, memo,
        );
        stmt.insertMember.run(lastInsertRowid, hostId);
        return Number(lastInsertRowid);
      });
      return serialize(loadRide(rideId), { withMembers: true });
    },

    get(rideId) {
      return serialize(loadRide(rideId), { withMembers: true });
    },

    /**
     * 모집 중인 합승방 검색. 출발지/도착지 좌표를 주면 반경(radiusKm) 안의 방만,
     * 가까운 순으로 돌려준다. viewer의 성별로 참여할 수 없는 방은 제외한다.
     */
    search(query = {}, viewerId) {
      const radiusKm = Number(query.radiusKm) || DEFAULT_RADIUS_KM;
      const viewer = viewerId ? stmt.userById.get(viewerId) : null;
      const hasOrigin = query.originLat !== undefined && query.originLng !== undefined;
      const hasDest = query.destLat !== undefined && query.destLng !== undefined;
      const origin = hasOrigin && [requireCoord(query.originLat, '출발지', 90), requireCoord(query.originLng, '출발지', 180)];
      const dest = hasDest && [requireCoord(query.destLat, '도착지', 90), requireCoord(query.destLng, '도착지', 180)];

      const results = [];
      for (const ride of stmt.openRides.all(new Date().toISOString())) {
        if (viewer && ride.gender_pref !== 'any' && ride.gender_pref !== viewer.gender) continue;
        let score = 0;
        if (origin) {
          const d = haversineKm(origin[0], origin[1], ride.origin_lat, ride.origin_lng);
          if (d > radiusKm) continue;
          score += d;
        }
        if (dest) {
          const d = haversineKm(dest[0], dest[1], ride.dest_lat, ride.dest_lng);
          if (d > radiusKm) continue;
          score += d;
        }
        const item = serialize(ride);
        if (item.memberCount >= item.maxSeats) continue;
        results.push({ ...item, matchDistanceKm: Math.round(score * 100) / 100 });
      }
      // 거리 기준 정렬 (거리 조건이 없으면 출발 시간 순서 유지)
      return results.sort((a, b) => a.matchDistanceKm - b.matchDistanceKm);
    },

    mine(userId) {
      return stmt.myRides.all(userId).map((ride) => serialize(ride));
    },

    join(rideId, userId) {
      transaction(db, () => {
        const ride = loadRide(rideId);
        if (ride.status !== 'open') throw conflict('모집이 끝난 합승방입니다.');
        if (new Date(ride.depart_at).getTime() < Date.now()) throw conflict('이미 출발 시간이 지났습니다.');
        if (stmt.isMember.get(ride.id, userId)) throw conflict('이미 참여 중입니다.');
        if (stmt.memberCount.get(ride.id).n >= ride.max_seats) throw conflict('정원이 가득 찼습니다.');
        const user = stmt.userById.get(userId);
        if (ride.gender_pref !== 'any' && ride.gender_pref !== user.gender) {
          throw forbidden('성별 조건이 맞지 않아 참여할 수 없습니다.');
        }
        stmt.insertMember.run(ride.id, userId);
      });
      return this.get(rideId);
    },

    /** 방을 나간다. 방장이 나가면 가장 먼저 들어온 멤버에게 위임하고, 남은 사람이 없으면 방을 취소한다. */
    leave(rideId, userId) {
      transaction(db, () => {
        const ride = loadRide(rideId);
        if (ride.status !== 'open') throw conflict('출발 이후에는 나갈 수 없습니다.');
        assertMember(ride.id, userId);
        stmt.deleteMember.run(ride.id, userId);
        const remaining = stmt.members.all(ride.id);
        if (remaining.length === 0) {
          stmt.setStatus.run('cancelled', ride.id);
        } else if (ride.host_id === userId) {
          stmt.setHost.run(remaining[0].id, ride.id);
        }
      });
      return this.get(rideId);
    },

    updateStatus(rideId, userId, status) {
      const ride = loadRide(rideId);
      if (ride.host_id !== userId) throw forbidden('방장만 상태를 변경할 수 있습니다.');
      if (!TRANSITIONS[ride.status]?.includes(status)) {
        throw conflict(`'${ride.status}' 상태에서 '${status}'(으)로 변경할 수 없습니다.`);
      }
      stmt.setStatus.run(status, ride.id);
      return this.get(rideId);
    },

    isMember(rideId, userId) {
      return Boolean(stmt.isMember.get(Number(rideId), userId));
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
      return stmt.messageById.get(lastInsertRowid);
    },
  };
}
