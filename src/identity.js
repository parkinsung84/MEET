/**
 * 휴대폰 본인확인 (PASS 등) — 포트원(PortOne) V2 본인인증 연동.
 *
 * 브라우저가 포트원 SDK로 본인인증 창(다날·KCP 휴대폰 본인인증 또는 KG이니시스 통합인증)을 띄우고,
 * 서버는 인증이 끝난 건을 포트원 API로 다시 조회해서 이름·생년월일·성별·휴대폰 번호를 확정한다.
 * (브라우저가 보낸 값은 믿지 않는다)
 *
 *  PORTONE_STORE_ID:    포트원 관리자 콘솔 > 연동 정보 > Store ID (공개값)
 *  PORTONE_CHANNEL_KEY: 연동 정보 > 채널 관리 > 본인인증 채널 키 (공개값)
 *  PORTONE_API_SECRET:  연동 정보 > V2 API Secret (비밀 — 서버에서만 사용)
 */

const DEFAULT_BASE_URL = 'https://api.portone.io';
const TIMEOUT_MS = 8000;

export class IdentityApiError extends Error {}

const unset = (v) => !v || ['none', '-', 'todo'].includes(String(v).trim().toLowerCase());

export function createIdentityClient({ storeId, channelKey, apiSecret, baseUrl = DEFAULT_BASE_URL, fetch = globalThis.fetch } = {}) {
  const enabled = ![storeId, channelKey, apiSecret].some(unset);

  return {
    enabled,
    provider: enabled ? 'portone' : null,
    /** 브라우저 SDK 호출에 필요한 공개값 */
    publicConfig: enabled ? { provider: 'portone', storeId, channelKey } : null,

    /**
     * 인증 건 조회 → 인증 완료된 경우 본인정보, 아니면 null.
     * 반환: { name, birthDate, gender: 'male'|'female'|null, phone|null, key|null, isForeigner }
     *  key: 사람마다 고유한 값 (CI 우선, 없으면 DI) — 1인 1계정 확인용
     */
    async fetchVerified(identityVerificationId) {
      let res;
      try {
        res = await fetch(`${baseUrl}/identity-verifications/${encodeURIComponent(identityVerificationId)}`, {
          headers: { Authorization: `PortOne ${apiSecret}` },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        throw new IdentityApiError(`본인확인 서버 연결 실패: ${err.message}`);
      }
      const body = await res.json().catch(() => null);
      if (res.status === 404) return null;
      if (!res.ok) throw new IdentityApiError(`본인확인 조회 오류 ${res.status}: ${body?.message ?? ''}`);
      if (body?.status !== 'VERIFIED' || !body.verifiedCustomer) return null;
      const c = body.verifiedCustomer;
      return {
        name: c.name ?? null,
        birthDate: c.birthDate ?? null,
        gender: c.gender === 'MALE' ? 'male' : c.gender === 'FEMALE' ? 'female' : null,
        phone: c.phoneNumber ? String(c.phoneNumber).replace(/\D/g, '') : null,
        key: c.ci || c.di || null,
        isForeigner: Boolean(c.isForeigner),
      };
    },
  };
}

export function identityClientFromEnv(env = process.env) {
  return createIdentityClient({
    storeId: env.PORTONE_STORE_ID?.trim(),
    channelKey: env.PORTONE_CHANNEL_KEY?.trim(),
    apiSecret: env.PORTONE_API_SECRET?.trim(),
    baseUrl: env.PORTONE_API_BASE_URL || undefined,
  });
}
