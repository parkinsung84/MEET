import { placePicker, reverseGeocode, rideCard, toLocalInput } from '../components.js';
import { api, formatTime, listen, relativeTime, state } from '../core.js';
import { mapProblem, renderRidesMap } from '../maps.js';
import { h, sheet, toast } from '../ui.js';

const NOW_WINDOW_MIN = 30;   // '지금 바로': 30분 안에 출발
const LATER_WINDOW_MIN = 30; // '시간 지정': ±30분
const SEARCH_KEY = 'meet.search';

/** 검색 조건을 기억해 두었다가 상세 화면에서 돌아왔을 때 복원 */
const saved = () => {
  try { return JSON.parse(sessionStorage.getItem(SEARCH_KEY)) ?? {}; } catch { return {}; }
};

function upcomingBanner() {
  const box = h('div');
  api('GET', '/rides/mine').then(({ rides }) => {
    const next = rides
      .filter((r) => r.status === 'open' || r.status === 'departed')
      .sort((a, b) => a.departAt.localeCompare(b.departAt))[0];
    if (!next) return;
    box.replaceChildren(h('a', { class: 'card banner', href: `#/rides/${next.id}` },
      h('strong', {}, next.status === 'departed' ? '🚕 이동 중인 합승' : `⏰ ${relativeTime(next.departAt)} 출발하는 내 합승`),
      h('div', {}, `${next.origin.name} → ${next.destination.name}`),
      h('div', { class: 'muted' }, `${formatTime(next.departAt)} · ${next.memberCount}/${next.maxSeats}명`)));
  }).catch(() => {});
  return box;
}

/** 자동 매칭 상태 배너 (찾는 중 / 매칭됨) */
function matchBanner() {
  const box = h('div');
  async function render() {
    try {
      const { request } = await api('GET', '/matching');
      if (request?.status === 'waiting') {
        box.replaceChildren(h('div', { class: 'card banner matching' },
          h('strong', {}, '🤖 자동 매칭 찾는 중…'),
          h('div', {}, `${request.origin.name} → ${request.destination.name}`),
          h('div', { class: 'muted' }, `${formatTime(request.to)}까지 · 맞는 사람이나 방이 생기면 바로 알려드려요`),
          h('button', {
            class: 'secondary small',
            onclick: async () => {
              await api('DELETE', '/matching').catch((err) => toast(err.message));
              render();
            },
          }, '매칭 취소')));
      } else if (request?.status === 'matched' && Date.now() - Date.parse(request.to) < 0) {
        box.replaceChildren(h('a', { class: 'card banner', href: `#/rides/${request.rideId}` },
          h('strong', {}, '🎉 자동 매칭 완료!'),
          h('div', {}, `${request.origin.name} → ${request.destination.name} · 눌러서 합승방으로`)));
      } else {
        box.replaceChildren();
      }
    } catch { /* 무시 */ }
  }
  render();
  listen(window, 'notification', (e) => {
    if (['matched', 'match-expired'].includes(e.detail.type)) render();
  });
  box.refresh = render;
  return box;
}

export function homeScreen() {
  const prev = saved();
  let mode = prev.mode ?? 'now';
  const origin = placePicker('출발지', { allowCurrent: true });
  const dest = placePicker('도착지');
  if (prev.origin) origin.set(prev.origin);
  if (prev.destination) dest.set(prev.destination);

  const timeInput = h('input', { type: 'datetime-local', value: prev.time ?? toLocalInput(Date.now() + 60 * 60 * 1000) });
  const timeRow = h('label', { hidden: mode === 'now' }, `출발 시간 (±${LATER_WINDOW_MIN}분)`, timeInput);
  const radius = h('select', { 'aria-label': '검색 반경' },
    [1, 2, 3, 5].map((km) => h('option', { value: km, selected: km === (prev.radiusKm ?? 2) }, `반경 ${km}km`)));
  const modeTabs = h('div', { class: 'tabs' });
  const list = h('div');
  // 검색 결과를 지도에 핀으로 (네이버 지도 키가 있을 때만 보임)
  const mapEl = h('div', { class: 'rides-map' });
  const mapCard = h('div', { class: 'card map-card needs-map', hidden: true }, mapEl,
    h('div', { class: 'muted map-hint' }, '👆 지도를 누르면 그 위치를 출발지·도착지로 정할 수 있어요. 핀을 누르면 합승방으로 가요.'));

  /** 지도에서 누른 곳 → 주소 확인 후 출발지/도착지로 설정하고 다시 검색 */
  async function pickFromMap(at, clearPin) {
    let place;
    try {
      place = await reverseGeocode(at.lat, at.lng);
    } catch {
      place = null;
    }
    place ??= { name: '지도에서 고른 위치', address: '', ...at };
    const use = (picker) => (close) => {
      close();
      picker.set(place);
      load();
    };
    sheet('📍 이 위치를…', h('div', { class: 'stack' },
      h('strong', {}, place.name), place.address && h('div', { class: 'muted' }, place.address)), [
      { label: '출발지로', onClick: use(origin) },
      { label: '도착지로', onClick: use(dest) },
      { label: '취소', class: 'secondary', onClick: (close) => { close(); clearPin(); } },
    ]);
  }
  let ridesMap = null;
  // 지도가 안 뜨면 이유를 보여준다 (운영 초기 설정 확인용)
  const mapNote = h('div', { class: 'card banner warn map-note', hidden: true });
  const showProblem = (reason) => {
    if (!reason) return;
    mapNote.replaceChildren(h('strong', {}, '🗺️ 지도가 꺼져 있어요'), h('div', { class: 'muted' }, reason));
    mapNote.hidden = false;
  };
  state.mapsReady.then(() => showProblem(mapProblem()));
  listen(window, 'maps:problem', (e) => showProblem(e.detail));
  async function showMap(rides, me) {
    if (!(await state.mapsReady)) return;
    ridesMap?.destroy();
    mapCard.hidden = false;
    ridesMap = renderRidesMap(mapEl, rides, {
      me,
      onPick: pickFromMap,
      label: (r) => `${new Date(r.departAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })} · ${r.memberCount}/${r.maxSeats}명`,
    });
  }

  function renderTabs() {
    modeTabs.replaceChildren(
      h('button', { type: 'button', class: mode === 'now' ? '' : 'secondary', onclick: () => setMode('now') }, '⚡ 지금 바로'),
      h('button', { type: 'button', class: mode === 'later' ? '' : 'secondary', onclick: () => setMode('later') }, '🕐 시간 지정'));
    timeRow.hidden = mode === 'now';
  }
  function setMode(next) {
    mode = next;
    renderTabs();
    load();
  }

  function timeRange() {
    if (mode === 'now') return { from: new Date(), to: new Date(Date.now() + NOW_WINDOW_MIN * 60000) };
    const center = new Date(timeInput.value);
    if (Number.isNaN(center.getTime())) throw new Error('출발 시간을 선택해 주세요.');
    return { from: new Date(center - LATER_WINDOW_MIN * 60000), to: new Date(center.getTime() + LATER_WINDOW_MIN * 60000) };
  }

  const form = h('form', { class: 'card stack' },
    modeTabs, origin.el, dest.el, timeRow,
    h('div', { class: 'row' }, radius, h('button', {}, '🔍 합승 찾기')),
  );

  /** 자동 매칭 신청: 지금 조건(경로·시간)으로 요청 → 맞는 방에 자동 참여하거나 같은 요청끼리 방을 만든다 */
  async function requestMatch(o, d, range) {
    try {
      const { request } = await api('POST', '/matching', {
        origin: o, destination: d, radiusKm: Math.min(Number(radius.value), 3),
        from: range.from.toISOString(), to: range.to.toISOString(),
      });
      if (request.status === 'matched') {
        toast('🎉 바로 매칭됐어요!');
        location.hash = `#/rides/${request.rideId}`;
      } else {
        toast('🤖 매칭을 찾는 중이에요. 맞는 사람이 생기면 바로 알려드릴게요.');
        banner.refresh();
      }
    } catch (err) {
      toast(err.message);
    }
  }

  const matchButton = (o, d, range, primary) => h('button', {
    class: primary ? 'wide' : 'secondary wide',
    onclick: () => requestMatch(o, d, range),
  }, '🤖 자동 매칭 신청');

  function emptyState(o, d, range) {
    const actions = [];
    // 가장 쉬운 길: 자동 매칭 (방을 찾거나 만들 필요 없음)
    if (o && d) actions.push(matchButton(o, d, range, true));
    // 지금 조건 그대로 방 만들기
    actions.push(h('button', {
      class: 'secondary',
      onclick: () => {
        sessionStorage.setItem('meet.draft', JSON.stringify({
          origin: o, destination: d,
          departAt: mode === 'now' ? new Date(Date.now() + 10 * 60000).toISOString() : new Date(timeInput.value).toISOString(),
        }));
        location.hash = '#/new';
      },
    }, '➕ 이 조건으로 합승방 만들기'));
    if (o && d) {
      actions.push(h('button', {
        class: 'secondary',
        onclick: async () => {
          try {
            await api('POST', '/alerts', {
              origin: o, destination: d, radiusKm: Number(radius.value),
              from: range.from.toISOString(),
              // '지금 바로'는 앞으로 1시간 동안 알림
              to: (mode === 'now' ? new Date(Date.now() + 60 * 60000) : range.to).toISOString(),
            });
            toast('🔔 이 경로로 합승방이 생기면 알려드릴게요.');
          } catch (err) {
            toast(err.message);
          }
        },
      }, '🔔 이 경로로 방이 생기면 알림 받기'));
    }
    return h('div', { class: 'empty stack' },
      h('div', {}, '조건에 맞는 합승이 없어요.'),
      h('div', { class: 'stack' }, actions));
  }

  async function load({ silent = false } = {}) {
    try {
      const o = origin.value();
      const d = dest.value();
      const range = timeRange();
      sessionStorage.setItem(SEARCH_KEY, JSON.stringify({
        mode, origin: o, destination: d, time: timeInput.value, radiusKm: Number(radius.value),
      }));
      const params = new URLSearchParams({ radiusKm: radius.value, from: range.from.toISOString(), to: range.to.toISOString() });
      if (o) params.set('originLat', o.lat), params.set('originLng', o.lng);
      if (d) params.set('destLat', d.lat), params.set('destLng', d.lng);
      const { rides, demand } = await api('GET', `/rides?${params}`);
      showMap(rides, o);
      list.replaceChildren(h('div', {},
        h('h2', {}, `${mode === 'now' ? `${NOW_WINDOW_MIN}분 안에 출발하는` : '그 시간대'} 합승 ${rides.length}건`),
        demand > 0 && h('div', { class: 'demand' }, `👀 지금 이 경로를 ${demand}명이 찾고 있어요 — 자동 매칭을 신청하면 바로 연결돼요`),
        ...(rides.length ? rides.map(rideCard) : [emptyState(o, d, range)]),
        rides.length > 0 && o && d && h('div', { class: 'stack match-more' },
          h('p', { class: 'muted' }, '맞는 방이 없나요? 자동 매칭을 신청하면 조건이 맞는 방이나 사람을 찾아 바로 연결해 드려요.'),
          matchButton(o, d, range, false)),
      ));
    } catch (err) {
      if (!silent) toast(err.message);
    }
  }

  // 다른 사용자가 방을 만들거나 참여하면 목록을 조용히 새로고침
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  listen(window, 'rides:changed', () => load({ silent: true }));
  // 출발지·도착지를 고르면(현재 위치 포함) 바로 다시 찾고 지도도 그 위치로 옮긴다
  origin.onChange = () => load();
  dest.onChange = () => load();
  renderTabs();
  load({ silent: true });
  const banner = matchBanner();
  listen(window, 'rides:changed', () => banner.refresh());

  return h('div', {},
    !state.user.verified && h('a', { class: 'card banner warn', href: '#/verify' },
      h('strong', {}, '📱 휴대폰 본인 확인이 필요해요'), h('div', {}, '확인을 마치면 합승을 만들고 참여할 수 있어요.')),
    banner,
    upcomingBanner(),
    form,
    mapNote,
    mapCard,
    list,
    h('a', { class: 'btn fab', href: '#/new' }, '+ 합승방 만들기'),
  );
}
