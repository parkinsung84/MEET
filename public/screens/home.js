import { placePicker, rideCard, toLocalInput } from '../components.js';
import { api, formatTime, listen, relativeTime, state } from '../core.js';
import { h, toast } from '../ui.js';

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

  function emptyState(o, d, range) {
    const actions = [];
    // 지금 조건 그대로 방 만들기
    actions.push(h('button', {
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
      const { rides } = await api('GET', `/rides?${params}`);
      list.replaceChildren(
        h('h2', {}, `${mode === 'now' ? `${NOW_WINDOW_MIN}분 안에 출발하는` : '그 시간대'} 합승 ${rides.length}건`),
        ...(rides.length ? rides.map(rideCard) : [emptyState(o, d, range)]),
      );
    } catch (err) {
      if (!silent) toast(err.message);
    }
  }

  // 다른 사용자가 방을 만들거나 참여하면 목록을 조용히 새로고침
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  listen(window, 'rides:changed', () => load({ silent: true }));
  renderTabs();
  load({ silent: true });

  return h('div', {},
    !state.user.verified && h('a', { class: 'card banner warn', href: '#/verify' },
      h('strong', {}, '📧 이메일 인증이 필요해요'), h('div', {}, '인증을 마치면 합승을 만들고 참여할 수 있어요.')),
    upcomingBanner(),
    form,
    list,
    h('a', { class: 'btn fab', href: '#/new' }, '+ 합승방 만들기'),
  );
}
