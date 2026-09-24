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
