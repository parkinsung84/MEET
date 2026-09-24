import { createHmac } from 'node:crypto';

/**
 * 문자(SMS) 발송. 네이버 클라우드 SENS 설정이 없으면 콘솔에 출력하는 개발용 모드로 동작한다.
 *  NCP_ACCESS_KEY / NCP_SECRET_KEY: NCP 계정 API 인증키 (마이페이지 > 인증키 관리)
 *  NCP_SENS_SERVICE_ID: SENS 프로젝트의 SMS 서비스 ID
 *  SMS_FROM: 콘솔에 등록된 발신번호
 */
export function createSmsSender(env = process.env, { fetch = globalThis.fetch, log = console } = {}) {
  const { NCP_ACCESS_KEY: accessKey, NCP_SECRET_KEY: secretKey, NCP_SENS_SERVICE_ID: serviceId, SMS_FROM: from } = env;
  if (!accessKey || !secretKey || !serviceId || !from) {
    return {
      configured: false,
      async send(to, text) {
        log.info(`[sms:dev] to=${to} ${text}`);
      },
    };
  }
  const host = env.NCP_SENS_BASE_URL || 'https://sens.apigw.ntruss.com';
  // 서비스 ID(ncp:sms:kr:...)는 인코딩하지 않는다 — 서명 대상 경로와 요청 경로가 같아야 함
  const path = `/sms/v2/services/${serviceId}/messages`;
  return {
    configured: true,
    async send(to, text) {
      const timestamp = String(Date.now());
      // 서명: "POST {path}\n{timestamp}\n{accessKey}" 를 secret key 로 HMAC-SHA256 → base64
      const signature = createHmac('sha256', secretKey).update(`POST ${path}\n${timestamp}\n${accessKey}`).digest('base64');
      const res = await fetch(`${host}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-ncp-apigw-timestamp': timestamp,
          'x-ncp-iam-access-key': accessKey,
          'x-ncp-apigw-signature-v2': signature,
        },
        body: JSON.stringify({ type: 'SMS', from, content: text, messages: [{ to }] }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`SENS ${res.status}: ${await res.text().catch(() => '')}`);
    },
  };
}
