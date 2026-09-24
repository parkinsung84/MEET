import { randomBytes } from 'node:crypto';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
let secret = process.env.JWT_SECRET;
if (!secret) {
  secret = randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET 이 설정되지 않아 임시 키를 사용합니다. 서버 재시작 시 모든 로그인이 만료됩니다.');
}

const { server } = createApp({ dbPath: process.env.DB_PATH || 'meet.db', secret });
server.listen(port, () => {
  console.log(`MEET 택시 합승 서버: http://localhost:${port}`);
});
