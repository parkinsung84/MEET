import { api, formatTime, GENDER_LABEL, relativeTime, STATUS_LABEL, won } from './core.js';
import { mapsAvailable, pickOnMap } from './maps.js';
import { debounce, h, toast } from './ui.js';

export const reverseGeocode = (lat, lng) =>
  api('GET', `/places/reverse?${new URLSearchParams({ lat, lng })}`).then((r) => r.place);

/**
 * 장소 선택기: 검색어 자동완성(네이버 장소·주소 검색), 현재 위치, 지도에서 선택.
 * value()는 선택된 {name, address, lat, lng}, 비어 있으면 null, 선택 없이 입력만 했으면 에러.
 */
export function placePicker(label, { allowCurrent = false } = {}) {
  let selected = null;
  let suggestions = [];
  let seq = 0;
  const input = h('input', { placeholder: '장소명, 주소 검색', autocomplete: 'off', role: 'combobox', 'aria-label': label });
  const list = h('ul', { class: 'suggestions', hidden: true, role: 'listbox' });
  const detail = h('div', { class: 'muted place-addr' });

  function select(place) {
    selected = place;
    input.value = place.name;
    detail.textContent = place.address || '';
    list.hidden = true;
  }

  const search = debounce(async (q) => {
    const id = ++seq;
    try {
      const { places } = await api('GET', `/places/search?${new URLSearchParams({ q })}`);
      if (id !== seq) return;
      suggestions = places;
      list.replaceChildren(...(places.length
        ? places.map((p) => h('li', { role: 'option', onclick: () => select(p) },
            h('strong', {}, p.name),
            (p.address || p.category) && h('span', { class: 'muted' }, [p.category, p.address].filter(Boolean).join(' · '))))
        : [h('li', { class: 'muted' }, '검색 결과가 없어요.')]));
      list.hidden = false;
    } catch (err) {
      if (id === seq) toast(err.message);
    }
  }, 300);

  input.addEventListener('input', () => {
    selected = null;
    detail.textContent = '';
    const q = input.value.trim();
    if (q) search(q);
    else list.hidden = true;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !list.hidden && suggestions.length) {
      e.preventDefault();
      select(suggestions[0]);
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });
  // 항목 클릭 전에 blur로 목록이 닫히지 않도록
  list.addEventListener('mousedown', (e) => e.preventDefault());
  input.addEventListener('blur', () => { list.hidden = true; });

  const useCurrent = allowCurrent && 'geolocation' in navigator && h('button', {
    type: 'button',
    class: 'secondary small fit',
    title: '현재 위치',
    onclick: () => navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          select(await reverseGeocode(pos.coords.latitude, pos.coords.longitude));
        } catch (err) {
          toast(err.message);
        }
      },
      () => toast('위치 정보를 가져올 수 없습니다.'),
      { enableHighAccuracy: true, timeout: 10000 },
    ),
  }, '📍');

  const onMap = h('button', {
    type: 'button',
    class: 'secondary small fit needs-map',
    title: '지도에서 선택',
    onclick: async () => {
      if (!mapsAvailable()) return toast('지도를 사용할 수 없습니다.');
      const place = await pickOnMap({ title: `${label} 선택`, initial: selected, reverse: reverseGeocode });
      if (place) select(place);
    },
  }, '🗺️');

  return {
    el: h('label', { class: 'place-picker' }, label,
      h('div', { class: 'row' }, h('div', { class: 'combo' }, input, list), useCurrent, onMap),
      detail),
    set: select,
    value() {
      if (selected) return selected;
      if (!input.value.trim()) return null;
      throw new Error(`${label}: 검색 결과 목록에서 장소를 선택해 주세요.`);
    },
  };
}

export const routeSummary = (fare) =>
  `약 ${fare.distanceKm}km${fare.durationMin ? ` · ${fare.durationMin}분` : ''}`;

/** 매너 지표 칩: 인증, 매너 점수, 노쇼 이력 */
export function trustChips(user) {
  const { stats } = user;
  return [
    user.verified && h('span', { class: 'chip ok', title: '이메일 인증' }, user.org ? `🎓 ${user.org}` : '✔ 인증'),
    stats.mannerPercent !== null
      ? h('span', { class: 'chip', title: `평가 ${stats.ratings}건` }, `👍 ${stats.mannerPercent}%`)
      : h('span', { class: 'chip', title: '평가가 3건 이상이면 매너 점수가 표시돼요' }, `🆕 합승 ${stats.completedRides}회`),
    stats.noShows > 0 && h('span', { class: 'chip warn' }, `노쇼 ${stats.noShows}`),
    stats.lateCancels > 0 && h('span', { class: 'chip warn' }, `직전취소 ${stats.lateCancels}`),
  ];
}

export function rideCard(ride) {
  const seatsLeft = ride.maxSeats - ride.memberCount;
  const soon = ride.status === 'open' && new Date(ride.departAt).getTime() - Date.now() < 60 * 60 * 1000;
  return h('a', { class: 'card ride-card', href: `#/rides/${ride.id}` },
    h('div', { class: 'route' }, ride.origin.name, h('span', { class: 'arrow' }, '→'), ride.destination.name),
    h('div', { class: 'muted' },
      soon && h('strong', { class: 'soon' }, `${relativeTime(ride.departAt)} · `),
      `${formatTime(ride.departAt)} 출발 · ${routeSummary(ride.fare)}`),
    h('div', { class: 'chips' },
      ride.fare.mine
        ? h('span', { class: 'chip hl' }, `내 예상 ${won(ride.fare.mine)}`)
        : h('span', { class: 'chip hl' }, `1인 ${won(ride.fare.perPersonFull)}~`),
      h('span', { class: 'chip' }, ride.status === 'open' ? `${ride.memberCount}/${ride.maxSeats}명 · ${seatsLeft}자리` : STATUS_LABEL[ride.status]),
      ride.match?.type === 'onTheWay' && h('span', { class: 'chip ok' }, '가는 길에 하차'),
      ride.joined && h('span', { class: 'chip ok' }, '참여 중'),
      ride.orgOnly && h('span', { class: 'chip' }, `🎓 ${ride.orgOnly}만`),
      ride.genderPref !== 'any' && h('span', { class: 'chip' }, GENDER_LABEL[ride.genderPref]),
    ),
    h('div', { class: 'host-line muted' }, `방장 ${ride.host.nickname}`, trustChips(ride.host)),
  );
}

/** datetime-local 입력값 ↔ Date */
export function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
