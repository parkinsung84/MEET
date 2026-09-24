import { badRequest, conflict, notFound } from './errors.js';
import { matchRoute } from './rides.js';

const MAX_ACTIVE_ALERTS = 5;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

function place(p, label) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (typeof p?.name !== 'string' || !p.name.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest(`${label}를 선택해 주세요.`);
  }
  return { name: p.name.trim().slice(0, 100), lat, lng };
}

/**
 * 경로 알림: "이 경로로 합승방이 생기면 알려주세요".
 * 새 합승방이 만들어지면 시간·경로·참여 조건이 맞는 알림 신청자에게 알린다.
 */
export function createAlertService(db, { rides, notifier, log = console }) {
  const stmt = {
    insert: db.prepare(`INSERT INTO ride_alerts (user_id, origin_name, origin_lat, origin_lng, dest_name, dest_lat, dest_lng,
      radius_km, depart_from, depart_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    active: db.prepare('SELECT * FROM ride_alerts WHERE user_id = ? AND depart_to >= ? ORDER BY depart_from'),
    matching: db.prepare('SELECT * FROM ride_alerts WHERE depart_from <= ? AND depart_to >= ?'),
    remove: db.prepare('DELETE FROM ride_alerts WHERE id = ? AND user_id = ?'),
    purge: db.prepare('DELETE FROM ride_alerts WHERE depart_to < ?'),
  };

  const toJson = (a) => ({
    id: a.id,
    origin: { name: a.origin_name, lat: a.origin_lat, lng: a.origin_lng },
    destination: { name: a.dest_name, lat: a.dest_lat, lng: a.dest_lng },
    radiusKm: a.radius_km,
    from: a.depart_from,
    to: a.depart_to,
  });

  return {
    create(userId, input = {}) {
      const origin = place(input.origin, '출발지');
      const destination = place(input.destination, '도착지');
      const now = Date.now();
      const from = Math.max(now, new Date(input.from ?? now).getTime());
      const to = new Date(input.to ?? now + 2 * 60 * 60 * 1000).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw badRequest('알림 시간 범위가 올바르지 않습니다.');
      if (to - from > MAX_WINDOW_MS) throw badRequest('알림은 최대 24시간 범위까지 설정할 수 있어요.');
      const radiusKm = Math.min(Math.max(Number(input.radiusKm) || 2, 0.5), 10);
      if (stmt.active.all(userId, new Date(now).toISOString()).length >= MAX_ACTIVE_ALERTS) {
        throw conflict(`경로 알림은 최대 ${MAX_ACTIVE_ALERTS}개까지 등록할 수 있어요.`);
      }
      const { lastInsertRowid } = stmt.insert.run(userId, origin.name, origin.lat, origin.lng,
        destination.name, destination.lat, destination.lng, radiusKm,
        new Date(from).toISOString(), new Date(to).toISOString());
      return toJson(db.prepare('SELECT * FROM ride_alerts WHERE id = ?').get(lastInsertRowid));
    },

    list(userId) {
      return stmt.active.all(userId, new Date().toISOString()).map(toJson);
    },

    remove(userId, alertId) {
      if (!stmt.remove.run(Number(alertId), userId).changes) throw notFound('존재하지 않는 알림입니다.');
    },

    purgeExpired(now = Date.now()) {
      stmt.purge.run(new Date(now).toISOString());
    },

    /** 새 합승방에 맞는 알림 신청자에게 알린다 (사용자당 한 번) */
    dispatch(rideId) {
      const ride = rides.rideRow(rideId);
      const notified = new Set();
      for (const alert of stmt.matching.all(ride.depart_at, ride.depart_at)) {
        if (notified.has(alert.user_id) || !rides.canJoin(ride.id, alert.user_id)) continue;
        const match = matchRoute(ride, {
          origin: { lat: alert.origin_lat, lng: alert.origin_lng },
          destination: { lat: alert.dest_lat, lng: alert.dest_lng },
          radiusKm: alert.radius_km,
        });
        if (!match) continue;
        notified.add(alert.user_id);
      }
      if (!notified.size) return 0;
      const time = new Date(ride.depart_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit' });
      notifier.notify([...notified], {
        type: 'alert', rideId: ride.id, title: '🔔 원하는 경로의 합승이 생겼어요',
        body: `${ride.origin_name} → ${ride.dest_name} · ${time} 출발`,
      }).catch((err) => log.error('[notify]', err.message));
      return notified.size;
    },
  };
}
