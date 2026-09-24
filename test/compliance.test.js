import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { identity, relaxedLimits } from './helpers.js';

// 택시발전법 합승 기준(동성·좌석 안내·긴급신고)과 위치정보 이용·제공 사실 기록

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };
const MIDWAY = { name: '중간 지점', lat: 37.5263, lng: 126.99915 };

let server;
let db;
let tick;
let base;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/api${path}`, {
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
    body: { email: `rule${seq}@test.com`, password: 'password123', nickname: `규칙${seq}`, gender, ...identity() },
  });
  const { token, devCode } = res.body;
  const { user } = (await api('POST', '/auth/phone/verify', { token, body: { code: devCode } })).body;
  return { token, user };
}

let hours = 0;
async function createRide(host, extra = {}) {
  const res = await api('POST', '/rides', {
    token: host.token,
    body: { origin: SEOUL_STN, destination: GANGNAM, departAt: new Date(Date.now() + (hours += 3) * 3600_000).toISOString(), ...extra },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.ride;
}
const join = (u, rideId, body = {}) => api('POST', `/rides/${rideId}/join`, { token: u.token, body });
const logsOf = async (u) => (await api('GET', '/me/location-logs', { token: u.token })).body.logs;

before(async () => {
  ({ server, db, tick } = createApp({ secret: 'rule-secret', push: null, authLimits: relaxedLimits() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('합승 기준: 택시 종류와 성별', () => {
  test('일반 택시(중형 이하)는 "성별 무관"을 요청해도 방장 성별끼리만', async () => {
    const host = await signup('female');
    const ride = await createRide(host, { genderPref: 'any' });
    assert.equal(ride.taxiType, 'standard');
    assert.equal(ride.genderPref, 'female');
    const man = await signup('male');
    const res = await join(man, ride.id);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /같은 성별/);
    const search = await api('GET', '/rides', { token: man.token });
    assert.ok(!search.body.rides.some((r) => r.id === ride.id), '다른 성별에게는 검색되지 않음');
    assert.equal((await join(await signup('female'), ride.id)).status, 200);
  });

  test('대형 택시는 성별 무관 가능, 잘못된 택시 종류는 거절', async () => {
    const host = await signup('female');
    const ride = await createRide(host, { taxiType: 'large' });
    assert.equal(ride.genderPref, 'any');
    assert.equal((await join(await signup('male'), ride.id)).status, 200);
    const bad = await api('POST', '/rides', {
      token: (await signup()).token,
      body: { origin: SEOUL_STN, destination: GANGNAM, departAt: new Date(Date.now() + 3600_000).toISOString(), taxiType: 'bus' },
    });
    assert.equal(bad.status, 400);
  });

  test('예전 데이터(성별 무관 + 일반 택시)도 방장 성별로 적용', async () => {
    const host = await signup('male');
    const ride = await createRide(host);
    db.prepare("UPDATE rides SET gender_pref = 'any' WHERE id = ?").run(ride.id);
    assert.equal((await join(await signup('female'), ride.id)).status, 403);
  });
});

describe('합승 기준: 좌석 안내', () => {
  test('참여 순서대로 좌석 자동 배정, 탑승 전 변경, 다른 사람 자리는 불가', async () => {
    const host = await signup();
    const ride = await createRide(host);
    const [a, b] = [await signup(), await signup()];
    await join(a, ride.id);
    const { body } = await join(b, ride.id);
    const seatOf = (r, u) => r.members.find((m) => m.id === u.user.id).seat;
    assert.equal(seatOf(body.ride, host), 'front');
    assert.equal(seatOf(body.ride, a), 'rear_right');
    assert.equal(seatOf(body.ride, b), 'rear_left');

    const setSeat = (u, seat) => api('PUT', `/rides/${ride.id}/seat`, { token: u.token, body: { seat } });
    const taken = await setSeat(b, 'front');
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /조수석/);
    assert.equal((await setSeat(b, 'trunk')).status, 400);
    const moved = await setSeat(b, 'rear_middle');
    assert.equal(seatOf(moved.body.ride, b), 'rear_middle');

    // 누가 나가면 그 자리는 다음 참여자에게
    await api('POST', `/rides/${ride.id}/leave`, { token: a.token });
    const c = await signup();
    assert.equal(seatOf((await join(c, ride.id)).body.ride, c), 'rear_right');

    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed' } });
    assert.equal((await setSeat(c, 'rear_left')).status, 409, '출발 후에는 변경 불가');
  });
});

describe('합승 기준: 긴급 신고', () => {
  test('멤버가 누르면 기록하고 동승자에게 알림, 비멤버·종료된 합승은 불가', async () => {
    const host = await signup();
    const ride = await createRide(host);
    const rider = await signup();
    await join(rider, ride.id);
    await api('PUT', `/rides/${ride.id}/taxi`, { token: rider.token, body: { plate: '서울12가3456' } });

    assert.equal((await api('POST', `/rides/${ride.id}/emergency`, { token: (await signup()).token })).status, 403);
    const res = await api('POST', `/rides/${ride.id}/emergency`, { token: rider.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.taxi.plate, '서울12가3456', '112 문자에 넣을 차량번호');
    assert.equal(res.body.route, '서울역 → 강남역');
    await new Promise((r) => setTimeout(r, 20));
    const { notifications } = (await api('GET', '/notifications', { token: host.token })).body;
    assert.ok(notifications.some((n) => n.type === 'emergency'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ride_emergencies WHERE ride_id = ?').get(ride.id).n, 1);

    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'cancelled' } });
    assert.equal((await api('POST', `/rides/${ride.id}/emergency`, { token: rider.token })).status, 409);
  });

  test('출발 10분 전 알림에 긴급신고 방법 안내', async () => {
    const host = await signup();
    const ride = await createRide(host);
    const rider = await signup();
    await join(rider, ride.id);
    tick(new Date(ride.departAt).getTime() - 9 * 60 * 1000);
    const { notifications } = (await api('GET', '/notifications', { token: rider.token })).body;
    const reminder = notifications.find((n) => n.type === 'reminder' && n.rideId === ride.id);
    assert.match(reminder.body, /긴급 신고/);
  });
});

describe('위치정보 이용·제공 사실 기록', () => {
  test('위치를 이용·제공할 때마다 자동 기록 (좌표는 저장하지 않음), 본인만 열람', async () => {
    const host = await signup();
    const rider = await signup();
    await api('GET', '/places/reverse?lat=37.55&lng=126.97', { token: host.token });
    const ride = await createRide(host);
    await api('GET', `/rides?originLat=37.55&originLng=126.97`, { token: rider.token });
    await api('GET', `/rides?originLat=37.55&originLng=126.97`, { token: rider.token }); // 1분 안 반복 검색은 한 번만
    await join(rider, ride.id, { dropoff: MIDWAY });
    await api('POST', '/alerts', {
      token: rider.token,
      body: { origin: SEOUL_STN, destination: GANGNAM, from: new Date(Date.now() + 60_000).toISOString(), to: new Date(Date.now() + 3600_000).toISOString() },
    });
    const { body } = await api('POST', `/rides/${ride.id}/share`, { token: host.token });
    await api('GET', `/share/${body.token}`);
    await api('GET', `/share/${body.token}`); // 10분 안 반복 조회는 한 번만

    const hostLogs = await logsOf(host);
    assert.deepEqual(hostLogs.map((l) => l.action).sort(), ['reverse_geocode', 'ride_create', 'share_view']);
    assert.equal(hostLogs.find((l) => l.action === 'share_view').recipient, '안심 공유 링크 수신자');
    const riderLogs = await logsOf(rider);
    assert.deepEqual(riderLogs.map((l) => l.action).sort(), ['alert', 'dropoff', 'search']);
    assert.equal(riderLogs.find((l) => l.action === 'dropoff').recipient, '같은 합승 멤버');
    for (const log of [...hostLogs, ...riderLogs]) assert.ok(log.purpose && log.createdAt);
    const columns = db.prepare('PRAGMA table_info(location_usage_logs)').all().map((c) => c.name);
    assert.ok(!columns.some((c) => /lat|lng/.test(c)), '좌표 컬럼 없음');
  });

  test('1년이 지난 기록은 파기, 탈퇴해도 법정 보관 기간 동안 유지', async () => {
    const user = await signup();
    await api('GET', '/places/reverse?lat=37.5&lng=127', { token: user.token });
    db.prepare("INSERT INTO location_usage_logs (user_id, action, purpose, created_at) VALUES (?, 'search', 'old', ?)")
      .run(user.user.id, new Date(Date.now() - 400 * 86400000).toISOString());
    tick();
    assert.equal((await logsOf(user)).length, 1);
    await api('DELETE', '/auth/me', { token: user.token, body: { password: 'password123' } });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM location_usage_logs WHERE user_id = ?').get(user.user.id).n, 1);
  });
});
