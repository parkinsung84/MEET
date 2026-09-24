// 약관·동의 항목. 문서를 고치면 version 을 올리세요 — 기존 회원은 다음 로그인 때 다시 동의해야 합니다.
export const CONSENTS = {
  terms: { version: '2026-09-24', label: '이용약관 동의', url: '/legal/terms.html' },
  privacy: { version: '2026-09-24', label: '개인정보 수집·이용 동의', url: '/legal/privacy.html' },
  location: { version: '2026-09-24', label: '위치기반서비스 이용약관 동의', url: '/legal/location.html' },
  age: { version: '2026-09-24', label: '만 19세 이상입니다', url: null },
};
export const CONSENT_KINDS = Object.keys(CONSENTS);
