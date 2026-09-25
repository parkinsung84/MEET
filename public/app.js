import { hangup, initCalls } from './call.js';
import { api, connectSocket, state } from './core.js';
import { handleIdentityReturn } from './identity.js';
import { loadNaverMaps } from './maps.js';
import { registerServiceWorker, syncPush } from './push.js';
import { myRidesScreen, notificationsScreen, profileScreen } from './screens/account.js';
import { authScreen, consentScreen, forgotScreen, verifyScreen } from './screens/auth.js';
import { homeScreen } from './screens/home.js';
import { newRideScreen } from './screens/new-ride.js';
import { rideScreen } from './screens/ride.js';
import { h, toast } from './ui.js';

let unread = 0;

function renderNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...(state.user
    ? [
      h('a', { href: '#/mine' }, '내 합승'),
      h('a', { href: '#/notifications', class: 'bell', 'aria-label': `알림 ${unread}개` }, '🔔', unread > 0 && h('span', { class: 'badge' }, unread > 99 ? '99+' : unread)),
      h('a', { href: '#/me', 'aria-label': '내 정보' }, '👤'),
    ]
    : []));
}

async function refreshUnread() {
  try {
    ({ unread } = await api('GET', '/notifications'));
  } catch { /* 무시 */ }
  renderNav();
}

// 인증이 필요 없는 화면
const PUBLIC = new Set(['/login', '/forgot']);
// 이메일 인증 전에도 볼 수 있는 화면 (둘러보기는 가능, 만들기/참여는 서버에서 막음)
const SCREENS = [
  [/^\/login$/, authScreen],
  [/^\/forgot$/, forgotScreen],
  [/^\/consent$/, consentScreen],
  [/^\/verify$/, verifyScreen],
  [/^\/new$/, newRideScreen],
  [/^\/mine$/, myRidesScreen],
  [/^\/notifications$/, notificationsScreen],
  [/^\/me$/, profileScreen],
  [/^\/rides\/(\d+)$/, (id) => rideScreen(Number(id))],
];

function route() {
  state.cleanup?.();
  state.cleanup = null;
  // 열려 있던 시트(모달)는 화면을 옮기면 닫는다 (통화 화면은 유지)
  document.querySelectorAll('.sheet-backdrop').forEach((el) => el.remove());
  const path = location.hash.slice(1) || '/';
  if (!state.user && !PUBLIC.has(path)) {
    location.hash = '#/login';
    return;
  }
  if (state.user && PUBLIC.has(path)) {
    location.hash = '#/';
    return;
  }
  // 약관이 바뀌었으면 다시 동의부터
  if (state.user?.consentsRequired?.length && path !== '/consent') {
    location.hash = '#/consent';
    return;
  }
  let screen = null;
  for (const [pattern, make] of SCREENS) {
    const match = path.match(pattern);
    if (match) {
      screen = make(...match.slice(1));
      break;
    }
  }
  renderNav();
  document.getElementById('app').replaceChildren(screen ?? homeScreen());
  window.scrollTo(0, 0);
}

/** 앱을 보고 있을 때 온 알림은 화면 상단 토스트로 보여준다 */
window.addEventListener('notification', (e) => {
  const n = e.detail;
  unread += n.id ? 1 : 0;
  renderNav();
  // 지금 보고 있는 합승방의 채팅은 이미 화면에 보이므로 생략
  if (n.type === 'chat' && location.hash === `#/rides/${n.rideId}`) return;
  toast(`${n.title} · ${n.body}`);
});
window.addEventListener('notifications:read', () => { unread = 0; renderNav(); });
// 음성 통화는 어느 화면에서든 받을 수 있도록 소켓 연결 때마다 등록
window.addEventListener('socket:ready', (e) => initCalls(e.detail));
window.addEventListener('session:ended', () => {
  hangup();
  if (location.hash === '#/login') route();
  else location.hash = '#/login';
});

async function boot() {
  registerServiceWorker();
  const config = await api('GET', '/config').catch(() => ({}));
  state.config = { ...state.config, ...config };
  // 지도 SDK는 백그라운드로 로드 (실패해도 앱은 동작)
  state.mapsReady = loadNaverMaps(config.naverMapKeyId).catch(() => null);
  if (state.token) {
    try {
      ({ user: state.user } = await api('GET', '/auth/me'));
      connectSocket();
      refreshUnread();
      syncPush();
    } catch {
      state.token = null;
      localStorage.removeItem('meet.token');
    }
  }
  // 모바일 본인확인에서 돌아온 경우 결과 처리
  await handleIdentityReturn();
  window.addEventListener('hashchange', route);
  // 로그인/가입 직후 소켓 연결 등 세션 변경 반영
  window.addEventListener('hashchange', () => { if (state.user && !state.socket) connectSocket(); });
  route();
}

boot();
