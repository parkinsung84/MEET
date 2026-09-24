import { api, state } from './core.js';

// Web Push: 서비스워커 등록 + 푸시 구독. iOS 는 홈 화면에 추가한 앱(PWA)에서만 지원된다.

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let registration = null;
export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('[sw]', err);
  }
  return registration;
}

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** 'on' | 'off' | 'denied' | 'unsupported' */
export async function pushStatus() {
  if (!pushSupported() || !state.config.vapidPublicKey) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = registration ?? await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('이 브라우저는 알림을 지원하지 않아요. (아이폰은 홈 화면에 추가 후 사용)');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('알림 권한이 허용되지 않았어요. 브라우저 설정에서 허용해 주세요.');
  const reg = registration ?? await registerServiceWorker();
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(state.config.vapidPublicKey),
  });
  await api('POST', '/notifications/push', { subscription: subscription.toJSON() });
}

export async function disablePush() {
  const reg = registration ?? await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await api('DELETE', '/notifications/push', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** 로그인 상태에서 이미 권한이 있으면 조용히 구독을 갱신 (다른 계정으로 로그인한 경우 등) */
export async function syncPush() {
  if ((await pushStatus()) === 'on') await enablePush().catch(() => {});
}
