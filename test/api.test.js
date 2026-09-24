import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { identity, relaxedLimits } from './helpers.js';

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };
const HONGDAE = { name: '홍대입구역', lat: 37.5572, lng: 126.9245 };
const inHours = (h) => new Date(Date.now() + h * 3600_000).toISOString();

let server;
let baseUrl;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function register(gender = 'male') {
  seq += 1;
  const res = await api('POST', '/auth/register', {
    body: { email: `user${seq}@test.com`, password: 'password123', nickname: `유저${seq}`, gender, ...identity() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { token, devCode } = res.body;
  const verified = await api('POST', '/auth/phone/verify', { token, body: { code: devCode } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  return { token, user: { ...verified.body.user, email: `user${seq}@test.com` } };
}

const rideInput = (overrides = {}) => ({
  origin: SEOUL_STN,
  destination: GANGNAM,
  departAt: inHours(1),
  maxSeats: 3,
  ...overrides,
});

before(async () => {
  ({ server } = createApp({ secret: 'test-secret', authLimits: relaxedLimits(), push: null }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

describe('auth', () => {
  test('회원가입 → 로그인 → 내 정보', async () => {
    const { user } = await register();
    const login = await api('POST', '/auth/login', { body: { email: user.email, password: 'password123' } });
    assert.equal(login.status, 200);
    const me = await api('GET', '/auth/me', { token: login.body.token });
    assert.equal(me.body.user.id, user.id);
    assert.equal(me.body.user.password_hash, undefined);
  });

  test('잘못된 비밀번호는 401', async () => {
    const { user } = await register();
    const res = await api('POST', '/auth/login', { body: { email: user.email, password: 'wrong-password' } });
    assert.equal(res.status, 401);
  });

  test('중복 이메일은 409', async () => {
    const { user } = await register();
    const res = await api('POST', '/auth/register', {
      body: { email: user.email, password: 'password123', nickname: 'x', gender: 'male', ...identity() },
    });
    assert.equal(res.status, 409);
  });

  test('토큰 없이 합승방 API 접근 시 401', async () => {
    assert.equal((await api('GET', '/rides')).status, 401);
  });
});

describe('rides', () => {
  test('합승방 생성 시 방장이 첫 멤버가 되고 요금이 계산된다', async () => {
    const host = await register();
    const res = await api('POST', '/rides', { token: host.token, body: rideInput() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { ride } = res.body;
    assert.equal(ride.hostId, host.user.id);
    assert.equal(ride.memberCount, 1);
    assert.equal(ride.members[0].id, host.user.id);
    assert.ok(ride.fare.total > 4800);
    assert.equal(ride.fare.shares[host.user.id], Math.ceil(ride.fare.total / 10) * 10);
  });

  test('잘못된 입력은 400', async () => {
    const host = await register();
    for (const body of [
      rideInput({ departAt: inHours(-1) }),
      rideInput({ departAt: inHours(24 * 8) }),
      rideInput({ maxSeats: 5 }),
      rideInput({ origin: { name: '', lat: 1, lng: 1 } }),
      rideInput({ destination: { name: 'x', lat: 'abc', lng: 1 } }),
      rideInput({ genderPref: 'female' }), // 남성 방장이 여성 전용방 생성
    ]) {
      const res = await api('POST', '/rides', { token: host.token, body });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test('참여 → 정원 초과 → 나가기 흐름', async () => {
    const host = await register();
    const { body } = await api('POST', '/rides', { token: host.token, body: rideInput({ maxSeats: 2 }) });
    const id = body.ride.id;

    const guest = await register();
    const joined = await api('POST', `/rides/${id}/join`, { token: guest.token });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.ride.memberCount, 2);
    assert.equal(joined.body.ride.fare.shares[guest.user.id], joined.body.ride.fare.perPersonFull);

    assert.equal((await api('POST', `/rides/${id}/join`, { token: guest.token })).status, 409, '중복 참여');
    const third = await register();
    assert.equal((await api('POST', `/rides/${id}/join`, { token: third.token })).status, 409, '정원 초과');

    const left = await api('POST', `/rides/${id}/leave`, { token: guest.token });
    assert.equal(left.body.ride.memberCount, 1);
  });

  test('방장이 나가면 다음 멤버에게 위임, 모두 나가면 취소', async () => {
    const host = await register();
    const { body } = await api('POST', '/rides', { token: host.token, body: rideInput() });
    const id = body.ride.id;
    const guest = await register();
    await api('POST', `/rides/${id}/join`, { token: guest.token });

    const afterHostLeft = await api('POST', `/rides/${id}/leave`, { token: host.token });
    assert.equal(afterHostLeft.body.ride.hostId, guest.user.id);
    assert.equal(afterHostLeft.body.ride.status, 'open');

    const afterAllLeft = await api('POST', `/rides/${id}/leave`, { token: guest.token });
    assert.equal(afterAllLeft.body.ride.status, 'cancelled');
  });

  test('성별 제한 방은 다른 성별이 참여할 수 없고 검색에도 보이지 않는다', async () => {
    const host = await register('female');
    const { body } = await api('POST', '/rides', {
      token: host.token,
      body: rideInput({ genderPref: 'female', origin: HONGDAE }),
    });
    const male = await register('male');
    assert.equal((await api('POST', `/rides/${body.ride.id}/join`, { token: male.token })).status, 403);

    const q = `?originLat=${HONGDAE.lat}&originLng=${HONGDAE.lng}`;
    const maleSearch = await api('GET', `/rides${q}`, { token: male.token });
    assert.ok(!maleSearch.body.rides.some((r) => r.id === body.ride.id));
    const female = await register('female');
    const femaleSearch = await api('GET', `/rides${q}`, { token: female.token });
    assert.ok(femaleSearch.body.rides.some((r) => r.id === body.ride.id));
  });

  test('검색은 반경 내 방만 가까운 순으로 반환', async () => {
    // 한 사람은 같은 시간대에 합승 하나만 가질 수 있으므로 방장을 나눈다
    const near = await api('POST', '/rides', {
      token: (await register()).token,
      body: rideInput({ origin: { name: '서울역 인근', lat: 37.556, lng: 126.972 } }),
    });
    const exact = await api('POST', '/rides', { token: (await register()).token, body: rideInput() });
    const far = await api('POST', '/rides', { token: (await register()).token, body: rideInput({ origin: HONGDAE }) });

    const viewer = await register();
    const q = `?originLat=${SEOUL_STN.lat}&originLng=${SEOUL_STN.lng}&destLat=${GANGNAM.lat}&destLng=${GANGNAM.lng}&radiusKm=1`;
    const { body } = await api('GET', `/rides${q}`, { token: viewer.token });
    const ids = body.rides.map((r) => r.id);
    assert.ok(ids.indexOf(exact.body.ride.id) < ids.indexOf(near.body.ride.id));
    assert.ok(!ids.includes(far.body.ride.id));
  });

  test('상태 변경은 방장만, 허용된 순서로만', async () => {
    const host = await register();
    const { body } = await api('POST', '/rides', { token: host.token, body: rideInput() });
    const id = body.ride.id;
    const guest = await register();
    await api('POST', `/rides/${id}/join`, { token: guest.token });

    const patch = (token, status) => api('PATCH', `/rides/${id}/status`, { token, body: { status } });
    assert.equal((await patch(guest.token, 'departed')).status, 403);
    assert.equal((await patch(host.token, 'completed')).status, 409);
    assert.equal((await patch(host.token, 'departed')).body.ride.status, 'departed');
    assert.equal((await api('POST', `/rides/${id}/leave`, { token: guest.token })).status, 409);
    assert.equal((await patch(host.token, 'completed')).body.ride.status, 'completed');

    const mine = await api('GET', '/rides/mine', { token: guest.token });
    assert.ok(mine.body.rides.some((r) => r.id === id));
  });

  test('없는 방은 404', async () => {
    const user = await register();
    assert.equal((await api('GET', '/rides/999999', { token: user.token })).status, 404);
  });
});

describe('realtime chat', () => {
  const connectAs = (token) =>
    new Promise((resolve, reject) => {
      const socket = connect(baseUrl, { auth: { token }, transports: ['websocket'] });
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });
  const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

  test('멤버끼리 메시지를 주고받고, 비멤버는 입장할 수 없다', async () => {
    const host = await register();
    const guest = await register();
    const outsider = await register();
    const { body } = await api('POST', '/rides', { token: host.token, body: rideInput() });
    const id = body.ride.id;
    await api('POST', `/rides/${id}/join`, { token: guest.token });

    const [a, b, c] = await Promise.all([host, guest, outsider].map((u) => connectAs(u.token)));
    try {
      assert.equal((await emit(a, 'ride:subscribe', id)).ok, true);
      assert.equal((await emit(b, 'ride:subscribe', id)).ok, true);
      assert.equal((await emit(c, 'ride:subscribe', id)).ok, false);

      const received = new Promise((resolve) => b.once('chat:message', resolve));
      const sent = await emit(a, 'chat:send', { rideId: id, body: '서울역 2번 출구 앞에서 만나요' });
      assert.equal(sent.ok, true);
      assert.equal((await received).body, '서울역 2번 출구 앞에서 만나요');

      assert.equal((await emit(c, 'chat:send', { rideId: id, body: 'hi' })).ok, false);

      const history = await api('GET', `/rides/${id}/messages`, { token: guest.token });
      assert.equal(history.body.messages.length, 1);
      assert.equal((await api('GET', `/rides/${id}/messages`, { token: outsider.token })).status, 403);
    } finally {
      [a, b, c].forEach((s) => s.disconnect());
    }
  });

  test('잘못된 토큰으로는 연결할 수 없다', async () => {
    await assert.rejects(connectAs('bad-token'));
  });
});
