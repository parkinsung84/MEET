// 앱 전역 상태, API 호출, 실시간 연결

export const state = {
  token: localStorage.getItem('meet.token'),
  user: null,
  socket: null,
  config: { naverMapKeyId: null, vapidPublicKey: null },
  cleanup: null, // 현재 화면을 떠날 때 실행할 정리 함수
  mapsReady: Promise.resolve(null), // 네이버 지도 SDK 로드 완료 (실패 시 null)
};

export const STATUS_LABEL = { open: '모집 중', departed: '이동 중', completed: '완료', cancelled: '취소됨' };
export const GENDER_LABEL = { any: '성별 무관', male: '남성만', female: '여성만' };

export const won = (n) => `${Number(n).toLocaleString('ko-KR')}원`;
export const formatTime = (iso) =>
  new Date(iso).toLocaleString('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
export const minutesUntil = (iso) => Math.round((new Date(iso).getTime() - Date.now()) / 60000);

/** "12분 후", "1시간 5분 후", "3분 전" */
export function relativeTime(iso) {
  const m = minutesUntil(iso);
  const abs = Math.abs(m);
  const text = abs < 60 ? `${abs}분` : `${Math.floor(abs / 60)}시간${abs % 60 ? ` ${abs % 60}분` : ''}`;
  if (abs === 0) return '지금';
  return m > 0 ? `${text} 후` : `${text} 전`;
}

export async function api(method, path, body) {
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

export function setSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('meet.token', token);
  connectSocket();
}

export async function refreshMe() {
  ({ user: state.user } = await api('GET', '/auth/me'));
  return state.user;
}

export function logout() {
  state.token = null;
  state.user = null;
  localStorage.removeItem('meet.token');
  state.socket?.disconnect();
  state.socket = null;
  window.dispatchEvent(new Event('session:ended'));
}

export function connectSocket() {
  state.socket?.disconnect();
  state.socket = window.io({ auth: { token: state.token } });
  state.socket.on('rides:changed', () => window.dispatchEvent(new Event('rides:changed')));
  state.socket.on('notification', (n) => window.dispatchEvent(new CustomEvent('notification', { detail: n })));
  window.dispatchEvent(new CustomEvent('socket:ready', { detail: state.socket }));
}

export const emit = (event, payload) => new Promise((resolve) => state.socket.emit(event, payload, resolve));

/** 현재 화면을 떠날 때 정리할 작업을 등록 (여러 개 가능) */
export function onLeave(fn) {
  const prev = state.cleanup;
  state.cleanup = () => {
    prev?.();
    fn();
  };
}

/** 창 이벤트 구독 + 화면 떠날 때 자동 해제 */
export function listen(target, event, handler) {
  target.addEventListener(event, handler);
  onLeave(() => target.removeEventListener(event, handler));
}
