import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createAlertService } from './alerts.js';
import { createCallService } from './calls.js';
import { openDatabase } from './db.js';
import { HttpError } from './errors.js';
import { createInquiryService } from './inquiries.js';
import { createMailer } from './mailer.js';
import { createNaverClient } from './naver.js';
import { createNotifier } from './notifier.js';
import { createWebPush } from './push.js';
import { attachRealtime } from './realtime.js';
import { createRideService } from './rides.js';
import { createSmsSender } from './sms.js';
import { authRouter } from './routes/auth.js';
import { placesRouter } from './routes/places.js';
import { ridesRouter } from './routes/rides.js';
import { alertsRouter, notificationsRouter, usersRouter } from './routes/users.js';
import { createUserService } from './users.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));
const TICK_MS = 60 * 1000;

/**
 * naver: 네이버 API 클라이언트, mailer: 메일 발송, sms: 문자 발송, push: Web Push 발송기 (테스트에서 대역 주입)
 * exposeDevCode: 메일/문자 서비스가 없을 때 인증번호를 응답에 포함 (개발용)
 */
export function createApp({
  dbPath = ':memory:',
  secret,
  naver = createNaverClient(),
  mailer = createMailer({}, { info() {} }),
  sms = createSmsSender({}, { log: { info() {} } }),
  push,
  exposeDevCode = true,
  callRingTimeoutMs,
}) {
  if (!secret) throw new Error('JWT secret is required');
  const db = openDatabase(dbPath);
  const pusher = push === undefined ? createWebPush(db) : push;
  const notifier = createNotifier(db, { push: pusher });
  const users = createUserService(db, { secret, mailer, sms, exposeDevCode });
  const rides = createRideService(db, {
    users,
    notifier,
    // 네이버 길찾기가 설정돼 있으면 실제 도로 경로/택시요금을 사용하고, 실패하면 추정치로 대체
    findRoute: naver.mapsEnabled
      ? (origin, destination) => naver.route(origin, destination).catch((err) => {
          console.error('[naver] route:', err.message);
          return null;
        })
      : null,
  });
  const alerts = createAlertService(db, { rides, notifier });
  const inquiries = createInquiryService(db, { rides, users, notifier });

  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  notifier.attach(io);
  const calls = createCallService(io, { rides, users, notifier, ringTimeoutMs: callRingTimeoutMs });
  const realtime = attachRealtime(io, rides, secret, { calls });

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(PUBLIC_DIR));
  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({
    naverMapKeyId: naver.mapKeyId,
    vapidPublicKey: pusher?.publicKey ?? null,
  }));
  app.use('/api/auth', authRouter(db, secret, users));
  app.use('/api/users', usersRouter(users, secret));
  app.use('/api/notifications', notificationsRouter(notifier, secret));
  app.use('/api/alerts', alertsRouter(alerts, users, secret));
  app.use('/api/places', placesRouter(naver, secret));
  app.use('/api/rides', ridesRouter({
    rides, users, alerts, inquiries, secret,
    changed: realtime.rideChanged,
    inquiryPosted: realtime.inquiryPosted,
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 API입니다.' }));

  // Express 5 forwards thrown errors (sync and async) here.
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: '잘못된 JSON 요청입니다.' });
    console.error(err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  });

  /** 주기 작업 1회 실행: 출발 알림, 방 자동 정리, 만료된 경로 알림 삭제 */
  function tick(now = Date.now()) {
    for (const rideId of rides.tick(now)) realtime.rideChanged(rideId).catch((err) => console.error('[realtime]', err));
    alerts.purgeExpired(now);
  }

  return {
    app, server, db, io, tick, calls,
    startScheduler() {
      const timer = setInterval(() => {
        try { tick(); } catch (err) { console.error('[scheduler]', err); }
      }, TICK_MS);
      server.on('close', () => clearInterval(timer));
      tick();
    },
  };
}
