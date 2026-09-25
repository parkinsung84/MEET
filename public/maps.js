import { locate } from './here.js';
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
export function renderRidesMap(container, rides, { me, label, onPick }) {
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
  // 빈 곳을 누르면 그 좌표를 알려준다 (출발지/도착지로 설정)
  if (onPick) {
    let pin = null;
    naver.maps.Event.addListener(map, 'click', (e) => {
      const at = { lat: e.coord.lat(), lng: e.coord.lng() };
      pin?.setMap(null);
      pin = new naver.maps.Marker({ map, position: e.coord });
      onPick(at, () => pin?.setMap(null));
    });
  }
  if (points.length > 1) {
    const bounds = new naver.maps.LatLngBounds(points[0], points[0]);
    points.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { top: 50, right: 40, bottom: 30, left: 40 });
  }
  return map;
}

/**
 * 지도에서 핀으로 위치 찍기 (가운데 핀 방식). 지도를 움직이거나 누르면 가운데 좌표의 주소를 보여준다.
 * 위쪽 검색창으로 장소 이름을 찾으면 그곳으로 지도가 이동하고, 핀 위치를 확인한 뒤 확정한다.
 *  reverse(lat, lng) → Promise<{ name, address, lat, lng }>
 *  search(q) → Promise<{ places }>
 *  locateFirst: 처음 열 때 현재 위치로 이동
 * 확인하면 선택한 장소, 취소하면 null로 resolve.
 */
export function pickOnMap({ title, initial, reverse, search, confirmLabel = '이 위치로 설정', locateFirst = false }) {
  return new Promise((resolve) => {
    let current = null;
    let chosen = null; // 검색 결과를 골라 이동한 경우 그 장소 이름을 쓴다 (지도를 움직이면 해제)
    const mapEl = h('div', { class: 'picker-map' });
    const nameEl = h('strong', {}, '위치를 불러오는 중…');
    const addrEl = h('div', { class: 'muted' });
    const confirmBtn = h('button', { class: 'wide', disabled: true }, confirmLabel);
    const query = h('input', { type: 'search', placeholder: '🔍 장소 이름으로 이동 (예: 동대구역)', autocomplete: 'off', 'aria-label': '장소 이름으로 이동' });
    const results = h('ul', { class: 'suggestions picker-results', hidden: true });
    const locateBtn = h('button', { type: 'button', class: 'picker-locate', 'aria-label': '내 위치로' }, '◎');
    const overlay = h('div', { class: 'picker', role: 'dialog', 'aria-label': title },
      h('div', { class: 'picker-head' },
        h('button', { class: 'secondary small', 'aria-label': '닫기', onclick: () => close(null) }, '✕'),
        h('div', { class: 'picker-search' }, query, results)),
      h('div', { class: 'picker-body' },
        mapEl,
        h('div', { class: 'picker-guide' }, `👆 지도를 움직여 📍 핀을 ${title.replace(/ 찍기$/, '')} 위치에 맞춰 주세요`),
        h('div', { class: 'picker-pin' }, '📍'),
        locateBtn),
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
      if (chosen && Math.abs(center.lat() - chosen.lat) < 1e-5 && Math.abs(center.lng() - chosen.lng) < 1e-5) {
        current = chosen;
      } else {
        chosen = null;
        try {
          const place = await reverse(center.lat(), center.lng());
          if (id !== seq) return; // 더 최근 요청이 있으면 무시
          current = place;
        } catch (err) {
          if (id === seq) nameEl.textContent = err.message;
          return;
        }
      }
      nameEl.textContent = current.name;
      addrEl.textContent = current.address || '';
      confirmBtn.disabled = false;
    }, 350);

    const moveTo = (point, zoom) => {
      confirmBtn.disabled = true;
      map.setCenter(latLng(point));
      if (zoom) map.setZoom(zoom);
      lookup();
    };

    naver.maps.Event.addListener(map, 'dragstart', () => {
      chosen = null;
      confirmBtn.disabled = true;
      results.hidden = true;
    });
    // 지도를 누르면 그 위치로 핀을 옮긴다
    naver.maps.Event.addListener(map, 'click', (e) => {
      chosen = null;
      confirmBtn.disabled = true;
      results.hidden = true;
      map.panTo(e.coord);
    });
    naver.maps.Event.addListener(map, 'idle', lookup);

    locateBtn.addEventListener('click', async () => {
      const here = await locate({ accurate: true });
      if (here) moveTo(here, 17);
      else nameEl.textContent = '현재 위치를 가져올 수 없어요. 브라우저의 위치 권한을 확인해 주세요.';
    });
    if (locateFirst) locate().then((here) => { if (here && !chosen && confirmBtn.disabled !== false) moveTo(here); });

    // 이름으로 이동: 결과를 누르면 그곳으로 지도 이동 (확정은 아래 버튼으로)
    let qseq = 0;
    const runSearch = debounce(async (q) => {
      const id = ++qseq;
      try {
        const { places } = await search(q);
        if (id !== qseq) return;
        results.replaceChildren(...(places.length
          ? places.map((p) => h('li', {
            role: 'option',
            onclick: () => {
              chosen = p;
              results.hidden = true;
              query.blur();
              moveTo(p, 17);
            },
          }, h('strong', {}, p.name), h('span', { class: 'muted' },
            [p.distanceKm != null && (p.distanceKm < 1 ? `${Math.round(p.distanceKm * 1000)}m` : `${p.distanceKm}km`), p.address]
              .filter(Boolean).join(' · '))))
          : [h('li', { class: 'muted' }, '검색 결과가 없어요. 지도를 직접 움직여 찍어 주세요.')]));
        results.hidden = false;
      } catch (err) {
        if (id === qseq) nameEl.textContent = err.message;
      }
    }, 300);
    query.addEventListener('input', () => {
      const q = query.value.trim();
      if (q) runSearch(q);
      else results.hidden = true;
    });
    results.addEventListener('mousedown', (e) => e.preventDefault());

    lookup();
  });
}
