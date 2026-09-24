import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openDatabase } from './db.js';
import { HttpError } from './errors.js';
import { createNaverClient } from './naver.js';
import { attachRealtime } from './realtime.js';
import { createRideService } from './rides.js';
import { authRouter } from './routes/auth.js';
import { placesRouter } from './routes/places.js';
import { ridesRouter } from './routes/rides.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

export function createApp({ dbPath = ':memory:', secret, naver = createNaverClient() }) {
  if (!secret) throw new Error('JWT secret is required');
  const db = openDatabase(dbPath);
  const rides = createRideService(db, {
    // 네이버 길찾기가 설정돼 있으면 실제 도로 경로/택시요금을 사용하고, 실패하면 추정치로 대체
    findRoute: naver.mapsEnabled
      ? (origin, destination) => naver.route(origin, destination).catch((err) => {
          console.error('[naver] route:', err.message);
          return null;
        })
      : null,
  });

  const app = express();
  const server = createServer(app);
  const realtime = attachRealtime(server, rides, secret);

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(PUBLIC_DIR));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ naverMapKeyId: naver.mapKeyId }));
  app.use('/api/auth', authRouter(db, secret));
  app.use('/api/places', placesRouter(naver, secret));
  app.use('/api/rides', ridesRouter(rides, secret, realtime.notifyRide));
  app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

  // Express 5 forwards thrown errors (sync and async) here.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '잘못된 JSON 요청입니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  return { app, server, db, io: realtime.io };
}
