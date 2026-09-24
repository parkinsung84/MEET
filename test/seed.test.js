import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { ensureDemoAccount } from '../src/seed.js';
import { relaxedLimits } from './helpers.js';

const quiet = { info() {}, warn() {} };
let app;
let base;
const api = async (method, path, { token, body } = {}) => {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

before(async () => {
  app = createApp({ secret: 'seed', push: null, authLimits: relaxedLimits() });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://localhost:${app.server.address().port}`;
});
after(() => new Promise((r) => app.server.close(r)));

test('환경변수가 없으면 아무것도 만들지 않음, 잘못된 값은 거절', () => {
  assert.equal(ensureDemoAccount(app.db, {}, quiet), null);
  assert.equal(ensureDemoAccount(app.db, { DEMO_LOGIN_EMAIL: 'bad', DEMO_LOGIN_PASSWORD: 'password123' }, quiet), null);
  assert.equal(ensureDemoAccount(app.db, { DEMO_LOGIN_EMAIL: 'a@b.com', DEMO_LOGIN_PASSWORD: 'short' }, quiet), null);
});

test('체험 계정: 가입·문자 인증 없이 로그인해서 바로 합승을 만들 수 있다', async () => {
  const env = { DEMO_LOGIN_EMAIL: 'Owner@Meet.com', DEMO_LOGIN_PASSWORD: 'demo-pass-123' };
  assert.equal(ensureDemoAccount(app.db, env, quiet), 'owner@meet.com');
  const login = await api('POST', '/auth/login', { body: { email: 'owner@meet.com', password: 'demo-pass-123' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.verified, true);
  assert.deepEqual(login.body.user.consentsRequired, []);
  const ride = await api('POST', '/rides', {
    token: login.body.token,
    body: { origin: { name: '서울역', lat: 37.5547, lng: 126.9707 }, destination: { name: '강남역', lat: 37.4979, lng: 127.0276 }, departAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  assert.equal(ride.status, 201, JSON.stringify(ride.body));

  // 비밀번호를 바꾸고 재시작하면 새 비밀번호로만 로그인, 기존 로그인은 해제
  ensureDemoAccount(app.db, { ...env, DEMO_LOGIN_PASSWORD: 'new-pass-456' }, quiet);
  assert.equal((await api('GET', '/auth/me', { token: login.body.token })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'owner@meet.com', password: 'demo-pass-123' } })).status, 401);
  assert.equal((await api('POST', '/auth/login', { body: { email: 'owner@meet.com', password: 'new-pass-456' } })).status, 200);
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'owner@meet.com'").get().n, 1, '중복 생성 없음');
});
