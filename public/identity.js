import { api, refreshMe, state } from './core.js';
import { takeAfterLogin } from './screens/commutes.js';
import { toast } from './ui.js';

// 휴대폰 본인확인(PASS 등) — 포트원 V2 브라우저 SDK. 결과는 서버가 포트원에 직접 확인한다.

const SDK_URL = 'https://cdn.portone.io/v2/browser-sdk.js';
let sdkPromise = null;

function loadSdk() {
  sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.onload = () => (window.PortOne ? resolve(window.PortOne) : reject(new Error('본인확인 모듈을 불러오지 못했어요.')));
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('본인확인 모듈을 불러오지 못했어요. 네트워크를 확인해 주세요.'));
    };
    document.head.append(script);
  });
  return sdkPromise;
}

async function complete(identityVerificationId) {
  await api('POST', '/auth/identity/complete', { identityVerificationId });
  await refreshMe();
  toast('✅ 본인 확인이 완료되었어요!');
  location.hash = takeAfterLogin() ?? '#/';
}

/** 본인확인 창 열기. PC는 팝업으로 결과를 바로 받고, 모바일은 인증 후 앱 주소로 돌아온다 (handleIdentityReturn) */
export async function startIdentityVerification() {
  const { storeId, channelKey } = state.config.identity;
  const PortOne = await loadSdk();
  const { identityVerificationId } = await api('POST', '/auth/identity/start');
  const response = await PortOne.requestIdentityVerification({
    storeId,
    channelKey,
    identityVerificationId,
    redirectUrl: `${location.origin}/`,
  });
  if (!response) return; // 모바일: 페이지가 이동한다
  if (response.code !== undefined) throw new Error(response.message || '본인확인이 취소되었어요.');
  await complete(identityVerificationId);
}

/** 모바일 본인확인 후 ?identityVerificationId=...(&code=...&message=...) 로 돌아온 경우 처리 */
export async function handleIdentityReturn() {
  const params = new URLSearchParams(location.search);
  const id = params.get('identityVerificationId');
  if (!id) return;
  history.replaceState(null, '', `${location.pathname}#/verify`);
  if (params.get('code')) {
    toast(params.get('message') || '본인확인이 취소되었어요.');
    return;
  }
  if (!state.token) return;
  try {
    await complete(id);
  } catch (err) {
    toast(err.message);
  }
}
