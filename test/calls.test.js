import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { iceServersFor } from '../src/calls.js';
import { identity, relaxedLimits } from './helpers.js';

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };

let server;
let baseUrl;
let calls;
const sockets = [];

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function signup(gender = 'male') {
  seq += 1;
  const res = await api('POST', '/auth/register', {
    body: { email: `call${seq}@test.com`, password: 'password123', nickname: `통화${seq}`, gender, ...identity() },
  });
  const { token, devCode } = res.body;
  const { user } = (await api('POST', '/auth/phone/verify', { token, body: { code: devCode } })).body;
  return { token, user };
}

function sock(user) {
  return new Promise((resolve, reject) => {
    const s = connect(baseUrl, { auth: { token: user.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emit = (s, ev, payload) => new Promise((resolve) => s.emit(ev, payload, resolve));
const next = (s, ev, ms = 2000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), ms);
  s.once(ev, (data) => { clearTimeout(timer); resolve(data); });
});
/** ms 동안 이벤트가 오지 않아야 함 */
const silent = (s, ev, ms = 150) => new Promise((resolve, reject) => {
  const handler = () => reject(new Error(`unexpected ${ev}`));
  s.once(ev, handler);
  setTimeout(() => { s.off(ev, handler); resolve(); }, ms);
});

let hours = 0;
async function rideWith(host, ...members) {
  const { body } = await api('POST', '/rides', {
    token: host.token,
    // 이 파일의 테스트는 성별과 무관하므로 남녀가 함께 탈 수 있는 대형 택시 합승으로 만든다
    body: { origin: SEOUL_STN, destination: GANGNAM, departAt: new Date(Date.now() + (hours += 3) * 3600_000).toISOString(), taxiType: 'large' },
  });
  for (const m of members) await api('POST', `/rides/${body.ride.id}/join`, { token: m.token });
  return body.ride;
}

before(async () => {
  ({ server, calls } = createApp({ secret: 'call-secret', authLimits: relaxedLimits(), push: null, callRingTimeoutMs: 300 }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => {
  sockets.forEach((s) => s.disconnect());
  return new Promise((resolve) => server.close(resolve));
});

test('같은 합승 탑승자끼리만 걸 수 있다', async () => {
  const [a, b, x] = [await signup(), await signup(), await signup()];
  const ride = await rideWith(a, b);
  const [sa, sx] = [await sock(a), await sock(x)];
  assert.equal((await emit(sx, 'call:invite', { rideId: ride.id, to: a.user.id })).ok, false);
  assert.equal((await emit(sa, 'call:invite', { rideId: ride.id, to: x.user.id })).ok, false);
  assert.equal((await emit(sa, 'call:invite', { rideId: ride.id, to: a.user.id })).ok, false);
  assert.equal((await emit(sa, 'call:invite', { rideId: 999999, to: b.user.id })).ok, false);
});

test('걸기 → 모든 기기에서 벨 → 한 기기에서 받기 → 신호 중계 → 끊기', async () => {
  const [a, b, c] = [await signup(), await signup('female'), await signup()];
  const ride = await rideWith(a, b, c);
  const [sa, sb1, sb2, sc] = [await sock(a), await sock(b), await sock(b), await sock(c)];

  const rings = [next(sb1, 'call:incoming'), next(sb2, 'call:incoming')];
  const invited = await emit(sa, 'call:invite', { rideId: ride.id, to: b.user.id });
  assert.equal(invited.ok, true, invited.error);
  assert.ok(invited.iceServers[0].urls.length);
  const [ring1, ring2] = await Promise.all(rings);
  assert.equal(ring1.callId, invited.callId);
  assert.deepEqual(ring2.from, { id: a.user.id, nickname: a.user.nickname, gender: 'male' });

  // 통화 중인 사람에게는 걸 수 없음
  const busy = await emit(sc, 'call:invite', { rideId: ride.id, to: b.user.id });
  assert.equal(busy.ok, false);
  assert.match(busy.error, /통화 중/);

  const accepted = next(sa, 'call:accepted');
  const stopRing = next(sb1, 'call:ended');
  assert.equal((await emit(sb2, 'call:accept', { callId: invited.callId })).ok, true);
  await accepted;
  assert.equal((await stopRing).reason, 'answered-elsewhere');
  assert.equal((await emit(sb1, 'call:accept', { callId: invited.callId })).ok, false, '이미 받은 통화');

  // 신호는 받은 기기에만, 제3자는 끼어들 수 없음
  const offer = next(sb2, 'call:signal');
  const noLeak = silent(sb1, 'call:signal');
  sa.emit('call:signal', { callId: invited.callId, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  assert.equal((await offer).data.sdp.type, 'offer');
  await noLeak;
  const answer = next(sa, 'call:signal');
  sb2.emit('call:signal', { callId: invited.callId, data: { candidate: { candidate: 'x' } } });
  assert.deepEqual((await answer).data, { candidate: { candidate: 'x' } });
  const intruder = silent(sa, 'call:signal');
  sc.emit('call:signal', { callId: invited.callId, data: { sdp: 'evil' } });
  await intruder;

  const ended = next(sb2, 'call:ended');
  sa.emit('call:end', { callId: invited.callId });
  assert.equal((await ended).reason, 'ended');
  assert.equal(calls.activeCount(), 0);
});

test('거절, 무응답(부재중 알림), 연결 끊김', async () => {
  const [a, b] = [await signup(), await signup()];
  const ride = await rideWith(a, b);
  const [sa, sb] = [await sock(a), await sock(b)];

  let ring = next(sb, 'call:incoming');
  const first = await emit(sa, 'call:invite', { rideId: ride.id, to: b.user.id });
  await ring;
  const declined = next(sa, 'call:ended');
  sb.emit('call:decline', { callId: first.callId });
  assert.equal((await declined).reason, 'declined');

  ring = next(sb, 'call:incoming');
  await emit(sa, 'call:invite', { rideId: ride.id, to: b.user.id });
  await ring;
  const [ea, eb] = await Promise.all([next(sa, 'call:ended'), next(sb, 'call:ended')]);
  assert.equal(ea.reason, 'no-answer');
  assert.equal(eb.reason, 'no-answer');
  await new Promise((r) => setTimeout(r, 30));
  const { notifications } = (await api('GET', '/notifications', { token: b.token })).body;
  assert.ok(notifications.some((n) => n.type === 'missed-call' && n.body.includes(a.user.nickname)));

  ring = next(sb, 'call:incoming');
  const third = await emit(sa, 'call:invite', { rideId: ride.id, to: b.user.id });
  await ring;
  await emit(sb, 'call:accept', { callId: third.callId });
  const dropped = next(sb, 'call:ended');
  sa.disconnect();
  assert.equal((await dropped).reason, 'disconnected');
  assert.equal(calls.activeCount(), 0);
});

test('차단했거나 끝난 합승에서는 통화 불가', async () => {
  const [a, b] = [await signup(), await signup()];
  const ride = await rideWith(a, b);
  await api('POST', `/users/${a.user.id}/block`, { token: b.token });
  const sa = await sock(a);
  assert.equal((await emit(sa, 'call:invite', { rideId: ride.id, to: b.user.id })).ok, false);

  const [c, d] = [await signup(), await signup()];
  const done = await rideWith(c, d);
  await api('PATCH', `/rides/${done.id}/status`, { token: c.token, body: { status: 'departed' } });
  await api('PATCH', `/rides/${done.id}/status`, { token: c.token, body: { status: 'completed' } });
  const res = await emit(await sock(c), 'call:invite', { rideId: done.id, to: d.user.id });
  assert.equal(res.ok, false);
  assert.match(res.error, /이동 중/);
});

test('TURN 임시 계정 (coturn use-auth-secret 형식)', () => {
  const servers = iceServersFor(7, { TURN_URLS: 'turn:turn.example.com:3478', TURN_SECRET: 's3cret' });
  const turn = servers[1];
  assert.match(turn.username, /^\d+:7$/);
  assert.equal(turn.credential, createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
  assert.equal(iceServersFor(1, {}).length, 1, 'TURN 미설정이면 STUN 만');
});
