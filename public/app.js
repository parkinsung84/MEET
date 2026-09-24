import { findPlace, PLACES } from './places.js';

const STATUS_LABEL = { open: '모집 중', departed: '이동 중', completed: '완료', cancelled: '취소됨' };
const GENDER_LABEL = { any: '성별 무관', male: '남성만', female: '여성만' };

const state = {
  token: localStorage.getItem('meet.token'),
  user: null,
  socket: null,
  cleanup: null, // 현재 화면을 떠날 때 실행할 정리 함수
};

// ---------- helpers ----------

/** 작은 DOM 빌더. 문자열 자식은 textContent 로 들어가므로 XSS 걱정이 없다. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

const won = (n) => `${n.toLocaleString('ko-KR')}원`;
const formatTime = (iso) =>
  new Date(iso).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(state.token && { authorization: `Bearer ${state.token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && state.token) {
    logout();
    throw new Error('다시 로그인해 주세요.');
  }
  if (!res.ok) throw new Error(data.error || '요청에 실패했습니다.');
  return data;
}

function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('meet.token', token);
  connectSocket();
}

function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('meet.token');
  state.socket?.disconnect();
  state.socket = null;
  if (location.hash === '#/login') route();
  else location.hash = '#/login';
}

function connectSocket() {
  state.socket?.disconnect();
  state.socket = window.io({ auth: { token: state.token } });
  state.socket.on('rides:changed', () => window.dispatchEvent(new Event('rides:changed')));
}

const emit = (event, payload) => new Promise((resolve) => state.socket.emit(event, payload, resolve));

/** 장소 입력: 목록에서 고르거나(datalist) 현재 위치를 사용한다. */
function placeInput(name, label, { allowCurrent = false } = {}) {
  const input = h('input', { name, list: 'places', placeholder: '예: 서울역', autocomplete: 'off' });
  let current = null;
  input.addEventListener('input', () => { current = null; });
  const useCurrent = allowCurrent && 'geolocation' in navigator && h('button', {
    type: 'button',
    class: 'secondary small fit',
    onclick: () => navigator.geolocation.getCurrentPosition(
      (pos) => {
        current = { name: '현재 위치', lat: pos.coords.latitude, lng: pos.coords.longitude };
        input.value = current.name;
      },
      () => toast('위치 정보를 가져올 수 없습니다.'),
    ),
  }, '📍 현재 위치');
  return {
    el: h('label', {}, label, useCurrent ? h('div', { class: 'row' }, input, useCurrent) : input),
    /** 입력값을 {name, lat, lng}로 변환. 비어 있으면 null, 모르는 장소면 에러. */
    value() {
      if (current && input.value === current.name) return current;
      if (!input.value.trim()) return null;
      const place = findPlace(input.value);
      if (!place) throw new Error(`'${input.value}'은(는) 목록에 없는 장소입니다.`);
      return place;
    },
  };
}

function placesDatalist() {
  return h('datalist', { id: 'places' }, PLACES.map((p) => h('option', { value: p.name })));
}

function rideCard(ride) {
  const seatsLeft = ride.maxSeats - ride.memberCount;
  return h('a', { class: 'card ride-card', href: `#/rides/${ride.id}` },
    h('div', { class: 'route' }, ride.origin.name, h('span', { class: 'arrow' }, '→'), ride.destination.name),
    h('div', { class: 'muted' }, `${formatTime(ride.departAt)} 출발 · 약 ${ride.fare.distanceKm}km`),
    h('div', { class: 'chips' },
      h('span', { class: 'chip hl' }, `1인 ${won(ride.fare.perPersonFull)}~`),
      h('span', { class: 'chip' }, ride.status === 'open' ? `${ride.memberCount}/${ride.maxSeats}명 · ${seatsLeft}자리 남음` : STATUS_LABEL[ride.status]),
      ride.genderPref !== 'any' && h('span', { class: 'chip' }, GENDER_LABEL[ride.genderPref]),
      ride.matchDistanceKm > 0 && h('span', { class: 'chip' }, `경로 차이 ${ride.matchDistanceKm}km`),
    ),
  );
}

// ---------- screens ----------

function authScreen() {
  let mode = 'login';
  const root = h('div');

  function render() {
    const form = h('form', { class: 'card stack' },
      h('input', { name: 'email', type: 'email', placeholder: '이메일', required: true, autocomplete: 'email' }),
      h('input', { name: 'password', type: 'password', placeholder: '비밀번호 (8자 이상)', required: true, minlength: 8 }),
      mode === 'register' && [
        h('input', { name: 'nickname', placeholder: '닉네임', required: true, maxlength: 20 }),
        h('select', { name: 'gender', required: true },
          h('option', { value: '' }, '성별 선택'),
          h('option', { value: 'male' }, '남성'),
          h('option', { value: 'female' }, '여성')),
        h('p', { class: 'muted' }, '성별은 동성 합승 매칭에만 사용됩니다.'),
      ],
      h('button', {}, mode === 'login' ? '로그인' : '가입하기'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        const { token, user } = await api('POST', `/auth/${mode}`, data);
        setSession(token, user);
        location.hash = '#/';
      } catch (err) {
        toast(err.message);
      }
    });
    root.replaceChildren(
      h('h1', {}, '같은 방향, 택시비는 N분의 1'),
      h('div', { class: 'tabs' },
        h('button', { class: mode === 'login' ? '' : 'secondary', onclick: () => { mode = 'login'; render(); } }, '로그인'),
        h('button', { class: mode === 'register' ? '' : 'secondary', onclick: () => { mode = 'register'; render(); } }, '회원가입')),
      form,
    );
  }
  render();
  return root;
}

function homeScreen() {
  const origin = placeInput('origin', '출발지', { allowCurrent: true });
  const dest = placeInput('dest', '도착지');
  const list = h('div');
  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('div', { class: 'row' },
      h('label', {}, '검색 반경',
        h('select', { name: 'radius' },
          [1, 2, 3, 5].map((km) => h('option', { value: km, selected: km === 2 }, `${km}km`)))),
      h('button', { style: 'align-self:end' }, '🔍 합승 찾기')),
  );

  async function load({ silent = false } = {}) {
    try {
      const params = new URLSearchParams({ radiusKm: form.radius.value });
      const o = origin.value();
      const d = dest.value();
      if (o) params.set('originLat', o.lat), params.set('originLng', o.lng);
      if (d) params.set('destLat', d.lat), params.set('destLng', d.lng);
      const { rides } = await api('GET', `/rides?${params}`);
      list.replaceChildren(
        h('h2', {}, `모집 중인 합승 ${rides.length}건`),
        ...(rides.length ? rides.map(rideCard) : [h('div', { class: 'empty' }, '조건에 맞는 합승이 없어요.', h('br'), '직접 합승방을 만들어 보세요!')]),
      );
    } catch (err) {
      if (!silent) toast(err.message);
    }
  }

  // 다른 사용자가 방을 만들거나 참여하면 목록을 조용히 새로고침
  const refresh = () => load({ silent: true });
  form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
  window.addEventListener('rides:changed', refresh);
  state.cleanup = () => window.removeEventListener('rides:changed', refresh);
  load();

  return h('div', {},
    placesDatalist(),
    form,
    list,
    h('a', { class: 'btn fab', href: '#/new' }, '+ 합승방 만들기'),
  );
}

function newRideScreen() {
  const origin = placeInput('origin', '출발지', { allowCurrent: true });
  const dest = placeInput('dest', '도착지');
  const defaultTime = new Date(Date.now() + 30 * 60_000);
  defaultTime.setMinutes(defaultTime.getMinutes() - defaultTime.getTimezoneOffset());
  const preview = h('p', { class: 'muted' });

  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('label', {}, '출발 시간', h('input', { name: 'departAt', type: 'datetime-local', required: true, value: defaultTime.toISOString().slice(0, 16) })),
    h('div', { class: 'row' },
      h('label', {}, '정원 (본인 포함)',
        h('select', { name: 'maxSeats' }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === 4 }, `${n}명`)))),
      h('label', {}, '성별 조건',
        h('select', { name: 'genderPref' },
          h('option', { value: 'any' }, '성별 무관'),
          h('option', { value: state.user.gender }, `${state.user.gender === 'male' ? '남성' : '여성'}만`)))),
    h('label', {}, '메모 (선택)', h('textarea', { name: 'memo', rows: 2, maxlength: 200, placeholder: '예: 2번 출구 앞 택시승강장에서 만나요' })),
    preview,
    h('button', {}, '합승방 만들기'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const o = origin.value();
      const d = dest.value();
      if (!o || !d) throw new Error('출발지와 도착지를 입력해 주세요.');
      const { ride } = await api('POST', '/rides', {
        origin: o,
        destination: d,
        departAt: new Date(form.departAt.value).toISOString(),
        maxSeats: Number(form.maxSeats.value),
        genderPref: form.genderPref.value,
        memo: form.memo.value,
      });
      toast('합승방이 만들어졌어요!');
      location.hash = `#/rides/${ride.id}`;
    } catch (err) {
      toast(err.message);
    }
  });

  return h('div', {}, placesDatalist(), h('h1', {}, '합승방 만들기'), form);
}

function rideScreen(rideId) {
  const root = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  const chatLog = h('div', { class: 'chat-log' });
  let ride = null;
  let subscribed = false;

  const isMember = () => ride?.members.some((m) => m.id === state.user.id);
  const isHost = () => ride?.hostId === state.user.id;

  function appendMessage(msg) {
    const mine = msg.userId === state.user.id;
    chatLog.append(h('div', { class: `msg${mine ? ' me' : ''}` },
      !mine && h('div', { class: 'who' }, msg.nickname),
      msg.body));
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  async function action(fn, successMessage) {
    try {
      ({ ride } = await fn());
      if (successMessage) toast(successMessage);
      await render();
    } catch (err) {
      toast(err.message);
    }
  }

  async function subscribeChat() {
    if (subscribed || !isMember()) return;
    const res = await emit('ride:subscribe', ride.id);
    if (!res.ok) return toast(res.error);
    subscribed = true;
    const { messages } = await api('GET', `/rides/${ride.id}/messages`);
    chatLog.replaceChildren();
    messages.forEach(appendMessage);
  }

  function chatPanel() {
    const input = h('input', { placeholder: '메시지 입력', maxlength: 500, autocomplete: 'off' });
    const form = h('form', { class: 'row' }, input, h('button', { class: 'fit' }, '전송'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      const res = await emit('chat:send', { rideId: ride.id, body: input.value });
      if (!res.ok) return toast(res.error);
      input.value = '';
    });
    return h('div', { class: 'card' }, h('h2', {}, '💬 합승 채팅'), h('div', { class: 'chat' }, chatLog, form));
  }

  function actions() {
    const buttons = [];
    if (ride.status === 'open' && !isMember()) {
      const full = ride.memberCount >= ride.maxSeats;
      buttons.push(h('button', { disabled: full, onclick: () => action(() => api('POST', `/rides/${ride.id}/join`), '합승에 참여했어요!') },
        full ? '정원 마감' : '합승 참여하기'));
    }
    if (ride.status === 'open' && isMember()) {
      buttons.push(h('button', { class: 'secondary', onclick: () => confirm('합승방에서 나갈까요?') && action(() => api('POST', `/rides/${ride.id}/leave`), '합승방에서 나왔어요.') }, '나가기'));
    }
    const setStatus = (status, label) => h('button', {
      onclick: () => confirm(`${label} 처리할까요?`) && action(() => api('PATCH', `/rides/${ride.id}/status`, { status })),
    }, label);
    if (isHost() && ride.status === 'open') buttons.push(setStatus('departed', '🚕 출발'));
    if (isHost() && ride.status === 'departed') buttons.push(setStatus('completed', '✅ 도착 완료'));
    return buttons.length ? h('div', { class: 'row' }, buttons) : null;
  }

  async function render() {
    // h()가 null/false 자식을 걸러주므로 한 번 감싸서 넣는다
    root.replaceChildren(h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'route' }, ride.origin.name, h('span', { class: 'arrow' }, '→'), ride.destination.name),
        h('div', { class: 'muted' }, `${formatTime(ride.departAt)} 출발 · ${STATUS_LABEL[ride.status]}`),
        h('div', { class: 'chips' },
          h('span', { class: 'chip' }, `${ride.memberCount}/${ride.maxSeats}명`),
          h('span', { class: 'chip' }, GENDER_LABEL[ride.genderPref])),
        ride.memo && h('p', {}, ride.memo)),
      h('div', { class: 'card' },
        h('h2', {}, '💰 예상 요금'),
        h('div', { class: 'fare' },
          h('div', {}, h('span', { class: 'muted' }, '전체'), h('strong', {}, won(ride.fare.total))),
          h('div', {}, h('span', { class: 'muted' }, `지금 (${ride.memberCount}명)`), h('strong', {}, won(ride.fare.perPersonNow))),
          h('div', {}, h('span', { class: 'muted' }, `만석 (${ride.maxSeats}명)`), h('strong', {}, won(ride.fare.perPersonFull)))),
        h('p', { class: 'muted' }, `약 ${ride.fare.distanceKm}km 기준 서울 중형택시 추정 요금이며, 실제 요금과 다를 수 있어요.`)),
      h('div', { class: 'card' },
        h('h2', {}, '👥 탑승자'),
        h('ul', { class: 'members' }, ride.members.map((m) => h('li', {},
          m.nickname,
          m.id === ride.hostId && h('span', { class: 'chip hl', style: 'margin-left:6px' }, '방장'),
          m.id === state.user.id && h('span', { class: 'muted' }, ' (나)'))))),
      actions(),
      isMember() && chatPanel(),
    ));
    await subscribeChat();
  }

  const onUpdated = (updated) => {
    if (updated.id !== ride?.id) return;
    ride = updated;
    render();
  };
  const onMessage = (msg) => msg.rideId === ride?.id && appendMessage(msg);
  state.socket.on('ride:updated', onUpdated);
  state.socket.on('chat:message', onMessage);
  state.cleanup = () => {
    state.socket?.off('ride:updated', onUpdated);
    state.socket?.off('chat:message', onMessage);
    if (subscribed) state.socket?.emit('ride:unsubscribe', ride.id);
  };

  api('GET', `/rides/${rideId}`)
    .then((data) => { ride = data.ride; return render(); })
    .catch((err) => root.replaceChildren(h('div', { class: 'empty' }, err.message)));
  return root;
}

function myRidesScreen() {
  const root = h('div', {}, h('h1', {}, '내 합승'));
  api('GET', '/rides/mine')
    .then(({ rides }) => root.append(...(rides.length ? rides.map(rideCard) : [h('div', { class: 'empty' }, '참여한 합승이 없어요.')])))
    .catch((err) => toast(err.message));
  return root;
}

// ---------- router ----------

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...(state.user
    ? [h('a', { href: '#/mine' }, '내 합승'), h('button', { onclick: logout }, '로그아웃')]
    : []));
}

function route() {
  state.cleanup?.();
  state.cleanup = null;
  const path = location.hash.slice(1) || '/';
  if (!state.user && path !== '/login') {
    location.hash = '#/login';
    return;
  }
  let screen;
  let match;
  if (path === '/login') screen = authScreen();
  else if (path === '/new') screen = newRideScreen();
  else if (path === '/mine') screen = myRidesScreen();
  else if ((match = path.match(/^\/rides\/(\d+)$/))) screen = rideScreen(Number(match[1]));
  else screen = homeScreen();
  renderNav();
  document.getElementById('app').replaceChildren(screen);
  window.scrollTo(0, 0);
}

async function boot() {
  if (state.token) {
    try {
      ({ user: state.user } = await api('GET', '/auth/me'));
      connectSocket();
    } catch {
      state.token = null;
      localStorage.removeItem('meet.token');
    }
  }
  window.addEventListener('hashchange', route);
  route();
}

boot();
