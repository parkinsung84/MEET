const EARTH_RADIUS_KM = 6371;

// 직선거리를 실제 도로 주행거리로 보정하는 계수 (도심 평균값 근사)
const ROAD_FACTOR = 1.3;

// 서울 중형택시 요금 (2023.02 기준): 기본 1.6km 4,800원, 이후 131m당 100원
const BASE_FARE = 4800;
const BASE_DISTANCE_KM = 1.6;
const UNIT_DISTANCE_KM = 0.131;
const UNIT_FARE = 100;

const toRad = (deg) => (deg * Math.PI) / 180;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

/** 두 지점 사이의 예상 택시 요금(원)과 예상 주행거리(km). */
export function estimateFare(originLat, originLng, destLat, destLng) {
  const distanceKm = haversineKm(originLat, originLng, destLat, destLng) * ROAD_FACTOR;
  const extraKm = Math.max(0, distanceKm - BASE_DISTANCE_KM);
  const fare = BASE_FARE + Math.ceil(extraKm / UNIT_DISTANCE_KM) * UNIT_FARE;
  return { distanceKm: Math.round(distanceKm * 10) / 10, fare };
}

/** 1인당 부담금. 10원 단위 올림. */
export function splitFare(fare, people) {
  return Math.ceil(fare / Math.max(1, people) / 10) * 10;
}

/**
 * 점을 경로(폴리라인)에 투영한다. path: [{lat, lng}, ...]
 * → { distanceKm: 경로까지 최단거리, t: 경로 시작부터 투영점까지 길이 비율(0~1) }
 * 짧은 거리이므로 기준점 주변을 평면(등장방형)으로 근사한다.
 */
export function projectOnRoute(path, point) {
  const kmPerLat = 110.574;
  const kmPerLng = 111.32 * Math.cos(toRad(point.lat));
  const xy = (p) => [(p.lng - point.lng) * kmPerLng, (p.lat - point.lat) * kmPerLat];

  const segments = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = xy(path[i - 1]);
    const [bx, by] = xy(path[i]);
    const len = Math.hypot(bx - ax, by - ay);
    segments.push({ ax, ay, bx, by, len, start: total });
    total += len;
  }
  if (total === 0) return { distanceKm: Math.hypot(...xy(path[0])), t: 1 };

  let best = { distanceKm: Infinity, t: 0 };
  for (const { ax, ay, bx, by, len, start } of segments) {
    // 점(원점)에서 선분 AB에 내린 수선의 발
    const u = len === 0 ? 0 : Math.min(1, Math.max(0, -(ax * (bx - ax) + ay * (by - ay)) / (len * len)));
    const d = Math.hypot(ax + u * (bx - ax), ay + u * (by - ay));
    if (d < best.distanceKm) best = { distanceKm: d, t: (start + u * len) / total };
  }
  return best;
}

/**
 * 하차 지점이 다른 합승의 거리 비례 분담.
 * 경로를 하차 지점마다 구간으로 나누고, 각 구간 요금은 그 구간에 타고 있던 사람끼리 똑같이 나눈다.
 * riders: [{ userId, t }] (t = 경로상 하차 위치 비율, 최종 도착지는 1)
 * → Map(userId → 부담금, 10원 단위 올림). 모두 같은 곳에서 내리면 1/N과 같다.
 */
export function splitByDropoffs(total, riders) {
  const shares = new Map(riders.map((r) => [r.userId, 0]));
  const stops = [...new Set(riders.map((r) => r.t))].sort((a, b) => a - b);
  // 가장 멀리 가는 사람이 경로 끝까지 가는 것으로 본다 (남은 구간 요금이 누락되지 않도록)
  const last = stops.at(-1);
  let prev = 0;
  for (const stop of stops) {
    const aboard = riders.filter((r) => r.t >= stop);
    const fraction = (stop === last ? 1 : stop) - prev;
    for (const r of aboard) shares.set(r.userId, shares.get(r.userId) + (total * fraction) / aboard.length);
    prev = stop;
  }
  for (const [id, amount] of shares) shares.set(id, Math.ceil(amount / 10) * 10);
  return shares;
}
