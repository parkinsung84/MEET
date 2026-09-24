import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { identity } from './helpers.js';

// 서울역 → 강남역 (직선 경로의 중간 지점은 '가는 길 하차' 매칭 대상)
const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };
const MIDWAY = { name: '중간 지점', lat: 37.5263, lng: 126.99915 };
const HONGDAE = { name: '홍대입구역', lat: 37.5572, lng: 126.9245 };
const MIN = 60_000;
const inMinutes = (m) => new Date(Date.now() + m * MIN).toISOString();

const pushes = [];
const fakePush = {
  publicKey: 'test-vapid-public-key',
  async send(subscription, payload) {
    pushes.push({ endpoint: subscription.endpoint, payload });
    return { expired: subscription.endpoint.includes('expired') };
  },
};

let server;
let baseUrl;
let tick;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
/** 가입 → 휴대폰 인증 (+ 학교/회사 메일이면 소속 인증까지) */
async function signup({ gender = 'male', domain = 'test.com', verify = true, verifyEmail = true } = {}) {
  seq += 1;
  const res = await api('POST', '/auth/register', {
    body: { email: `flow${seq}@${domain}`, password: 'password123', nickname: `사용자${seq}`, gender, ...identity() },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { token, devCode } = res.body;
  if (!verify) return { token, user: res.body.user, devCode };
  const verified = await api('POST', '/auth/phone/verify', { token, body: { code: devCode } });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  let { user } = verified.body;
  if (verifyEmail && user.orgCandidate) {
    const sent = await api('POST', '/auth/email/send', { token });
    ({ user } = (await api('POST', '/auth/email/verify', { token, body: { code: sent.body.devCode } })).body);
  }
  return { token, user };
}

async function createRide(host, overrides = {}) {
  const res = await api('POST', '/rides', {
    token: host.token,
    body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMinutes(60), maxSeats: 4, ...overrides },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.ride;
}

const join = (user, rideId, body = {}) => api('POST', `/rides/${rideId}/join`, { token: user.token, body });
const notificationsOf = async (user) => (await api('GET', '/notifications', { token: user.token })).body;
const q = (params) => `?${new URLSearchParams(params)}`;

before(async () => {
  let app;
  ({ server, tick, ...app } = createApp({ secret: 'flow-secret', push: fakePush }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('본인정보·휴대폰 인증', () => {
  const register = (body) => api('POST', '/auth/register', {
    body: { email: `id${++seq}@test.com`, password: 'password123', nickname: '테스트', gender: 'female', ...body },
  });

  test('휴대폰 인증 전에는 합승을 만들거나 참여할 수 없다', async () => {
    const user = await signup({ verify: false });
    assert.equal(user.user.verified, false);
    assert.equal(user.user.identityComplete, true);
    const res = await api('POST', '/rides', {
      token: user.token,
      body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMinutes(60) },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /휴대폰/);
  });

  test('가입 시 본인정보 검증: 이름·생년월일·휴대폰·만 19세 이상', async () => {
    const adult = new Date();
    adult.setFullYear(adult.getFullYear() - 19);
    const minor = new Date(adult.getTime() + 2 * 86400000);
    const ymd = (d) => d.toISOString().slice(0, 10);
    assert.equal((await register(identity({ name: '김' }))).status, 400);
    assert.equal((await register(identity({ name: '홍길동1' }))).status, 400);
    assert.equal((await register(identity({ birthDate: '1995-02-30' }))).status, 400);
    assert.equal((await register(identity({ phone: '02-123-4567' }))).status, 400);
    const underage = await register(identity({ birthDate: ymd(minor) }));
    assert.equal(underage.status, 400);
    assert.match(underage.body.error, /만 19세/);
    assert.equal((await register(identity({ birthDate: ymd(new Date(adult.getTime() - 86400000)) }))).status, 201);
  });

  test('인증된 휴대폰 번호로는 다른 계정을 만들 수 없다', async () => {
    const info = identity();
    const first = await register(info);
    await api('POST', '/auth/phone/verify', { token: first.body.token, body: { code: first.body.devCode } });
    const dup = await register({ ...info, phone: info.phone.replace(/-/g, '') });
    assert.equal(dup.status, 409);
  });

  test('잘못된 코드 5회 초과 시 재발급 필요, 재발송은 1분 쿨다운', async () => {
    const user = await signup({ verify: false });
    for (let i = 0; i < 5; i++) {
      assert.equal((await api('POST', '/auth/phone/verify', { token: user.token, body: { code: '000000x' } })).status, 400);
    }
    const blocked = await api('POST', '/auth/phone/verify', { token: user.token, body: { code: user.devCode } });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /시도 횟수/);
    assert.equal((await api('POST', '/auth/phone/send', { token: user.token })).status, 429);
  });

  test('기존 가입자는 본인정보를 입력하고 인증, 인증 후에는 수정 불가', async () => {
    const user = await signup({ verify: false });
    // 번호를 바꿔도 계정 기준 재발송 대기시간은 그대로 (번호 바꿔가며 문자 폭탄 방지)
    const set = await api('PUT', '/auth/identity', { token: user.token, body: identity({ name: '김철수' }) });
    assert.equal(set.status, 429);
    assert.equal((await api('GET', '/auth/me', { token: user.token })).body.user.name, '김철수', '정보 저장은 됨');
    // 이전 번호로 받은 인증번호는 새 번호에 쓸 수 없음
    const stale = await api('POST', '/auth/phone/verify', { token: user.token, body: { code: user.devCode } });
    assert.equal(stale.status, 400);
    const other = await signup({ verify: false });
    const updated = await api('PUT', '/auth/identity', { token: other.token, body: { name: 'x' } });
    assert.equal(updated.status, 400);
    const done = await api('POST', '/auth/phone/verify', { token: other.token, body: { code: other.devCode } });
    assert.equal(done.body.user.verified, true);
    assert.equal((await api('PUT', '/auth/identity', { token: other.token, body: identity() })).status, 409);
  });

  test('본인정보는 본인에게만: 다른 사용자에게는 닉네임·성별만', async () => {
    const me = await signup({ gender: 'female' });
    const mine = (await api('GET', '/auth/me', { token: me.token })).body.user;
    assert.equal(mine.name, '홍길동');
    assert.match(mine.phone, /^010-\*\*\*\*-\d{4}$/, '내 번호도 가려서 보여줌');
    const viewer = await signup();
    const { user } = (await api('GET', `/users/${me.user.id}`, { token: viewer.token })).body;
    assert.equal(user.gender, 'female');
    for (const key of ['name', 'phone', 'birthDate', 'email']) assert.equal(user[key], undefined, key);
  });

  test('학교/회사 메일은 이메일 인증 시 소속으로 인정, 공용 메일은 아님', async () => {
    const student = await signup({ domain: 'snu.ac.kr' });
    assert.equal(student.user.org, 'snu.ac.kr');
    const notYet = await signup({ domain: 'yonsei.ac.kr', verifyEmail: false });
    assert.equal(notYet.user.org, null);
    assert.equal(notYet.user.orgCandidate, 'yonsei.ac.kr');
    const gmail = await signup({ domain: 'gmail.com' });
    assert.equal(gmail.user.orgCandidate, null);
    assert.equal(gmail.user.org, null);
  });
});

describe('시간·경로 검색', () => {
  test('시간 범위로 거르고, 시간이 가까운 순으로 정렬', async () => {
    const soon = await createRide(await signup(), { departAt: inMinutes(20), origin: { ...SEOUL_STN, name: '서울역A' } });
    const later = await createRide(await signup(), { departAt: inMinutes(300), origin: { ...SEOUL_STN, name: '서울역B' } });
    const viewer = await signup();
    const base = { originLat: SEOUL_STN.lat, originLng: SEOUL_STN.lng, radiusKm: 1 };

    const now = await api('GET', `/rides${q({ ...base, from: inMinutes(0), to: inMinutes(30) })}`, { token: viewer.token });
    const nowIds = now.body.rides.map((r) => r.id);
    assert.ok(nowIds.includes(soon.id));
    assert.ok(!nowIds.includes(later.id));

    const around = await api('GET', `/rides${q({ ...base, from: inMinutes(240), to: inMinutes(360) })}`, { token: viewer.token });
    const ids = around.body.rides.map((r) => r.id);
    assert.ok(ids.includes(later.id) && !ids.includes(soon.id));
  });

  test('가는 길에 내리는 사람도 매칭되고, 예상 부담금이 더 적다', async () => {
    const ride = await createRide(await signup(), { departAt: inMinutes(600) });
    const viewer = await signup();
    const { body } = await api('GET', `/rides${q({
      originLat: SEOUL_STN.lat, originLng: SEOUL_STN.lng, destLat: MIDWAY.lat, destLng: MIDWAY.lng,
      radiusKm: 1, from: inMinutes(590), to: inMinutes(610),
    })}`, { token: viewer.token });
    const found = body.rides.find((r) => r.id === ride.id);
    assert.ok(found, '경로 중간 도착지로도 검색돼야 함');
    assert.equal(found.match.type, 'onTheWay');
    assert.ok(Math.abs(found.match.t - 0.5) < 0.05);
    // 방장과 둘이 끝까지 가면 1/2, 절반만 가면 1/4
    assert.ok(found.fare.mine < found.fare.total / 2);

    // 반대 방향(홍대)은 매칭되지 않음
    const other = await api('GET', `/rides${q({
      originLat: SEOUL_STN.lat, originLng: SEOUL_STN.lng, destLat: HONGDAE.lat, destLng: HONGDAE.lng, radiusKm: 1,
    })}`, { token: viewer.token });
    assert.ok(!other.body.rides.some((r) => r.id === ride.id));
  });

  test('하차 지점에 따라 요금을 거리 비례로 나누고, 경로에서 먼 하차 지점은 거절', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(700) });
    const rider = await signup();
    assert.equal((await join(rider, ride.id, { dropoff: HONGDAE })).status, 400);

    const res = await join(rider, ride.id, { dropoff: MIDWAY });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { shares, total } = res.body.ride.fare;
    // 앞 절반은 둘이 나누고 뒤 절반은 방장 혼자: 방장 3/4, 중간 하차 1/4
    assert.ok(Math.abs(shares[rider.user.id] - total / 4) <= 100, JSON.stringify(shares));
    assert.ok(Math.abs(shares[host.user.id] - (total * 3) / 4) <= 100);
    assert.equal(res.body.ride.members.find((m) => m.id === rider.user.id).dropoff.name, '중간 지점');
  });

  test('비슷한 시간에 다른 합승에 이미 참여 중이면 참여 불가', async () => {
    const a = await createRide(await signup(), { departAt: inMinutes(800) });
    const b = await createRide(await signup(), { departAt: inMinutes(830) });
    const user = await signup();
    assert.equal((await join(user, a.id)).status, 200);
    const res = await join(user, b.id);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /비슷한 시간/);
  });
});

describe('만남·체크인·노쇼', () => {
  test('만남 장소 지정/변경, 체크인은 출발 1시간 전부터', async () => {
    const host = await signup();
    const far = await createRide(host, { departAt: inMinutes(180), meetingPoint: '2번 출구 택시승강장' });
    assert.equal(far.meetingPoint, '2번 출구 택시승강장');
    assert.equal((await api('POST', `/rides/${far.id}/arrive`, { token: host.token })).status, 409);

    const guest = await signup();
    await join(guest, far.id);
    const moved = await api('PATCH', `/rides/${far.id}/meeting-point`, { token: host.token, body: { meetingPoint: '1번 출구' } });
    assert.equal(moved.body.ride.meetingPoint, '1번 출구');
    assert.equal((await api('PATCH', `/rides/${far.id}/meeting-point`, { token: guest.token, body: { meetingPoint: 'x' } })).status, 403);
    // 비멤버에게는 만남 장소를 보여주지 않는다
    const outsider = await signup();
    assert.equal((await api('GET', `/rides/${far.id}`, { token: outsider.token })).body.ride.meetingPoint, null);
    const { notifications } = await notificationsOf(guest);
    assert.ok(notifications.some((n) => n.type === 'meeting' && n.body === '1번 출구'));
  });

  test('도착 체크인하면 다른 멤버에게 알림', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(30) });
    const guest = await signup();
    await join(guest, ride.id);
    const res = await api('POST', `/rides/${ride.id}/arrive`, { token: guest.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.ride.members.find((m) => m.id === guest.user.id).arrived, true);
    const { notifications, unread } = await notificationsOf(host);
    assert.ok(notifications.some((n) => n.type === 'arrive'));
    assert.ok(notifications.some((n) => n.type === 'join'));
    assert.ok(unread >= 2);
    await api('POST', '/notifications/read', { token: host.token });
    assert.equal((await notificationsOf(host)).unread, 0);
  });

  test('출발 10분 전 이후에 나가면 직전 취소로 기록', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(5) });
    const guest = await signup();
    await join(guest, ride.id);
    const res = await api('POST', `/rides/${ride.id}/leave`, { token: guest.token });
    assert.equal(res.body.lateCancel, true);
    const me = await api('GET', '/auth/me', { token: guest.token });
    assert.equal(me.body.user.stats.lateCancels, 1);
  });

  test('출발 시 체크인 안 한 사람만 노쇼 처리할 수 있다', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(20) });
    const arrived = await signup();
    const absent = await signup();
    await join(arrived, ride.id);
    await join(absent, ride.id);
    await api('POST', `/rides/${ride.id}/arrive`, { token: arrived.token });

    const patch = (noShowIds) => api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed', noShowIds } });
    assert.equal((await patch([arrived.user.id])).status, 400);
    const res = await patch([absent.user.id]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ride.memberCount, 2);
    const profile = await api('GET', `/users/${absent.user.id}`, { token: host.token });
    assert.equal(profile.body.user.stats.noShows, 1);
    assert.ok((await notificationsOf(absent)).notifications.some((n) => n.type === 'noshow'));
  });
});

describe('정산·평가', () => {
  test('결제한 사람이 요금을 입력하면 몫을 계산하고, 송금 완료를 추적한다', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(15) });
    const a = await signup();
    const b = await signup();
    await join(a, ride.id);
    await join(b, ride.id, { dropoff: MIDWAY });

    const settle = (user, body) => api('POST', `/rides/${ride.id}/settlement`, { token: user.token, body });
    assert.equal((await settle(host, { actualFare: 12000, account: '토스 1000-1234' })).status, 409, '출발 전 정산 불가');
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed' } });
    assert.equal((await settle(host, { actualFare: 12000 })).status, 400, '계좌 필수');

    const res = await settle(host, { actualFare: 12000, account: '토스 1000-1234' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { settlement } = res.body.ride;
    const share = (id) => settlement.shares.find((s) => s.userId === id);
    // 앞 절반 6000원을 셋이, 뒤 절반 6000원을 둘이 나눈다
    // (중간 지점이 경로의 정확히 50%는 아니라서 10원 단위 오차 허용)
    assert.ok(Math.abs(share(b.user.id).amount - 2000) <= 20, JSON.stringify(settlement.shares));
    assert.ok(Math.abs(share(a.user.id).amount - 5000) <= 20);
    assert.equal(share(host.user.id).paid, true, '결제한 사람은 이미 낸 것');
    assert.equal(settlement.allPaid, false);
    assert.equal((await settle(a, { actualFare: 10000, account: 'x' })).status, 409, '다른 사람이 이미 정산 요청');

    const requested = (await notificationsOf(a)).notifications.find((n) => n.type === 'settle');
    assert.match(requested.body, /4,9\d0원|5,0\d0원/);
    assert.match(requested.body, /토스 1000-1234/);

    await api('POST', `/rides/${ride.id}/settlement/paid`, { token: a.token });
    assert.ok((await notificationsOf(host)).notifications.some((n) => n.type === 'paid'));
    assert.equal((await api('POST', `/rides/${ride.id}/settlement/paid`, { token: a.token, body: { userId: b.user.id } })).status, 403);
    const done = await api('POST', `/rides/${ride.id}/settlement/paid`, { token: host.token, body: { userId: b.user.id } });
    assert.equal(done.body.ride.settlement.allPaid, true);
    assert.ok((await notificationsOf(b)).notifications.some((n) => n.type === 'settled'));

    const outsider = await signup();
    assert.equal((await api('GET', `/rides/${ride.id}`, { token: outsider.token })).body.ride.settlement, null, '계좌는 멤버에게만');
  });

  test('도착 완료 후 동승자 평가, 3건 이상부터 매너 점수 표시', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(15) });
    const riders = [await signup(), await signup(), await signup()];
    for (const r of riders) await join(r, ride.id);
    const rate = (user, ratings) => api('POST', `/rides/${ride.id}/ratings`, { token: user.token, body: { ratings } });

    assert.equal((await rate(riders[0], [{ userId: host.user.id, good: true }])).status, 409);
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed' } });
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'completed' } });

    assert.equal((await rate(riders[0], [{ userId: riders[0].user.id, good: true }])).status, 400, '자기 평가 불가');
    await rate(riders[0], [{ userId: host.user.id, good: true }]);
    await rate(riders[1], [{ userId: host.user.id, good: true }]);
    let profile = (await api('GET', `/users/${host.user.id}`, { token: riders[0].token })).body.user;
    assert.equal(profile.stats.mannerPercent, null);
    await rate(riders[2], [{ userId: host.user.id, good: false }]);
    // 같은 사람이 다시 평가하면 덮어쓴다
    const again = await rate(riders[2], [{ userId: host.user.id, good: true }]);
    assert.deepEqual(again.body.myRatings, [{ userId: host.user.id, good: true }]);
    profile = (await api('GET', `/users/${host.user.id}`, { token: riders[0].token })).body.user;
    assert.equal(profile.stats.mannerPercent, 100);
    assert.equal(profile.stats.ratings, 3);
    assert.equal(profile.stats.completedRides, 1);
  });
});

describe('차단·신고·소속 전용', () => {
  test('차단하면 서로의 합승이 보이지 않고 참여할 수 없다', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(900) });
    const blocker = await signup();
    await api('POST', `/users/${host.user.id}/block`, { token: blocker.token });

    const search = await api('GET', `/rides${q({ from: inMinutes(890), to: inMinutes(910) })}`, { token: blocker.token });
    assert.ok(!search.body.rides.some((r) => r.id === ride.id));
    assert.equal((await join(blocker, ride.id)).status, 403);
    assert.deepEqual((await api('GET', '/users/blocked', { token: blocker.token })).body.users.map((u) => u.id), [host.user.id]);

    await api('DELETE', `/users/${host.user.id}/block`, { token: blocker.token });
    assert.equal((await join(blocker, ride.id)).status, 200);
  });

  test('신고 접수', async () => {
    const a = await signup();
    const b = await signup();
    assert.equal((await api('POST', `/users/${b.user.id}/report`, { token: a.token, body: { reason: '' } })).status, 400);
    assert.equal((await api('POST', `/users/${b.user.id}/report`, { token: a.token, body: { reason: '노쇼 후 연락 두절' } })).status, 201);
  });

  test('소속 전용 합승은 같은 학교/회사 인증 사용자만', async () => {
    const gmailHost = await signup({ domain: 'gmail.com' });
    const denied = await api('POST', '/rides', {
      token: gmailHost.token,
      body: { origin: SEOUL_STN, destination: GANGNAM, departAt: inMinutes(1000), orgOnly: true },
    });
    assert.equal(denied.status, 400);

    const host = await signup({ domain: 'korea.ac.kr' });
    const ride = await createRide(host, { departAt: inMinutes(1000), orgOnly: true });
    assert.equal(ride.orgOnly, 'korea.ac.kr');
    const outsider = await signup({ domain: 'gmail.com' });
    const peer = await signup({ domain: 'korea.ac.kr' });
    const window = q({ from: inMinutes(990), to: inMinutes(1010) });
    assert.ok(!(await api('GET', `/rides${window}`, { token: outsider.token })).body.rides.some((r) => r.id === ride.id));
    assert.ok((await api('GET', `/rides${window}`, { token: peer.token })).body.rides.some((r) => r.id === ride.id));
    assert.equal((await join(outsider, ride.id)).status, 403);
    assert.equal((await join(peer, ride.id)).status, 200);
  });
});

describe('알림', () => {
  test('경로 알림: 조건에 맞는 합승이 생기면 알려준다', async () => {
    const watcher = await signup();
    const created = await api('POST', '/alerts', {
      token: watcher.token,
      body: { origin: SEOUL_STN, destination: MIDWAY, from: inMinutes(1100), to: inMinutes(1200), radiusKm: 1 },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((await api('GET', '/alerts', { token: watcher.token })).body.alerts.length, 1);

    // 시간이 안 맞는 방, 경로가 안 맞는 방, 맞는 방(가는 길 하차)
    await createRide(await signup(), { departAt: inMinutes(1300) });
    await createRide(await signup(), { departAt: inMinutes(1150), destination: HONGDAE });
    const match = await createRide(await signup(), { departAt: inMinutes(1150) });

    const alerts = (await notificationsOf(watcher)).notifications.filter((n) => n.type === 'alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].rideId, match.id);
    assert.equal(alerts[0].url, `/#/rides/${match.id}`);

    await api('DELETE', `/alerts/${created.body.alert.id}`, { token: watcher.token });
    assert.equal((await api('GET', '/alerts', { token: watcher.token })).body.alerts.length, 0);
  });

  test('웹 푸시 구독 후 알림이 푸시로도 발송되고, 만료된 구독은 정리된다', async () => {
    const host = await signup();
    const sub = (endpoint) => ({ subscription: { endpoint, keys: { p256dh: 'p', auth: 'a' } } });
    assert.equal((await api('POST', '/notifications/push', { token: host.token, body: { subscription: {} } })).status, 400);
    await api('POST', '/notifications/push', { token: host.token, body: sub('https://push.example/host-1') });
    await api('POST', '/notifications/push', { token: host.token, body: sub('https://push.example/expired-1') });
    const config = await api('GET', '/config');
    assert.equal(config.body.vapidPublicKey, 'test-vapid-public-key');

    const ride = await createRide(host, { departAt: inMinutes(1400) });
    pushes.length = 0;
    await join(await signup(), ride.id);
    await new Promise((r) => setTimeout(r, 50));
    const sent = pushes.filter((p) => p.endpoint.includes('host-1'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.url, `/#/rides/${ride.id}`);
    assert.match(sent[0].payload.title, /새 동승자/);

    // 만료된 구독은 첫 발송 실패 후 삭제되어 다시 시도하지 않는다
    pushes.length = 0;
    await join(await signup(), ride.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!pushes.some((p) => p.endpoint.includes('expired')));
  });
});

describe('주기 작업', () => {
  test('출발 10분 전 알림 → 30분 지나도 출발 처리 안 되면 정리', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(2000), meetingPoint: '3번 출구' });
    const guest = await signup();
    await join(guest, ride.id);
    const departAt = new Date(ride.departAt).getTime();

    tick(departAt - 20 * MIN);
    assert.ok(!(await notificationsOf(guest)).notifications.some((n) => n.type === 'reminder'));
    tick(departAt - 9 * MIN);
    tick(departAt - 8 * MIN); // 중복 발송 없음
    const reminders = (await notificationsOf(guest)).notifications.filter((n) => n.type === 'reminder' && n.rideId === ride.id);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0].body, /3번 출구/);

    // 아무도 체크인하지 않았으므로 취소
    tick(departAt + 31 * MIN);
    assert.equal((await api('GET', `/rides/${ride.id}`, { token: host.token })).body.ride.status, 'cancelled');
  });

  test('2명 이상 체크인했으면 자동 출발 → 3시간 뒤 자동 도착 완료', async () => {
    const host = await signup();
    const ride = await createRide(host, { departAt: inMinutes(40) });
    const guest = await signup();
    await join(guest, ride.id);
    await api('POST', `/rides/${ride.id}/arrive`, { token: host.token });
    await api('POST', `/rides/${ride.id}/arrive`, { token: guest.token });
    const departAt = new Date(ride.departAt).getTime();

    tick(departAt + 31 * MIN);
    assert.equal((await api('GET', `/rides/${ride.id}`, { token: host.token })).body.ride.status, 'departed');
    tick(departAt + 181 * MIN);
    assert.equal((await api('GET', `/rides/${ride.id}`, { token: host.token })).body.ride.status, 'completed');
    assert.ok((await notificationsOf(guest)).notifications.some((n) => n.type === 'completed' && n.rideId === ride.id));
  });
});
