import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { createMailer } from './mailer.js';
import { naverClientFromEnv } from './naver.js';
import { createSmsSender } from './sms.js';

const port = Number(process.env.PORT) || 3000;
let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET 이 설정되지 않아 임시 키를 사용합니다. 서버 재시작 시 모든 로그인이 만료됩니다.');
}

const naver = naverClientFromEnv();
if (!naver.mapsEnabled) console.warn('[warn] NAVER_MAP_KEY_ID/NAVER_MAP_KEY 미설정: 지도·주소검색·길찾기 없이 동작합니다.');
if (!naver.searchEnabled) console.warn('[warn] NAVER_SEARCH_CLIENT_ID/SECRET 미설정: 장소명 검색이 제한됩니다.');

const mailer = createMailer();
if (!mailer.configured) console.warn('[warn] SMTP_URL 미설정: 인증 메일 대신 콘솔에 인증번호를 출력합니다.');

const sms = createSmsSender();
if (!sms.configured) console.warn('[warn] NCP SENS 미설정: 인증문자 대신 콘솔에 인증번호를 출력합니다.');

const production = process.env.NODE_ENV === 'production';
// 문자 발송(SENS) 준비 전 비공개 시범 운영용: 인증번호를 화면에 보여준다. 공개 운영에서는 절대 켜지 말 것.
const showCodes = process.env.SHOW_VERIFICATION_CODES === '1';
if (production && showCodes) {
  console.warn('[warn] SHOW_VERIFICATION_CODES=1: 인증번호가 화면에 표시됩니다. 비공개 시범 운영에서만 사용하세요.');
}
const { server, startScheduler } = createApp({
  dbPath: process.env.DB_PATH || 'meet.db',
  secret,
  naver,
  mailer,
  sms,
  // 운영 환경에서는 절대 인증번호를 응답에 넣지 않는다
  exposeDevCode: !production || showCodes,
  production,
  // Caddy 등 프록시 뒤에서 실행하면 TRUST_PROXY=1
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
});
startScheduler();
server.listen(port, () => {
  console.log(`MEET 택시 합승 서버: http://localhost:${port}`);
});
