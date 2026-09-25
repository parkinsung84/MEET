// 최근에 받은 현재 위치 (가까운 장소 먼저 검색·지도 시작 위치용, 이 탭에서만 10분 기억)

const HERE_KEY = 'meet.here';
const HERE_TTL_MS = 10 * 60 * 1000;

export function rememberHere(lat, lng) {
  try { sessionStorage.setItem(HERE_KEY, JSON.stringify({ lat, lng, at: Date.now() })); } catch { /* 저장 불가 */ }
}

export function recentHere() {
  try {
    const here = JSON.parse(sessionStorage.getItem(HERE_KEY));
    return here && Date.now() - here.at < HERE_TTL_MS ? { lat: here.lat, lng: here.lng } : null;
  } catch {
    return null;
  }
}

let locating = null;
/**
 * 현재 위치를 받는다 → {lat, lng} 또는 null. 이미 거부했으면 다시 묻지 않는다.
 * accurate: true 면 GPS 수준 정확도 (현재 위치 버튼), 아니면 대략적인 위치로 빠르게.
 */
export function locate({ accurate = false } = {}) {
  if (!('geolocation' in navigator)) return Promise.resolve(null);
  if (!accurate && recentHere()) return Promise.resolve(recentHere());
  locating ??= (async () => {
    try {
      const status = await navigator.permissions?.query({ name: 'geolocation' });
      if (status?.state === 'denied') return null;
    } catch { /* permissions API 미지원 브라우저 */ }
    return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
      (pos) => {
        rememberHere(pos.coords.latitude, pos.coords.longitude);
        resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => resolve(null),
      accurate
        ? { enableHighAccuracy: true, timeout: 10000 }
        : { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 8000 },
    ));
  })().finally(() => { locating = null; });
  return locating;
}
