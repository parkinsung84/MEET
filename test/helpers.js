// 테스트용 본인정보 — 사용자마다 다른 휴대폰 번호
let n = 0;
export function identity(overrides = {}) {
  n += 1;
  return { name: '홍길동', birthDate: '1995-03-15', phone: `010-${String(1000 + (n % 9000)).padStart(4, '0')}-${String(n).padStart(4, '0')}`, ...overrides };
}
