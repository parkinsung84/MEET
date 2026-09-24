import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { identity, relaxedLimits } from './helpers.js';

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const SEOUL_NEAR = { name: '서울역 서부', lat: 37.5555, lng: 126.9690 }; // 서울역에서 약 170m
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };
const GANGNAM_NEAR = { name: '역삼역', lat: 37.5006, lng: 127.0364 };  // 강남역에서 약 850m
const MIDWAY = { name: '중간 지점', lat: 37.5263, lng: 126.99915 };
const HONGDAE = { name: '홍대입구역', lat: 37.5572, lng: 126.9245 };
const JAMSIL = { name: '잠실역', lat: 37.5133, lng: 127.1001 };
const MIN = 60 * 1000;
const inMin = (m) => new Date(Date.now() + m * MIN).toISOString();

let server;
let base;
let tick;
let matcher;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function signup(gender = 'male', { verify = true } = {}) {
  seq += 1;
  const res = await api('POST', '/auth/register', {
    body: { email: `match${seq}@test.com`, password: 'password123', nickname: `매칭${seq}`, gender, ...identity() },
  });
  const { token, devCode } = res.body;
  if (!verify) return { token, user: res.body.user };
  const { user } = (await api('POST', '/auth/phone/verify', { token, body: { code: devCode } })).body;
  return { token, user };
}

/** 테스트마다 시간대를 달리해 서로 섞이지 않게 한다 */
let slot = 0;
const nextSlot = () => (slot += 240);

const request = (u, body) => api('POST', '/matching', { token: u.token, body });
const notes = async (u) => (await api('GET', '/notifications', { token: u.token })).body.notifications;
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  ({ server, tick, matcher } = createApp({ secret: 'match-secret', push: null, authLimits: relaxedLimits() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('자동 매칭', () => {
  test('맞는 방이 있으면 바로 자동 참여 (가는 길 하차 포함)', async () => {
    const t = nextSlot();
    const host = await signup();
    const { body } = await api('POST', '/rides', {
      token: host.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 20) },
    });
    const rider = await signup();
    const res = await request(rider, { origin: SEOUL_NEAR, destination: MIDWAY, from: inMin(t), to: inMin(t + 40) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'matched');
    assert.equal(res.body.request.rideId, body.ride.id);
    const ride = (await api('GET', `/rides/${body.ride.id}`, { token: rider.token })).body.ride;
    assert.equal(ride.members.find((m) => m.id === rider.user.id).dropoff.name, '중간 지점');
    await settle();
    assert.ok((await notes(rider)).some((n) => n.type === 'matched'));
    assert.ok((await notes(host)).some((n) => n.type === 'join'));
  });

  test('방이 없으면 대기 → 맞는 요청이 오면 둘이서 방을 자동 생성, 세 번째는 그 방에 합류', async () => {
    const t = nextSlot();
    const [a, b, c] = [await signup(), await signup(), await signup()];
    const first = await request(a, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) });
    assert.equal(first.body.request.status, 'waiting');

    const second = await request(b, { origin: SEOUL_NEAR, destination: GANGNAM_NEAR, from: inMin(t + 10), to: inMin(t + 40) });
    assert.equal(second.body.request.status, 'matched');
    const rideId = second.body.request.rideId;
    const ride = (await api('GET', `/rides/${rideId}`, { token: a.token })).body.ride;
    assert.equal(ride.hostId, a.user.id, '먼저 기다린 사람이 방장');
    assert.equal(ride.meetingPoint, '서울역', '방장 출발지가 만남 장소');
    assert.equal(ride.memberCount, 2);
    assert.equal(ride.genderPref, 'male');
    const depart = Date.parse(ride.departAt);
    assert.ok(depart >= Date.parse(inMin(t + 10)) - 1000 && depart <= Date.parse(inMin(t + 30)), '두 사람 시간이 겹치는 첫 시각');
    assert.equal((await api('GET', '/matching', { token: a.token })).body.request.status, 'matched');

    const third = await request(c, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) });
    assert.equal(third.body.request.rideId, rideId);
    await settle();
    for (const u of [a, b, c]) assert.ok((await notes(u)).some((n) => n.type === 'matched' && n.rideId === rideId));
  });

  test('누가 직접 방을 만들면 기다리던 요청이 그 방에 자동 참여', async () => {
    const t = nextSlot();
    const waiter = await signup();
    await request(waiter, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 60) });
    const host = await signup();
    const { body } = await api('POST', '/rides', {
      token: host.token, body: { origin: SEOUL_NEAR, destination: GANGNAM, departAt: inMin(t + 30) },
    });
    await settle();
    assert.equal((await api('GET', '/matching', { token: waiter.token })).body.request.rideId, body.ride.id);
  });

  test('성별·차단·시간·거리가 안 맞으면 짝짓지 않음', async () => {
    const t = nextSlot();
    const base1 = await signup('female');
    await request(base1, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) });
    const man = await signup('male');
    assert.equal((await request(man, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) })).body.request.status, 'waiting', '성별 다름');
    const blocked = await signup('female');
    await api('POST', `/users/${blocked.user.id}/block`, { token: base1.token });
    assert.equal((await request(blocked, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) })).body.request.status, 'waiting', '차단');
    const late = await signup('female');
    assert.equal((await request(late, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t + 60), to: inMin(t + 90) })).body.request.status, 'waiting', '시간 안 겹침');
    const far = await signup('female');
    assert.equal((await request(far, { origin: HONGDAE, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) })).body.request.status, 'waiting', '출발지 멂');
    // 다른 사람들끼리는 맞으면 매칭 (late 와 같은 시간대 여성)
    const pair = await signup('female');
    assert.equal((await request(pair, { origin: SEOUL_STN, destination: GANGNAM, from: inMin(t + 60), to: inMin(t + 90) })).body.request.status, 'matched');
  });

  test('요청은 한 사람당 하나, 취소 후 다시 가능, 입력 검증, 인증 필수', async () => {
    const t = nextSlot();
    const u = await signup();
    const body = { origin: JAMSIL, destination: HONGDAE, from: inMin(t), to: inMin(t + 30) };
    assert.equal((await request(u, body)).status, 201);
    assert.equal((await request(u, body)).status, 409);
    assert.equal((await api('DELETE', '/matching', { token: u.token })).body.request.status, 'cancelled');
    assert.equal((await request(u, body)).status, 201);
    await api('DELETE', '/matching', { token: u.token });
    assert.equal((await request(u, { ...body, to: inMin(t + 3) })).status, 400, '너무 짧은 시간 범위');
    assert.equal((await request(u, { ...body, to: inMin(t + 300) })).status, 400, '너무 긴 시간 범위');
    assert.equal((await request(u, { ...body, origin: { name: '' } })).status, 400);
    assert.equal((await request(await signup('male', { verify: false }), body)).status, 403);
  });

  test('시간이 지나면 만료 알림', async () => {
    const t = nextSlot();
    const u = await signup();
    const { body } = await request(u, { origin: JAMSIL, destination: SEOUL_STN, from: inMin(t), to: inMin(t + 20) });
    await tick(Date.parse(body.request.to) + MIN);
    assert.equal((await api('GET', '/matching', { token: u.token })).body.request.status, 'expired');
    assert.ok((await notes(u)).some((n) => n.type === 'match-expired'));
  });
});

describe('비슷한 방 방지·합치기', () => {
  test('방 만들기 전 비슷한 방 확인 (1km·±20분)', async () => {
    const t = nextSlot();
    const host = await signup();
    const { body } = await api('POST', '/rides', { token: host.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 30) } });
    const me = await signup();
    const q = (o, d, at) => `/rides/similar?originLat=${o.lat}&originLng=${o.lng}&destLat=${d.lat}&destLng=${d.lng}&departAt=${encodeURIComponent(at)}`;
    const near = await api('GET', q(SEOUL_NEAR, GANGNAM_NEAR, inMin(t + 40)), { token: me.token });
    assert.deepEqual(near.body.rides.map((r) => r.id), [body.ride.id]);
    assert.equal((await api('GET', q(SEOUL_NEAR, GANGNAM, inMin(t + 60)), { token: me.token })).body.rides.length, 0, '시간이 멀면 제외');
    assert.equal((await api('GET', q(HONGDAE, GANGNAM, inMin(t + 30)), { token: me.token })).body.rides.length, 0, '출발지가 멀면 제외');
    assert.equal((await api('GET', q(SEOUL_STN, GANGNAM, inMin(t + 30)), { token: host.token })).body.rides.length, 0, '내 방은 제외');
  });

  test('비슷한 방이 생기면 기존 방장에게 알림 → 방장이 합치면 멤버 전원이 옮겨감', async () => {
    const t = nextSlot();
    const [a, b, c] = [await signup(), await signup(), await signup()];
    const rideB = (await api('POST', '/rides', { token: b.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 30) } })).body.ride;
    await api('POST', `/rides/${rideB.id}/join`, { token: c.token });
    const rideA = (await api('POST', '/rides', { token: a.token, body: { origin: SEOUL_NEAR, destination: MIDWAY, departAt: inMin(t + 40) } })).body.ride;
    await settle();
    assert.ok((await notes(b)).some((n) => n.type === 'similar' && n.rideId === rideB.id), '먼저 있던 방 방장에게 알림');

    // 도착지(중간 지점)가 강남역 방의 경로 위에 있으면 합칠 수 있는 방으로 나온다 (합치면 가는 길 하차)
    assert.ok((await api('GET', `/rides/${rideA.id}/similar`, { token: a.token })).body.rides.some((r) => r.id === rideB.id));
    await api('POST', `/rides/${rideA.id}/leave`, { token: a.token });

    const d = await signup();
    const rideD = (await api('POST', '/rides', { token: d.token, body: { origin: SEOUL_NEAR, destination: GANGNAM_NEAR, departAt: inMin(t + 25) } })).body.ride;
    const similar = await api('GET', `/rides/${rideD.id}/similar`, { token: d.token });
    assert.ok(similar.body.rides.some((r) => r.id === rideB.id));
    assert.equal((await api('POST', `/rides/${rideD.id}/merge`, { token: c.token, body: { targetId: rideB.id } })).status, 403, '방장만');

    const merged = await api('POST', `/rides/${rideD.id}/merge`, { token: d.token, body: { targetId: rideB.id } });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));
    assert.equal(merged.body.ride.id, rideB.id);
    assert.equal(merged.body.ride.memberCount, 3);
    const moved = merged.body.ride.members.find((m) => m.id === d.user.id);
    assert.equal(moved.dropoff.name, '역삼역', '다른 도착지는 하차 지점으로');
    assert.ok(moved.seat);
    assert.equal((await api('GET', `/rides/${rideD.id}`, { token: d.token })).body.ride.status, 'cancelled');
    await settle();
    assert.ok((await notes(b)).some((n) => n.type === 'join' && n.body.includes('비슷한 방')));
  });

  test('자리가 모자라거나 성별이 다르면 합칠 수 없음', async () => {
    const t = nextSlot();
    const host = await signup();
    const full = (await api('POST', '/rides', { token: host.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 30), maxSeats: 2 } })).body.ride;
    await api('POST', `/rides/${full.id}/join`, { token: (await signup()).token });
    const other = await signup();
    const mine = (await api('POST', '/rides', { token: other.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 35) } })).body.ride;
    assert.equal((await api('POST', `/rides/${mine.id}/merge`, { token: other.token, body: { targetId: full.id } })).status, 409);

    const woman = await signup('female');
    const hers = (await api('POST', '/rides', { token: woman.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMin(t + 40) } })).body.ride;
    assert.equal((await api('POST', `/rides/${hers.id}/merge`, { token: woman.token, body: { targetId: mine.id } })).status, 403);
  });
});

describe('수요 표시', () => {
  test('검색 결과에 이 경로를 찾는 다른 사람 수 (매칭 대기 + 경로 알림, 나 제외)', async () => {
    const t = nextSlot();
    const [w1, w2, alerter, me] = [await signup(), await signup('female'), await signup(), await signup()];
    await request(w1, { origin: JAMSIL, destination: GANGNAM, from: inMin(t), to: inMin(t + 30) });
    await request(w2, { origin: JAMSIL, destination: GANGNAM_NEAR, from: inMin(t), to: inMin(t + 30) });
    await api('POST', '/alerts', { token: alerter.token, body: { origin: JAMSIL, destination: GANGNAM, from: inMin(t), to: inMin(t + 60) } });
    await request(me, { origin: JAMSIL, destination: GANGNAM, from: inMin(t + 200), to: inMin(t + 230) });
    const q = `/rides?originLat=${JAMSIL.lat}&originLng=${JAMSIL.lng}&destLat=${GANGNAM.lat}&destLng=${GANGNAM.lng}&from=${encodeURIComponent(inMin(t))}&to=${encodeURIComponent(inMin(t + 30))}`;
    assert.equal((await api('GET', q, { token: me.token })).body.demand, 3);
    assert.equal((await api('GET', '/rides', { token: me.token })).body.demand, null, '경로 없이 검색하면 표시 안 함');
    assert.equal(matcher.demand({ origin: HONGDAE, destination: SEOUL_STN }, me.user.id), 0);
  });
});
