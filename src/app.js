import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createAccountService } from './account.js';
import { createAlertService } from './alerts.js';
import { createAuth } from './auth.js';
import { createCallService } from './calls.js';
import { openDatabase } from './db.js';
import { HttpError } from './errors.js';
import { createInquiryService } from './inquiries.js';
import { createLocationLog } from './location-log.js';
import { createMatcher } from './matcher.js';
import { createMailer } from './mailer.js';
import { createNaverClient } from './naver.js';
import { createNotifier } from './notifier.js';
import { createWebPush } from './push.js';
import { attachRealtime } from './realtime.js';
import { createRideService } from './rides.js';
import { createSmsSender } from './sms.js';
import { authRouter, createAuthLimits } from './routes/auth.js';
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
  authLimits = createAuthLimits(),
  trustProxy = false,
  production = false,
}) {
  if (!secret) throw new Error('JWT secret is required');
  const db = openDatabase(dbPath);
  const auth = createAuth(db, secret);
  const pusher = push === undefined ? createWebPush(db) : push;
  const notifier = createNotifier(db, { push: pusher });
  const users = createUserService(db, { secret, mailer, sms, exposeDevCode });
  const locationLog = createLocationLog(db);
  const rides = createRideService(db, {
    users,
    notifier,
    locationLog,
    // 네이버 길찾기가 설정돼 있으면 실제 도로 경로/택시요금을 사용하고, 실패하면 추정치로 대체
    findRoute: naver.directionsEnabled
      ? (origin, destination) => naver.route(origin, destination).catch((err) => {
          console.error('[naver] route:', err.message);
          return null;
        })
      : null,
  });
  const alerts = createAlertService(db, { rides, notifier, locationLog });
  const inquiries = createInquiryService(db, { rides, users, notifier });

  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  notifier.attach(io);
  // 로그인 토큰을 무효화하면 접속 중인 소켓도 끊는다
  const account = createAccountService(db, {
    users, auth, sms, mailer, secret, exposeDevCode,
    onRevoke: (userId) => io.in(`user:${userId}`).disconnectSockets(true),
  });

  // 리버스 프록시(Caddy 등) 뒤에서 실제 접속 IP 를 쓰기 위한 설정 — 호출 제한에 사용
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      // 마이크(음성 통화)·위치(현재 위치)는 이 사이트에서만, 카메라는 사용 안 함
      'Permissions-Policy': 'microphone=(self), geolocation=(self), camera=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
  const calls = createCallService(io, { rides, users, notifier, ringTimeoutMs: callRingTimeoutMs });
  const realtime = attachRealtime(io, rides, auth, { calls });
  const rideChanged = (rideId) => realtime.rideChanged(rideId).catch((err) => console.error('[realtime]', err));
  const matcher = createMatcher(db, { rides, users, notifier, onChange: rideChanged });

  app.use(express.json({ limit: '32kb' }));
  app.use(express.static(PUBLIC_DIR));
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get(); // DB 응답 확인
    res.json({ ok: true });
  });
  app.get('/api/config', (req, res) => res.json({
    naverMapKeyId: naver.mapKeyId,
    vapidPublicKey: pusher?.publicKey ?? null,
    // 문자 발송 준비 상태 — 문자가 안 가는데 "보냈어요"라고 안내하지 않도록
    sms: { ready: sms.configured, showCodes: exposeDevCode && !sms.configured },
  }));
  app.use('/api/auth', authRouter(db, auth, users, account, authLimits));
  // 위치정보 이용·제공 사실 확인자료 열람 (본인)
  app.get('/api/me/location-logs', auth.required, (req, res) => res.json({ logs: locationLog.list(req.userId) }));
  // 안심 공유: 로그인 없이 토큰으로 조회 (추측할 수 없는 18바이트 랜덤 토큰)
  app.get('/api/share/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ride: rides.shared(req.params.token) });
  });
  app.use('/api/users', usersRouter(users, auth));
  app.use('/api/notifications', notificationsRouter(notifier, auth));
  app.use('/api/alerts', alertsRouter(alerts, users, auth));
  app.use('/api/places', placesRouter(naver, auth, locationLog));
  // 자동 매칭 요청
  app.post('/api/matching', auth.required, async (req, res) => res.status(201).json({ request: await matcher.request(req.userId, req.body) }));
  app.get('/api/matching', auth.required, (req, res) => res.json({ request: matcher.current(req.userId) }));
  app.delete('/api/matching', auth.required, (req, res) => res.json({ request: matcher.cancel(req.userId) }));
  app.use('/api/rides', ridesRouter({
    rides, users, alerts, inquiries, auth, matcher,
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
    for (const rideId of rides.tick(now)) rideChanged(rideId);
    alerts.purgeExpired(now);
    account.purgeExpired(now);
    locationLog.purgeExpired(now);
    // 자동 매칭: 만료 처리와 대기 요청 재시도 (비동기 — 테스트에서는 await 가능)
    return matcher.tick(now).catch((err) => console.error('[matcher]', err));
  }

  return {
    app, server, db, io, tick, calls, matcher,
    startScheduler() {
      const timer = setInterval(() => {
        try { tick(); } catch (err) { console.error('[scheduler]', err); }
      }, TICK_MS);
      server.on('close', () => clearInterval(timer));
      tick();
    },
  };
}
