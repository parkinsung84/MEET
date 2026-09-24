import { createAuthLimits } from '../src/routes/auth.js';

export const AGREE_ALL = { terms: true, privacy: true, location: true, age: true };

// 테스트용 본인정보 — 사용자마다 다른 휴대폰 번호 (+ 필수 약관 동의)
let n = 0;
export function identity(overrides = {}) {
  n += 1;
  return {
    name: '홍길동',
    birthDate: '1995-03-15',
    phone: `010-${String(1000 + (n % 9000)).padStart(4, '0')}-${String(n).padStart(4, '0')}`,
    agreements: AGREE_ALL,
    ...overrides,
  };
}

/** 테스트는 한 IP 에서 수백 명이 가입하므로 호출 제한을 넉넉하게 */
export const relaxedLimits = () => createAuthLimits(1000);
