import { formatKm, trustChips } from '../components.js';
import { api, canUseRides, emit, listen, onLeave, relativeTime, state, won } from '../core.js';
import { locate } from '../here.js';
import { h, sheet, toast } from '../ui.js';

// 정기 노선 (출퇴근 택시 크루): 누구나 볼 수 있는 목록 → 참여 → 크루 채팅 → 운행일마다 합승방 자동

const DAYS = [['mon', '월'], ['tue', '화'], ['wed', '수'], ['thu', '목'], ['fri', '금'], ['sat', '토'], ['sun', '일']];
const GENDER_ONLY = { male: '👨 남성만', female: '👩 여성만' };
const AFTER_LOGIN_KEY = 'meet.afterLogin';

/** 로그인이 필요한 동작: 로그인 후 이 화면으로 돌아오게 */
export function requireLogin() {
  if (state.user) return true;
  sessionStorage.setItem(AFTER_LOGIN_KEY, location.hash);
  location.hash = '#/login';
  return false;
}
/** 로그인·가입 직후 돌아갈 화면 (없으면 null) */
export function takeAfterLogin() {
  const hash = sessionStorage.getItem(AFTER_LOGIN_KEY);
  sessionStorage.removeItem(AFTER_LOGIN_KEY);
  return hash;
}

/** 노선 카드 (목록) */
export function commuteCard(c) {
  return h('a', { class: `card commute-card${c.seatsLeft ? '' : ' full'}`, href: `#/c/${c.id}` },
    h('div', { class: 'commute-time' }, h('strong', {}, c.departTime), h('span', {}, c.daysLabel)),
    h('div', { class: 'route' }, c.origin.area, h('span', { class: 'arrow' }, '→'), c.destination.area),
    h('div', { class: 'chips' },
      h('span', { class: `chip${c.seatsLeft ? ' hl' : ''}` }, c.seatsLeft ? `${c.seatsLeft}자리 남음` : '마감'),
      h('span', { class: 'chip' }, `${c.memberCount}/${c.maxSeats}명`),
      h('span', { class: 'chip' }, `1인 약 ${won(c.fare.perPerson)}`),
      c.genderPref !== 'any' && h('span', { class: 'chip' }, GENDER_ONLY[c.genderPref]),
      c.joined && h('span', { class: 'chip ok' }, c.isOwner ? '내 노선' : '참여 중')),
    c.memo && h('p', { class: 'muted memo-line' }, c.memo));
}

// ---------------------------------------------------------------- 거점

let hubsPromise = null;
/** 거점 목록·추천 노선 → { groups, hubs: [{ code, name, group }], featured } (자주 바뀌지 않아 한 번만) */
export function loadHubs({ fresh = false } = {}) {
  if (fresh) hubsPromise = null;
  hubsPromise ??= api('GET', '/commutes/hubs').catch((err) => { hubsPromise = null; throw err; });
  return hubsPromise;
}

/** 거점 고르기 (지역별로 묶은 선택 목록). value() → 거점 id 또는 null */
function hubSelect(label, { initial = null } = {}) {
  const select = h('select', { 'aria-label': label }, h('option', { value: '' }, `${label} 선택`));
  loadHubs().then(({ groups, hubs }) => {
    select.append(...groups.map((g) => h('optgroup', { label: g },
      hubs.filter((x) => x.group === g).map((x) => h('option', { value: x.code, selected: x.code === initial }, x.name)))));
  }).catch(() => toast('거점 목록을 불러오지 못했어요.'));
  return {
    el: h('label', {}, label, select),
    value: () => select.value || null,
  };
}

const km = (a, b) => {
  const rad = (d) => (d * Math.PI) / 180;
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

// ---------------------------------------------------------------- 크루 만들기 (공통 폼)

/** 노선(출발 동 → 도착 동)에 새 크루를 만드는 폼. getRoute() → { from, to } */
function crewForm(getRoute, { submitLabel = '이 시간으로 크루 만들기' } = {}) {
  const picked = new Set(['mon', 'tue', 'wed', 'thu', 'fri']);
  const dayRow = h('div', { class: 'day-toggles', role: 'group', 'aria-label': '타는 요일' });
  function renderDays() {
    dayRow.replaceChildren(...DAYS.map(([key, name]) => h('button', {
      type: 'button',
      class: picked.has(key) ? 'day on' : 'day',
      'aria-pressed': String(picked.has(key)),
      onclick: () => { picked.has(key) ? picked.delete(key) : picked.add(key); renderDays(); },
    }, name)));
  }
  renderDays();
  const presets = h('div', { class: 'row quick-times' },
    ...[['평일', ['mon', 'tue', 'wed', 'thu', 'fri']], ['매일', DAYS.map(([k]) => k)], ['월수금', ['mon', 'wed', 'fri']], ['화목', ['tue', 'thu']]]
      .map(([name, keys]) => h('button', {
        type: 'button', class: 'secondary small',
        onclick: () => { picked.clear(); keys.forEach((k) => picked.add(k)); renderDays(); },
      }, name)));
  const myGender = state.user?.gender === 'female' ? '여성' : '남성';
  const form = h('form', { class: 'stack' },
    h('div', { class: 'row' },
      h('label', {}, '출발 시각', h('input', { name: 'departTime', type: 'time', value: '08:00', required: true, class: 'time-input' })),
      h('label', {}, '정원 (본인 포함)',
        h('select', { name: 'maxSeats' }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === 4 }, `${n}명`))))),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '타는 요일'), dayRow, presets),
    h('label', {}, '만날 곳 (멤버에게만 보여요)',
      h('input', { name: 'meetingPoint', maxlength: 100, placeholder: '예: 역삼역 3번 출구 앞' })),
    h('label', {}, '모집 성별',
      h('select', { name: 'genderPref' },
        h('option', { value: 'any' }, '성별 무관'),
        state.user && h('option', { value: state.user.gender }, `${myGender}만`))),
    h('label', {}, '한마디 (누구나 볼 수 있어요)',
      h('textarea', { name: 'memo', rows: 2, maxlength: 300, placeholder: '예: 늦으면 5분까지 기다려요!' })),
    h('button', {}, submitLabel));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!requireLogin()) return;
    if (!canUseRides()) { location.hash = '#/verify'; return; }
    try {
      const { from, to } = getRoute();
      if (!from || !to) throw new Error('출발과 도착 거점을 골라 주세요.');
      const days = DAYS.map(([k]) => k).filter((k) => picked.has(k));
      if (!days.length) throw new Error('타는 요일을 골라 주세요.');
      const { commute } = await api('POST', '/commutes', {
        from, to, days, departTime: form.departTime.value,
        maxSeats: Number(form.maxSeats.value), genderPref: form.genderPref.value,
        meetingPoint: form.meetingPoint.value, memo: form.memo.value,
      });
      toast('크루를 만들었어요! 링크를 공유해서 같이 탈 사람을 모아 보세요.');
      location.hash = `#/c/${commute.id}`;
    } catch (err) {
      toast(err.message);
    }
  });
  return form;
}

// ---------------------------------------------------------------- 첫 화면: 노선 고르기

/** 추천 노선 카드 */
function featuredCard(r) {
  return h('a', { class: 'card featured-route', href: `#/r/${r.from.code}/${r.to.code}` },
    h('div', { class: 'route' }, r.from.name, h('span', { class: 'arrow' }, '→'), r.to.name),
    h('div', { class: 'muted' }, `4명이면 1인 약 ${won(r.perPerson)}`),
    h('div', { class: `chip${r.crews ? ' hl' : ''}` }, r.crews ? `크루 ${r.crews}개 · ${r.riders}명` : '첫 크루 모집'));
}

/**
 * 노선 직접 고르기: ① 출발 거점 → ② 도착 거점 (지역별 칩). 고르면 바로 노선 화면으로.
 */
function hubChooser() {
  let from = null;
  const box = h('div', { class: 'card stack hub-chooser' });
  const locateBtn = h('button', {
    type: 'button', class: 'secondary small',
    onclick: async () => {
      const here = await locate({ accurate: true });
      if (!here) return toast('위치를 가져올 수 없어요. 브라우저의 위치 권한을 확인해 주세요.');
      const { hubs } = await loadHubs();
      const nearest = hubs.reduce((best, x) => (!best || km(here, x) < km(here, best) ? x : best), null);
      if (km(here, nearest) > 5) return toast('가까운 거점이 없어요. 목록에서 골라 주세요.');
      from = nearest;
      render();
    },
  }, '📍 내 위치에서 가까운 거점');

  async function render() {
    const { groups, hubs } = await loadHubs();
    const chip = (x, onPick, disabled = false) => h('button', {
      type: 'button', class: `hub-chip${from?.code === x.code ? ' on' : ''}`, disabled, onclick: () => onPick(x),
    }, x.name);
    const grid = (onPick) => groups.map((g) => h('div', { class: 'hub-group' },
      h('div', { class: 'hub-group-name' }, g),
      h('div', { class: 'hub-chips' }, hubs.filter((x) => x.group === g).map((x) => chip(x, onPick, from && x.code === from.code)))));
    if (!from) {
      box.replaceChildren(
        h('div', { class: 'row step-head' }, h('strong', {}, '① 어디서 출발하세요?'), locateBtn),
        ...grid((x) => { from = x; render(); window.scrollTo({ top: box.offsetTop - 60, behavior: 'smooth' }); }));
    } else {
      box.replaceChildren(
        h('div', { class: 'row step-head' },
          h('strong', {}, `② ${from.name}에서 어디로 가세요?`),
          h('button', { type: 'button', class: 'secondary small', onclick: () => { from = null; render(); } }, '출발 다시 고르기')),
        ...grid((x) => { location.hash = `#/r/${from.code}/${x.code}`; }));
    }
  }
  render().catch(() => box.replaceChildren(h('div', { class: 'empty' }, '거점 목록을 불러오지 못했어요.')));
  return box;
}

export function commuteHomeScreen() {
  const featuredBox = h('div', { class: 'featured' }, h('div', { class: 'empty' }, '불러오는 중…'));
  loadHubs({ fresh: true }).then(({ featured }) => {
    // 크루가 있는 노선을 앞으로
    const sorted = [...featured].sort((a, b) => b.riders - a.riders);
    featuredBox.replaceChildren(...sorted.map(featuredCard));
  }).catch((err) => featuredBox.replaceChildren(h('div', { class: 'empty' }, err.message)));

  const list = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  async function load() {
    try {
      const { commutes } = await api('GET', '/commutes');
      list.replaceChildren(...(commutes.length
        ? [h('p', { class: 'muted list-count' }, `모집 중인 크루 전체 ${commutes.length}개`), ...commutes.map(commuteCard)]
        : [h('div', { class: 'empty' }, '아직 모집 중인 크루가 없어요. 위에서 노선을 골라 첫 크루를 만들어 보세요!')]));
    } catch (err) {
      list.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }
  listen(window, 'commutes:changed', () => load());
  load();

  return h('div', {},
    h('section', { class: 'hero' },
      h('h1', {}, '출퇴근 택시, 같이 타면 ', h('span', { class: 'hl-text' }, '반값')),
      h('p', {}, '강남·여의도·광화문·판교 등 주요 업무지구 노선이 모두 준비돼 있어요. 내 출퇴근 노선을 골라 같은 시간에 타는 사람들과 크루를 만드세요.')),
    h('h2', {}, '🔥 추천 출퇴근 노선'),
    featuredBox,
    h('h2', {}, '🧭 노선 직접 고르기'),
    hubChooser(),
    h('h2', {}, '🚕 모집 중인 크루'),
    list,
    h('p', { class: 'muted center' },
      '오늘 한 번만 같이 탈 사람을 찾나요? ', h('a', { href: '#/rides' }, '당일 합승 찾기 →')));
}

// ---------------------------------------------------------------- 노선 화면 (출발 거점 → 도착 거점)

/**
 * 노선 채팅: 이 노선(출발 동 → 도착 동)에 관심 있는 사람 누구나 정확히 어디서 타고 내릴지 의논한다.
 * 로그인한 사람만 보고 쓸 수 있다.
 */
function routeChatCard(fromCode, toCode) {
  const log = h('div', { class: 'chat-log' });
  const card = h('div', { class: 'card' },
    h('h2', {}, '💬 노선 채팅'),
    h('p', { class: 'muted' }, '이 노선에 관심 있는 사람 누구나 들어와요. 정확히 어디서 타고 어디서 내릴지 같이 정해 보세요. 집 주소 대신 역 출구·건물 앞처럼 공개된 장소로 이야기해 주세요.'));
  if (!state.user) {
    card.append(h('button', { class: 'secondary wide', onclick: () => requireLogin() }, '로그인하고 노선 채팅 보기'));
    return card;
  }
  const append = (m) => {
    log.querySelector('.empty-chat')?.remove();
    log.append(h('div', { class: `msg${m.userId === state.user.id ? ' me' : ''}` },
      h('div', { class: 'who' }, m.nickname), h('div', {}, m.body)));
    log.scrollTop = log.scrollHeight;
  };
  const input = h('input', { placeholder: '예: 역삼역 3번 출구에서 타면 어때요?', maxlength: 500, autocomplete: 'off' });
  const quick = h('div', { class: 'row quick-times' },
    ...[['📍 출발지', '📍 출발은 여기 어때요: '], ['🏁 도착지', '🏁 내리는 곳은 여기 어때요: '], ['⏰ 시간', '⏰ 저는 이 시간에 타요: ']]
      .map(([label, prefix]) => h('button', {
        type: 'button', class: 'secondary small',
        onclick: () => { input.value = prefix; input.focus(); },
      }, label)));
  const form = h('form', { class: 'row' }, input, h('button', { class: 'fit' }, '전송'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    if (!canUseRides()) { location.hash = '#/verify'; return; }
    try {
      await api('POST', `/commutes/routes/${fromCode}/${toCode}/messages`, { body: input.value });
      input.value = '';
    } catch (err) {
      toast(err.message);
    }
  });
  card.append(h('div', { class: 'chat' }, log, h('div', { class: 'stack' }, quick, form)));

  const onMessage = (m) => { if (m.from === fromCode && m.to === toCode) append(m); };
  state.socket?.on('route:message', onMessage);
  emit('route:subscribe', { from: fromCode, to: toCode }).catch(() => {});
  onLeave(() => {
    state.socket?.off('route:message', onMessage);
    state.socket?.emit('route:unsubscribe', { from: fromCode, to: toCode });
  });
  api('GET', `/commutes/routes/${fromCode}/${toCode}/messages`)
    .then(({ messages }) => {
      if (!messages.length) log.append(h('div', { class: 'muted empty-chat' }, '아직 대화가 없어요. 먼저 인사해 보세요!'));
      messages.forEach(append);
    })
    .catch((err) => toast(err.message));
  return card;
}

export function routeScreen(fromCode, toCode) {
  const root = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  const chat = routeChatCard(fromCode, toCode);

  async function share(r) {
    const url = `${location.origin}/r/${r.from.code}/${r.to.code}`;
    const text = `🚕 ${r.from.name} → ${r.to.name} 출퇴근 택시 같이 타요 (4명이면 1인 약 ${won(r.fare.perPerson)})`;
    try {
      if (navigator.share) await navigator.share({ title: 'MEET 출퇴근 택시', text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast('링크를 복사했어요. 카톡·커뮤니티에 붙여넣어 주세요.');
      }
    } catch { /* 공유 취소 */ }
  }

  api('GET', `/commutes/routes/${fromCode}/${toCode}`).then(({ route: r }) => {
    root.replaceChildren(h('div', {},
      h('div', { class: 'card route-head' },
        h('div', { class: 'muted' }, '출퇴근 노선'),
        h('div', { class: 'route big' },
          h('span', {}, h('small', {}, r.from.group), ' ', r.from.name), h('span', { class: 'arrow' }, '→'),
          h('span', {}, h('small', {}, r.to.group), ' ', r.to.name)),
        h('div', { class: 'chips' },
          h('span', { class: 'chip' }, `약 ${formatKm(r.distanceKm)}`),
          h('span', { class: 'chip' }, `혼자 약 ${won(r.fare.total)}`),
          h('span', { class: 'chip hl' }, `4명이면 1인 약 ${won(r.fare.perPerson)}`)),
        h('div', { class: 'row' },
          h('a', { class: 'btn secondary small', href: `#/r/${r.to.code}/${r.from.code}` }, '↔ 반대 방향 (퇴근길)'),
          h('button', { class: 'secondary small', onclick: () => share(r) }, '🔗 노선 공유'))),
      h('h2', {}, r.commutes.length ? `⏰ 모집 중인 크루 ${r.commutes.length}개` : '⏰ 아직 이 노선에 크루가 없어요'),
      ...(r.commutes.length
        ? r.commutes.map(commuteCard)
        : [h('p', { class: 'muted' }, '첫 크루를 만들어 보세요. 노선 링크를 공유하면 같은 길을 가는 사람들이 들어와요.')]),
      chat,
      r.nearby.length > 0 && h('div', {},
        h('h2', {}, '🧭 가까운 거점에서 출발·도착하는 크루'),
        h('p', { class: 'muted' }, '양쪽 끝이 1.5km 안이라 같이 타기 괜찮아요.'),
        ...r.nearby.map(commuteCard)),
      h('div', { class: 'card stack' },
        h('h2', {}, r.commutes.length ? '원하는 시간이 없나요?' : '＋ 첫 크루 만들기'),
        crewForm(() => ({ from: r.from.code, to: r.to.code }), { submitLabel: '이 시간으로 크루 만들기' })),
      h('p', { class: 'center' }, h('a', { href: '#/' }, '← 다른 노선 고르기'))));
  }).catch((err) => root.replaceChildren(h('div', { class: 'empty' }, err.message)));
  return root;
}

// ---------------------------------------------------------------- 크루 만들기 (거점 고르기 + 크루 폼)

export function newCommuteScreen() {
  if (!requireLogin()) return h('div');
  const from = hubSelect('출발 거점');
  const to = hubSelect('도착 거점');
  return h('div', {},
    h('h1', {}, '내 출퇴근 크루 만들기'),
    h('p', { class: 'muted' }, '출발·도착 거점과 타는 시간을 정하면 같은 길을 가는 사람들이 보고 참여해요.'),
    h('div', { class: 'card stack' }, from.el, to.el,
      crewForm(() => ({ from: from.value(), to: to.value() }), { submitLabel: '크루 만들기' })));
}

// ---------------------------------------------------------------- 노선 상세

export function commuteScreen(id) {
  const root = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  const chatLog = h('div', { class: 'chat-log' });
  let c = null;
  let subscribed = false;
  let chatLoaded = false;

  function appendMessage(m) {
    chatLog.append(h('div', { class: `msg${m.userId === state.user?.id ? ' me' : ''}` },
      h('div', { class: 'who' }, m.nickname), h('div', {}, m.body)));
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function load() {
    try {
      ({ commute: c } = await api('GET', `/commutes/${id}`));
      render();
      if (c.joined) await startChat();
    } catch (err) {
      root.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }

  async function startChat() {
    if (!state.socket) return;
    if (!subscribed) {
      const res = await emit('commute:subscribe', c.id);
      subscribed = res.ok;
    }
    if (!chatLoaded) {
      chatLoaded = true;
      const { messages } = await api('GET', `/commutes/${c.id}/messages`);
      chatLog.replaceChildren();
      messages.forEach(appendMessage);
    }
  }

  async function act(fn, okMessage) {
    try {
      await fn();
      if (okMessage) toast(okMessage);
      await load();
    } catch (err) {
      toast(err.message);
    }
  }

  async function share() {
    const url = `${location.origin}/c/${c.id}`;
    const text = `🚕 ${c.origin.area} → ${c.destination.area} ${c.daysLabel} ${c.departTime} 택시 같이 타요 (1인 약 ${won(c.fare.perPerson)})`;
    try {
      if (navigator.share) await navigator.share({ title: 'MEET 출퇴근 택시', text, url });
      else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast('링크를 복사했어요. 카톡·커뮤니티에 붙여넣어 주세요.');
      }
    } catch { /* 공유 취소 */ }
  }

  function joinCard() {
    if (c.joined) return null;
    if (c.status !== 'open') return h('div', { class: 'card step' }, '모집을 마친 노선이에요.');
    if (!c.seatsLeft) return h('div', { class: 'card step' }, '자리가 모두 찼어요. 비슷한 노선을 새로 올려 보세요.');
    return h('div', { class: 'card stack' },
      h('button', {
        class: 'wide',
        onclick: () => {
          if (!requireLogin()) return;
          if (!canUseRides()) { location.hash = '#/verify'; return; }
          act(() => api('POST', `/commutes/${c.id}/join`), '🎉 참여했어요! 크루 채팅으로 인사해 보세요.');
        },
      }, state.user ? '🙋 이 노선 같이 타기' : '🙋 로그인하고 같이 타기'),
      h('p', { class: 'muted' }, '참여하면 정확한 출발 위치·만남 장소와 크루 채팅이 열려요. 운행하는 날마다 출발 1시간 전에 합승방이 자동으로 열려요.'));
  }

  function todayCard() {
    if (!c.joined) return null;
    if (c.currentRide) {
      return h('a', { class: 'card banner', href: `#/rides/${c.currentRide.rideId}` },
        h('strong', {}, `🚕 ${relativeTime(c.currentRide.departAt)} 출발하는 합승방이 열렸어요`),
        h('div', {}, '눌러서 만남 장소 확인·도착 체크인을 해 주세요.'));
    }
    return h('p', { class: 'muted' }, '🕐 운행하는 날마다 출발 1시간 전에 합승방이 자동으로 열리고 알림이 가요.');
  }

  function membersCard() {
    return h('div', { class: 'card' },
      h('h2', {}, `👥 멤버 ${c.memberCount}/${c.maxSeats}`),
      h('ul', { class: 'members' }, (c.members ?? []).map((m) => h('li', { class: 'member-row' },
        h('strong', {}, m.isOwner ? '👑 ' : '', m.nickname), trustChips(m),
        c.isOwner && !m.isOwner && h('button', {
          class: 'link',
          onclick: () => confirm(`${m.nickname}님을 노선에서 내보낼까요?`) && act(() => api('DELETE', `/commutes/${c.id}/members/${m.id}`)),
        }, '내보내기')))));
  }

  function chatCard() {
    if (!c.joined) return null;
    const input = h('input', { placeholder: '크루에게 메시지 (예: 내일 5분 늦어요)', maxlength: 500, autocomplete: 'off' });
    const form = h('form', { class: 'row' }, input, h('button', { class: 'fit' }, '전송'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        await api('POST', `/commutes/${c.id}/messages`, { body: input.value });
        input.value = '';
      } catch (err) {
        toast(err.message);
      }
    });
    return h('div', { class: 'card' }, h('h2', {}, '💬 크루 채팅'), h('div', { class: 'chat' }, chatLog, form));
  }

  function ownerCard() {
    if (!c.isOwner) return null;
    return h('div', { class: 'card stack' },
      h('h2', {}, '⚙️ 노선 관리'),
      h('div', { class: 'row' },
        h('button', { class: 'secondary', onclick: editSchedule }, '요일·시각 바꾸기'),
        h('button', {
          class: 'secondary',
          onclick: () => act(() => api('PATCH', `/commutes/${c.id}`, { status: c.status === 'open' ? 'closed' : 'open' }),
            c.status === 'open' ? '모집을 마감했어요.' : '다시 모집해요.'),
        }, c.status === 'open' ? '모집 마감' : '다시 모집')));
  }

  function editSchedule() {
    const picked = new Set(c.days);
    const row = h('div', { class: 'day-toggles' });
    const draw = () => row.replaceChildren(...DAYS.map(([key, name]) => h('button', {
      type: 'button', class: picked.has(key) ? 'day on' : 'day',
      onclick: () => { picked.has(key) ? picked.delete(key) : picked.add(key); draw(); },
    }, name)));
    draw();
    const time = h('input', { type: 'time', value: c.departTime, class: 'time-input' });
    sheet('요일·시각 바꾸기', h('div', { class: 'stack' }, row, time), [
      { label: '취소', class: 'secondary', onClick: (close) => close() },
      {
        label: '저장',
        onClick: (close) => {
          close();
          act(() => api('PATCH', `/commutes/${c.id}`, { days: DAYS.map(([k]) => k).filter((k) => picked.has(k)), departTime: time.value }), '멤버들에게 바뀐 일정을 알렸어요.');
        },
      },
    ]);
  }

  function render() {
    root.replaceChildren(h('div', {},
      h('div', { class: 'card commute-head' },
        h('div', { class: 'commute-time big' }, h('strong', {}, c.departTime), h('span', {}, `${c.daysLabel} · 매주`)),
        h('div', { class: 'route' }, c.origin.area, h('span', { class: 'arrow' }, '→'), c.destination.area),
        c.origin.code && h('a', { class: 'muted small-link', href: `#/r/${c.origin.code}/${c.destination.code}` }, '이 노선의 다른 시간대 크루 보기 →'),
        c.joined && h('div', {}, h('strong', {}, '만남 장소: '), c.meetingPoint),
        h('div', { class: 'chips' },
          h('span', { class: `chip${c.seatsLeft ? ' hl' : ''}` }, c.seatsLeft ? `${c.seatsLeft}자리 남음` : '마감'),
          h('span', { class: 'chip' }, `약 ${formatKm(c.distanceKm)}`),
          c.genderPref !== 'any' && h('span', { class: 'chip' }, GENDER_ONLY[c.genderPref])),
        c.memo && h('p', {}, c.memo),
        h('div', { class: 'host-line muted' }, `만든 사람 ${c.owner.nickname}`, trustChips(c.owner))),
      h('div', { class: 'card fare-card' },
        h('div', { class: 'fare' },
          h('div', {}, h('span', { class: 'muted' }, '혼자 타면'), h('strong', {}, won(c.fare.total))),
          h('div', {}, h('span', { class: 'muted' }, `${c.maxSeats}명이 타면 1인`), h('strong', { class: 'hl-text' }, won(c.fare.perPerson))),
          h('div', {}, h('span', { class: 'muted' }, '한 달(20일)이면'), h('strong', {}, `${won((c.fare.total - c.fare.perPerson) * 20)} 절약`))),
        h('p', { class: 'muted small' }, '* 거리로 계산한 예상 요금이에요. 실제 요금은 택시 미터기 기준으로 나눠요.')),
      joinCard(),
      todayCard(),
      chatCard(),
      membersCard(),
      ownerCard(),
      h('div', { class: 'row' },
        h('button', { class: 'secondary', onclick: share }, '🔗 노선 공유하기'),
        c.joined && h('button', {
          class: 'secondary',
          onclick: () => confirm('이 노선에서 나갈까요?') && act(() => api('POST', `/commutes/${c.id}/leave`), '노선에서 나왔어요.'),
        }, '나가기'))));
  }

  const onMessage = (m) => { if (m.commuteId === Number(id)) appendMessage(m); };
  const onUpdated = ({ id: changed }) => { if (changed === Number(id)) load(); };
  state.socket?.on('commute:message', onMessage);
  state.socket?.on('commute:updated', onUpdated);
  onLeave(() => {
    state.socket?.off('commute:message', onMessage);
    state.socket?.off('commute:updated', onUpdated);
    if (subscribed) state.socket?.emit('commute:unsubscribe', Number(id));
  });
  load();
  return root;
}
