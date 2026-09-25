import { debounce, h } from './ui.js';

// 네이버 지도 JavaScript API v3 연동. 키가 없거나 인증에 실패하면 지도 기능만 숨기고 나머지는 그대로 동작한다.

const SDK_URL = 'https://oapi.map.naver.com/openapi/v3/maps.js';
const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9784 }; // 서울시청

let sdkPromise = null;
let problem = null;

function disableMaps(reason) {
  console.warn('[naver maps]', reason);
  document.body.classList.add('no-map');
  problem = reason;
  window.dispatchEvent(new CustomEvent('maps:problem', { detail: reason }));
}

/** 지도가 안 뜨는 이유 (운영자가 고칠 수 있도록 화면에 보여준다). 정상이면 null */
export const mapProblem = () => problem;

/** SDK를 한 번만 로드한다. 사용할 수 없으면 null로 resolve. */
export function loadNaverMaps(keyId) {
  if (!keyId) {
    disableMaps('서버에 네이버 지도 키가 없어요. Render → Environment 에 NAVER_MAP_KEY_ID / NAVER_MAP_KEY 를 넣고 다시 배포하세요.');
    return Promise.resolve(null);
  }
  sdkPromise ??= new Promise((resolve) => {
    // 네이버가 인증 실패 시 호출하는 전역 콜백 (NCP 콘솔의 Web 서비스 URL 미등록 등)
    window.navermap_authFailure = () => disableMaps(`네이버 지도 인증 실패. NCP 콘솔 → Maps → Application 에서 ① Dynamic Map 이 선택돼 있는지 ② Web 서비스 URL 에 ${location.origin} 이 등록돼 있는지 ③ NAVER_MAP_KEY_ID 가 그 Application 의 Client ID 인지 확인하세요.`);
    const script = document.createElement('script');
    script.src = `${SDK_URL}?ncpKeyId=${encodeURIComponent(keyId)}`;
    script.onload = () => resolve(window.naver?.maps ?? null);
    script.onerror = () => {
      disableMaps('네이버 지도 스크립트를 불러오지 못했어요 (네트워크 또는 광고 차단기 확인).');
      resolve(null);
    };
    document.head.append(script);
  });
  return sdkPromise;
}

export const mapsAvailable = () => Boolean(window.naver?.maps) && !document.body.classList.contains('no-map');

const latLng = ({ lat, lng }) => new naver.maps.LatLng(lat, lng);

function labelMarker(map, position, text, color) {
  return new naver.maps.Marker({
    map,
    position: latLng(position),
    icon: {
      content: `<div class="map-label" style="background:${color}">${text}</div>`,
      anchor: new naver.maps.Point(22, 34),
    },
  });
}

/** 합승 경로 지도: 출발/도착 마커와 경로(네이버 길찾기 경로 또는 직선)를 그린다. */
export function renderRouteMap(container, ride) {
  if (!mapsAvailable()) return null;
  const map = new naver.maps.Map(container, {
    center: latLng(ride.origin),
    zoom: 13,
    scaleControl: false,
    mapDataControl: false,
  });
  labelMarker(map, ride.origin, '출발', '#16a34a');
  labelMarker(map, ride.destination, '도착', '#dc2626');
  const path = ride.routePath?.length
    ? ride.routePath.map(([lng, lat]) => new naver.maps.LatLng(lat, lng))
    : [latLng(ride.origin), latLng(ride.destination)];
  new naver.maps.Polyline({
    map,
    path,
    strokeColor: '#2563eb',
    strokeWeight: 5,
    strokeOpacity: 0.8,
    strokeStyle: ride.routePath?.length ? 'solid' : 'shortdash',
  });
  const bounds = new naver.maps.LatLngBounds(path[0], path[0]);
  path.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds, { top: 40, right: 30, bottom: 30, left: 30 });
  return map;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * 합승방 지도: 각 방의 출발지에 핀(라벨 = label(ride))을 찍고, 누르면 그 방으로 이동.
 * me가 있으면 내 출발지도 표시. 방이 없으면 me(또는 서울시청) 주변을 보여준다.
 */
export function renderRidesMap(container, rides, { me, label }) {
  if (!mapsAvailable()) return null;
  const map = new naver.maps.Map(container, {
    center: latLng(me ?? rides[0]?.origin ?? DEFAULT_CENTER),
    zoom: 14,
    scaleControl: false,
    mapDataControl: false,
  });
  const points = [];
  if (me) {
    labelMarker(map, me, '내 출발지', '#2563eb');
    points.push(latLng(me));
  }
  for (const ride of rides) {
    const marker = labelMarker(map, ride.origin, escapeHtml(label(ride)), ride.memberCount >= ride.maxSeats ? '#6b7280' : '#16a34a');
    naver.maps.Event.addListener(marker, 'click', () => { location.hash = `#/rides/${ride.id}`; });
    points.push(latLng(ride.origin));
  }
  if (points.length > 1) {
    const bounds = new naver.maps.LatLngBounds(points[0], points[0]);
    points.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 50, right: 40, bottom: 30, left: 40 });
  }
  return map;
}

/**
 * 지도에서 위치 고르기 (가운데 핀 방식). 지도를 움직이면 가운데 좌표의 주소를 보여준다.
 * reverse(lat, lng) → Promise<{ name, address, lat, lng }>
 * 확인하면 선택한 장소, 취소하면 null로 resolve.
 */
export function pickOnMap({ title, initial, reverse }) {
  return new Promise((resolve) => {
    let current = null;
    const mapEl = h('div', { class: 'picker-map' });
    const nameEl = h('strong', {}, '위치를 불러오는 중…');
    const addrEl = h('div', { class: 'muted' });
    const confirmBtn = h('button', { disabled: true }, '이 위치로 설정');
    const overlay = h('div', { class: 'picker', role: 'dialog', 'aria-label': title },
      h('div', { class: 'picker-head' },
        h('button', { class: 'secondary small', onclick: () => close(null) }, '✕'),
        h('strong', {}, title)),
      h('div', { class: 'picker-body' }, mapEl, h('div', { class: 'picker-pin' }, '📍')),
      h('div', { class: 'picker-foot' }, nameEl, addrEl, confirmBtn));

    function close(result) {
      map.destroy();
      overlay.remove();
      resolve(result);
    }
    confirmBtn.addEventListener('click', () => current && close(current));

    document.body.append(overlay);
    const map = new naver.maps.Map(mapEl, {
      center: latLng(initial ?? DEFAULT_CENTER),
      zoom: 16,
      scaleControl: false,
      mapDataControl: false,
    });

    let seq = 0;
    const lookup = debounce(async () => {
      const center = map.getCenter();
      const id = ++seq;
      try {
        const place = await reverse(center.lat(), center.lng());
        if (id !== seq) return; // 더 최근 요청이 있으면 무시
        current = place;
        nameEl.textContent = place.name;
        addrEl.textContent = place.address;
        confirmBtn.disabled = false;
      } catch (err) {
        if (id === seq) nameEl.textContent = err.message;
      }
    }, 350);

    naver.maps.Event.addListener(map, 'dragstart', () => { confirmBtn.disabled = true; });
    naver.maps.Event.addListener(map, 'idle', lookup);
    lookup();
  });
}
