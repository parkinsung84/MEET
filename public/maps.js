import { debounce, h } from './ui.js';

// 네이버 지도 JavaScript API v3 연동. 키가 없거나 인증에 실패하면 지도 기능만 숨기고 나머지는 그대로 동작한다.

const SDK_URL = 'https://oapi.map.naver.com/openapi/v3/maps.js';
const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9784 }; // 서울시청

let sdkPromise = null;

function disableMaps(reason) {
  console.warn('[naver maps]', reason);
  document.body.classList.add('no-map');
}

/** SDK를 한 번만 로드한다. 사용할 수 없으면 null로 resolve. */
export function loadNaverMaps(keyId) {
  if (!keyId) {
    document.body.classList.add('no-map');
    return Promise.resolve(null);
  }
  sdkPromise ??= new Promise((resolve) => {
    // 네이버가 인증 실패 시 호출하는 전역 콜백 (NCP 콘솔의 Web 서비스 URL 미등록 등)
    window.navermap_authFailure = () => disableMaps('인증 실패: NCP 콘솔에 현재 도메인이 등록돼 있는지 확인하세요.');
    const script = document.createElement('script');
    script.src = `${SDK_URL}?ncpKeyId=${encodeURIComponent(keyId)}`;
    script.onload = () => resolve(window.naver?.maps ?? null);
    script.onerror = () => {
      disableMaps('SDK 로드 실패');
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
