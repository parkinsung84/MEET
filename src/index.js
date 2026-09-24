import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';
import { naverClientFromEnv } from './naver.js';

const port = Number(process.env.PORT) || 3000;
let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET 이 설정되지 않아 임시 키를 사용합니다. 서버 재시작 시 모든 로그인이 만료됩니다.');
}

const naver = naverClientFromEnv();
if (!naver.mapsEnabled) console.warn('[warn] NAVER_MAP_KEY_ID/NAVER_MAP_KEY 미설정: 지도·주소검색·길찾기 없이 동작합니다.');
if (!naver.searchEnabled) console.warn('[warn] NAVER_SEARCH_CLIENT_ID/SECRET 미설정: 장소명 검색이 제한됩니다.');

const { server } = createApp({ dbPath: process.env.DB_PATH || 'meet.db', secret, naver });
server.listen(port, () => {
  console.log(`MEET 택시 합승 서버: http://localhost:${port}`);
});
