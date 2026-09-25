import { api, formatTime, GENDER_LABEL, relativeTime, STATUS_LABEL, won } from './core.js';
import { mapsAvailable, pickOnMap } from './maps.js';
import { debounce, h, toast } from './ui.js';

export const reverseGeocode = (lat, lng) =>
  api('GET', `/places/reverse?${new URLSearchParams({ lat, lng })}`).then((r) => r.place);

// 최근에 받은 현재 위치 (가까운 장소 먼저 검색용, 이 탭에서만 10분 기억)
const HERE_KEY = 'meet.here';
const HERE_TTL_MS = 10 * 60 * 1000;
export function rememberHere(lat, lng) {
  try { sessionStorage.setItem(HERE_KEY, JSON.stringify({ lat, lng, at: Date.now() })); } catch { /* 저장 불가 */ }
}
function recentHere() {
  try {
    const here = JSON.parse(sessionStorage.getItem(HERE_KEY));
    return here && Date.now() - here.at < HERE_TTL_MS ? here : null;
  } catch {
    return null;
  }
}
let locating = null;
/** 검색창을 누르면 현재 위치를 한 번 받아 둔다 (거부했으면 다시 묻지 않음) */
async function locateForSearch() {
  if (recentHere() || locating || !('geolocation' in navigator)) return;
  try {
    const status = await navigator.permissions?.query({ name: 'geolocation' });
    if (status?.state === 'denied') return;
  } catch { /* permissions API 미지원 브라우저 */ }
  locating = new Promise((resolve) => navigator.geolocation.getCurrentPosition(
    (pos) => { rememberHere(pos.coords.latitude, pos.coords.longitude); resolve(); },
    () => resolve(),
    { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 8000 },
  )).finally(() => { locating = null; });
}

const formatKm = (km) => (km < 1 ? `${Math.round(km * 1000)}m` : `${km}km`);

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
  /** 사용자가 직접 고른 경우 (검색 결과·현재 위치·지도) — 화면이 따라 움직이도록 알린다 */
  function pick(place) {
    select(place);
    picker.onChange?.(place);
  }

  const search = debounce(async (q) => {
    const id = ++seq;
    try {
      const here = recentHere();
      const params = new URLSearchParams({ q, ...(here && { lat: here.lat, lng: here.lng }) });
      const { places, source } = await api('GET', `/places/search?${params}`);
      if (id !== seq) return;
      suggestions = places;
      // 네이버 검색 키가 없으면 주요 장소 몇 곳만 검색된다는 걸 알려준다
      const presetNote = source === 'preset' && h('li', { class: 'muted preset-note' },
        '⚠️ 지금은 주요 장소(서울역·강남역·공항 등)만 검색돼요. 모든 주소·장소를 찾으려면 운영자가 네이버 검색 키를 설정해야 해요.');
      list.replaceChildren(...(places.length
        ? places.map((p) => h('li', { role: 'option', onclick: () => pick(p) },
            h('strong', {}, p.name),
            (p.address || p.category || p.distanceKm != null) && h('span', { class: 'muted' },
              [p.distanceKm != null && formatKm(p.distanceKm), p.category, p.address].filter(Boolean).join(' · '))))
        : [h('li', { class: 'muted' }, '검색 결과가 없어요.')]), ...(presetNote ? [presetNote] : []));
      list.hidden = false;
    } catch (err) {
      if (id === seq) toast(err.message);
    }
  }, 300);

  input.addEventListener('focus', locateForSearch, { once: true });
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
      pick(suggestions[0]);
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
        rememberHere(pos.coords.latitude, pos.coords.longitude);
        try {
          pick(await reverseGeocode(pos.coords.latitude, pos.coords.longitude));
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
      if (place) pick(place);
    },
  }, '🗺️');

  const picker = {
    /** 사용자가 장소를 고르면 호출 (set()으로 넣을 때는 호출하지 않음) */
    onChange: null,
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
  return picker;
}

export const routeSummary = (fare) =>
  `약 ${fare.distanceKm}km${fare.durationMin ? ` · ${fare.durationMin}분` : ''}`;

/** 성별 칩 — 합승에서는 동승자의 성별을 항상 보여준다 */
export function genderChip(gender) {
  if (!gender) return null;
  return h('span', { class: `chip gender ${gender}` }, gender === 'female' ? '👩 여성' : '👨 남성');
}

/** 매너 지표 칩: 성별, 본인 확인, 소속, 매너 점수, 노쇼 이력 */
export function trustChips(user) {
  const { stats } = user;
  return [
    genderChip(user.gender),
    user.verified && h('span', { class: 'chip ok', title: '휴대폰 본인 확인 완료' }, '✔ 본인확인'),
    user.org && h('span', { class: 'chip ok', title: '학교/회사 이메일 인증' }, `🎓 ${user.org}`),
    stats.mannerPercent !== null
      ? h('span', { class: 'chip', title: `평가 ${stats.ratings}건` }, `👍 ${stats.mannerPercent}%`)
      : h('span', { class: 'chip', title: '평가가 3건 이상이면 매너 점수가 표시돼요' }, `🆕 합승 ${stats.completedRides}회`),
    stats.noShows > 0 && h('span', { class: 'chip warn' }, `노쇼 ${stats.noShows}`),
    stats.lateCancels > 0 && h('span', { class: 'chip warn' }, `직전취소 ${stats.lateCancels}`),
  ];
}

/** "혼자 11,600원 → 합승 3,870원 · 7,730원 절약" — 합승할 이유를 한눈에 */
export function savingsLine(total, share, atLeast = false) {
  const saved = total - share;
  // 아직 혼자면 줄 그을 게 없으니, 한 명만 더 오면 얼마인지 보여준다
  if (saved <= 0) {
    return h('div', { class: 'savings' },
      h('span', {}, `아직 혼자예요 · 한 명만 더 오면 `),
      h('strong', {}, won(Math.ceil(total / 2 / 10) * 10)),
      h('span', { class: 'chip saved' }, `💰 ${won(total - Math.ceil(total / 2 / 10) * 10)} 절약`));
  }
  return h('div', { class: 'savings' },
    h('span', { class: 'solo' }, `혼자 ${won(total)}`),
    h('span', { class: 'arrow' }, '→'),
    h('strong', {}, `${atLeast ? '1인 ' : '내 몫 '}${won(share)}${atLeast ? '~' : ''}`),
    saved > 0 && h('span', { class: 'chip saved' }, `💰 ${won(saved)} 절약`));
}

export function rideCard(ride) {
  const seatsLeft = ride.maxSeats - ride.memberCount;
  const soon = ride.status === 'open' && new Date(ride.departAt).getTime() - Date.now() < 60 * 60 * 1000;
  return h('a', { class: 'card ride-card', href: `#/rides/${ride.id}` },
    h('div', { class: 'route' }, ride.origin.name, h('span', { class: 'arrow' }, '→'), ride.destination.name),
    h('div', { class: 'muted' },
      soon && h('strong', { class: 'soon' }, `${relativeTime(ride.departAt)} · `),
      `${formatTime(ride.departAt)} 출발 · ${routeSummary(ride.fare)}`),
    savingsLine(ride.fare.total, ride.fare.mine ?? ride.fare.perPersonFull, !ride.fare.mine),
    h('div', { class: 'chips' },
      h('span', { class: 'chip' }, ride.status === 'open' ? `${ride.memberCount}/${ride.maxSeats}명 · ${seatsLeft}자리` : STATUS_LABEL[ride.status]),
      ride.match?.type === 'onTheWay' && h('span', { class: 'chip ok' }, '가는 길에 하차'),
      ride.joined && h('span', { class: 'chip ok' }, '참여 중'),
      ride.orgOnly && h('span', { class: 'chip' }, `🎓 ${ride.orgOnly}만`),
      h('span', { class: 'chip' }, GENDER_LABEL[ride.genderPref]),
    ),
    h('div', { class: 'host-line muted' }, `방장 ${ride.host.nickname}`, trustChips(ride.host)),
  );
}

/** datetime-local 입력값 ↔ Date */
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const DAY_LABELS = ['오늘', '내일', '모레'];
const pad = (n) => String(n).padStart(2, '0');
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d; };

/**
 * 출발 시간 선택: 날짜는 "오늘/내일…" 목록, 시간은 시간 입력칸 — 보통은 시간만 바꾸면 된다.
 * 오늘인데 이미 지난 시간을 고르면 자동으로 내일로 넘긴다. 빠른 선택(10분 뒤 등) 버튼 제공.
 * value() → Date, set(ms), onChange(Date)
 */
export function timePicker(initial, { days = 7, onChange } = {}) {
  const daySelect = h('select', { 'aria-label': '출발 날짜', class: 'day-select' });
  const timeInput = h('input', { type: 'time', 'aria-label': '출발 시각', class: 'time-input' });
  const hint = h('div', { class: 'muted time-hint' });

  function renderDays() {
    const today = startOfDay(Date.now());
    const keep = daySelect.value;
    daySelect.replaceChildren(...Array.from({ length: days }, (_, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const date = `${d.getMonth() + 1}/${d.getDate()} ${DAY_NAMES[d.getDay()]}`;
      return h('option', { value: i }, DAY_LABELS[i] ? `${DAY_LABELS[i]} (${date})` : date);
    }));
    if (keep) daySelect.value = keep;
  }

  function value() {
    const d = startOfDay(Date.now());
    d.setDate(d.getDate() + Number(daySelect.value || 0));
    const [hh, mm] = (timeInput.value || '00:00').split(':').map(Number);
    d.setHours(hh, mm, 0, 0);
    return d;
  }

  function set(ms) {
    // 5분 단위로 올림
    const t = new Date(Math.ceil(ms / 300000) * 300000);
    const offset = Math.round((startOfDay(t) - startOfDay(Date.now())) / 86400000);
    renderDays();
    daySelect.value = String(Math.min(Math.max(offset, 0), days - 1));
    timeInput.value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
    hint.textContent = '';
  }

  function changed() {
    hint.textContent = '';
    // 오늘인데 지난 시각이면 내일로
    if (daySelect.value === '0' && timeInput.value && value().getTime() < Date.now() - 60000) {
      daySelect.value = '1';
      hint.textContent = '⏭️ 이미 지난 시각이라 내일로 바꿨어요.';
    }
    onChange?.(value());
  }
  daySelect.addEventListener('change', changed);
  timeInput.addEventListener('change', changed);

  const quick = [[10, '10분 뒤'], [30, '30분 뒤'], [60, '1시간 뒤']].map(([min, label]) => h('button', {
    type: 'button',
    class: 'secondary small',
    onclick: () => {
      set(Date.now() + min * 60000);
      onChange?.(value());
    },
  }, label));

  set(initial ?? Date.now() + 15 * 60000);
  return {
    el: h('div', { class: 'time-picker' },
      h('div', { class: 'row' }, daySelect, timeInput),
      h('div', { class: 'row quick-times' }, quick),
      hint),
    value,
    set,
  };
}

export function toLocalInput(date) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}
