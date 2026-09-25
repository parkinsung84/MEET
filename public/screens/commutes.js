import { formatKm, placePicker, trustChips } from '../components.js';
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

/** 'YYYY-MM-DD'(한국 날짜) → '9/28(월)' — 기기 시간대와 무관하게 */
const dateLabel = (date) => {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${'일월화수목금토'[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
};

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

// ---------------------------------------------------------------- 첫 화면: 노선 찾기

export function commuteHomeScreen() {
  const list = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  const filter = h('input', { type: 'search', placeholder: '🔍 동네 이름으로 찾기 (예: 분당, 강남)', 'aria-label': '동네 이름으로 찾기' });
  let all = [];
  let sortNear = null;

  function render() {
    const words = filter.value.trim().split(/\s+/).filter(Boolean);
    const shown = all.filter((c) => words.every((w) => `${c.origin.area} ${c.destination.area} ${c.memo}`.includes(w)));
    list.replaceChildren(...(shown.length
      ? [h('p', { class: 'muted list-count' }, words.length ? `${shown.length}개 노선` : `올라온 노선 전체 ${shown.length}개`), ...shown.map(commuteCard)]
      : [h('div', { class: 'empty stack' },
        h('div', {}, all.length ? '찾는 노선이 없어요.' : '아직 올라온 노선이 없어요.'),
        h('div', {}, '내 출퇴근 노선을 먼저 올려 두면, 같은 길을 가는 사람들이 보고 들어와요.'),
        h('a', { class: 'btn', href: '#/commutes/new' }, '＋ 내 노선 올리기'))]));
  }

  async function load() {
    // 항상 전체 노선. '가까운 순'을 켜면 거르지 않고 출발지가 가까운 순서로만 정렬
    const params = new URLSearchParams(sortNear ? { nearLat: sortNear.lat, nearLng: sortNear.lng } : {});
    try {
      ({ commutes: all } = await api('GET', `/commutes?${params}`));
      render();
    } catch (err) {
      list.replaceChildren(h('div', { class: 'empty' }, err.message));
    }
  }

  const nearBtn = h('button', {
    type: 'button',
    class: 'secondary small',
    onclick: async () => {
      if (sortNear) {
        sortNear = null;
        nearBtn.textContent = '📍 가까운 순';
        nearBtn.classList.add('secondary');
        return load();
      }
      const here = await locate();
      if (!here) return toast('위치를 가져올 수 없어요. 브라우저의 위치 권한을 확인해 주세요.');
      sortNear = here;
      nearBtn.textContent = '📍 가까운 순 ✓';
      nearBtn.classList.remove('secondary');
      load();
    },
  }, '📍 가까운 순');

  filter.addEventListener('input', render);
  listen(window, 'commutes:changed', () => load());
  load();

  return h('div', {},
    h('section', { class: 'hero' },
      h('h1', {}, '출퇴근 택시, 같이 타면 ', h('span', { class: 'hl-text' }, '반값')),
      h('p', {}, '매일 같은 시간, 같은 길로 택시 타는 사람들이 모여요. 내 노선을 올리거나, 올라온 노선에 참여하세요.'),
      h('div', { class: 'row hero-actions' },
        h('a', { class: 'btn', href: '#/commutes/new' }, '＋ 내 출퇴근 노선 올리기'))),
    h('div', { class: 'row list-tools' }, filter, nearBtn),
    list,
    h('p', { class: 'muted center' },
      '오늘 한 번만 같이 탈 사람을 찾나요? ', h('a', { href: '#/rides' }, '당일 합승 찾기 →')));
}

// ---------------------------------------------------------------- 노선 올리기

export function newCommuteScreen() {
  if (!requireLogin()) return h('div');
  const origin = placePicker('출발지', { allowCurrent: true });
  const dest = placePicker('도착지');
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

  const myGender = state.user.gender === 'male' ? '남성' : '여성';
  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '타는 요일'), dayRow, presets),
    h('label', {}, '출발 시각', h('input', { name: 'departTime', type: 'time', value: '08:00', required: true, class: 'time-input' })),
    h('label', {}, '만남 장소 (멤버에게만 보여요)',
      h('input', { name: 'meetingPoint', maxlength: 100, placeholder: '예: 정자역 3번 출구 앞' })),
    h('div', { class: 'row' },
      h('label', {}, '정원 (본인 포함)',
        h('select', { name: 'maxSeats' }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === 4 }, `${n}명`)))),
      h('label', {}, '모집 성별',
        h('select', { name: 'genderPref' },
          h('option', { value: 'any' }, '성별 무관'),
          h('option', { value: state.user.gender }, `${myGender}만`)))),
    h('label', {}, '한마디 (누구나 볼 수 있어요)',
      h('textarea', { name: 'memo', rows: 2, maxlength: 300, placeholder: '예: 판교 IT회사 다녀요. 늦으면 5분까지 기다려요!' })),
    h('p', { class: 'muted' }, '🔒 목록에는 "분당구 정자동 → 강남구 역삼동"처럼 대략적인 동네만 보여요. 정확한 위치와 만남 장소는 참여한 멤버에게만 보여요.'),
    h('button', {}, '노선 올리기'));

  /** 비슷한 노선이 있으면 먼저 보여준다 → 새로 만들면 true */
  async function confirmNoSimilar(o, d, time, days) {
    const params = new URLSearchParams({ originLat: o.lat, originLng: o.lng, destLat: d.lat, destLng: d.lng, time, days: days.join(',') });
    const { commutes } = await api('GET', `/commutes?${params}`).catch(() => ({ commutes: [] }));
    const open = commutes.filter((c) => !c.joined && c.seatsLeft > 0);
    if (!open.length) return true;
    return new Promise((resolve) => {
      sheet('🙌 비슷한 노선이 이미 있어요', h('div', { class: 'stack' },
        h('p', {}, '이미 있는 노선에 참여하면 바로 같이 탈 수 있어요.'),
        open.slice(0, 3).map((c) => {
          const card = commuteCard(c);
          card.addEventListener('click', () => resolve(false));
          return card;
        })), [
        { label: '그래도 새로 올리기', class: 'secondary', onClick: (close) => { close(); resolve(true); } },
      ]);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const o = origin.value();
      const d = dest.value();
      if (!o || !d) throw new Error('출발지와 도착지를 지도에서 찍어 주세요.');
      const days = DAYS.map(([k]) => k).filter((k) => picked.has(k));
      if (!days.length) throw new Error('타는 요일을 골라 주세요.');
      const departTime = form.departTime.value;
      if (!await confirmNoSimilar(o, d, departTime, days)) return;
      const { commute } = await api('POST', '/commutes', {
        origin: o, destination: d, days, departTime,
        maxSeats: Number(form.maxSeats.value), genderPref: form.genderPref.value,
        meetingPoint: form.meetingPoint.value, memo: form.memo.value,
      });
      toast('노선을 올렸어요! 링크를 공유해서 같이 탈 사람을 모아 보세요.');
      location.hash = `#/c/${commute.id}`;
    } catch (err) {
      toast(err.message);
    }
  });

  return h('div', {},
    h('h1', {}, '내 출퇴근 노선 올리기'),
    h('p', { class: 'muted' }, '매일 타는 길과 시간을 올려 두면 같은 길을 가는 사람들이 보고 참여해요.'),
    form);
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
        c.joined && h('div', { class: 'muted' }, `📍 ${c.origin.name} → ${c.destination.name}`),
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
