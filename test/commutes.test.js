import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { daysLabel, kstInstant, kstParts, nextRun } from '../src/commutes.js';
import { identity, relaxedLimits } from './helpers.js';

// 정기 노선(출퇴근 택시 크루): 공개 목록 → 참여 → 크루 채팅 → 운행일에 합승방 자동 생성

// 서울 행정동 코드
const YEOKSAM1 = '1168064000';   // 강남구 역삼1동
const YEOKSAM2 = '1168065000';   // 강남구 역삼2동 (역삼1동과 약 0.9km)
const JONGNO = '1111061500';     // 종로구 종로1·2·3·4가동
const SEOGYO = '1144066000';     // 마포구 서교동
const JAMSIL = '1171065000';     // 송파구 잠실본동
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const ALL_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

let server;
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
    body: { email: `commute${seq}@test.com`, password: 'password123', nickname: `출근${seq}`, gender, ...identity() },
  });
  const { token, devCode } = res.body;
  const { user } = (await api('POST', '/auth/phone/verify', { token, body: { code: devCode } })).body;
  return { token, user };
}
const post = (u, body) => api('POST', '/commutes', { token: u.token, body: { from: YEOKSAM1, to: JONGNO, days: WEEKDAYS, departTime: '08:00', ...body } });

before(async () => {
  ({ server, tick } = createApp({ secret: 'commute-secret', push: null, authLimits: relaxedLimits() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('시간·표시 도우미', () => {
  test('한국 시간 기준 날짜·요일, 다음 운행일', () => {
    // 2026-09-25(금) 23:30 KST = 14:30 UTC
    const now = Date.UTC(2026, 8, 25, 14, 30);
    assert.deepEqual(kstParts(now), { date: '2026-09-25', dayKey: 'fri', minutes: 23 * 60 + 30 });
    assert.equal(new Date(kstInstant('2026-09-28', '08:00')).toISOString(), '2026-09-27T23:00:00.000Z');
    // 금요일 밤 → 다음 평일 08:00 은 월요일
    assert.equal(nextRun(31, '08:00', now).date, '2026-09-28');
    assert.equal(daysLabel(31), '월~금');
    assert.equal(daysLabel(1 | 4 | 16), '월·수·금');
  });
});

describe('정기 노선', () => {
  test('동을 골라 크루를 만들면 로그인 없이도 보이고, 만남 장소는 멤버에게만', async () => {
    const owner = await signup();
    const res = await post(owner, { memo: '역삼역 근처 회사 다녀요', meetingPoint: '역삼역 3번 출구' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const c = res.body.commute;
    assert.equal(c.daysLabel, '월~금');
    assert.equal(c.memberCount, 1);
    assert.equal(c.origin.area, '강남구 역삼1동');
    assert.equal(c.destination.area, '종로구 종로1·2·3·4가동');
    assert.equal(c.meetingPoint, '역삼역 3번 출구');
    assert.ok(c.fare.total > 10000 && c.fare.perPerson < c.fare.total);

    const pub = (await api('GET', '/commutes')).body.commutes.find((x) => x.id === c.id);
    assert.equal(pub.origin.code, YEOKSAM1);
    assert.equal(pub.meetingPoint, undefined, '만남 장소는 멤버에게만');
    const detail = (await api('GET', `/commutes/${c.id}`)).body.commute;
    assert.equal(detail.origin.lat, undefined);
    assert.equal(detail.owner.nickname, owner.user.nickname);
  });

  test('미리 깔린 노선: 아무 동 조합이나 열리고, 그 노선의 크루와 이웃 동 크루를 보여준다', async () => {
    const owner = await signup();
    const c = (await post(owner, { from: YEOKSAM1, to: SEOGYO, departTime: '07:50' })).body.commute;
    const exact = (await api('GET', `/commutes/routes/${YEOKSAM1}/${SEOGYO}`)).body.route;
    assert.equal(exact.from.dong, '역삼1동');
    assert.equal(exact.to.gu, '마포구');
    assert.ok(exact.fare.total > 0 && exact.distanceKm > 5);
    assert.ok(exact.commutes.some((x) => x.id === c.id));
    // 바로 옆 동(역삼2동)에서 출발하는 노선에서는 '이웃 노선'으로
    const neighbor = (await api('GET', `/commutes/routes/${YEOKSAM2}/${SEOGYO}`)).body.route;
    assert.ok(!neighbor.commutes.some((x) => x.id === c.id));
    assert.ok(neighbor.nearby.some((x) => x.id === c.id));
    // 크루가 없는 노선도 열린다
    const empty = (await api('GET', `/commutes/routes/${JAMSIL}/${SEOGYO}`)).body.route;
    assert.equal(empty.commutes.length, 0);
    assert.equal((await api('GET', `/commutes/routes/${JAMSIL}/${JAMSIL}`)).status, 400);
    assert.equal((await api('GET', '/commutes/routes/123/456')).status, 400);
    // 동 코드로 목록 거르기, 인기 노선
    const list = (await api('GET', `/commutes?from=${YEOKSAM1}&to=${SEOGYO}`)).body.commutes;
    assert.ok(list.length >= 1 && list.every((x) => x.origin.code === YEOKSAM1 && x.destination.code === SEOGYO));
    const { routes } = (await api('GET', '/commutes/routes/popular')).body;
    assert.ok(routes.some((r) => r.from.code === YEOKSAM1 && r.to.code === SEOGYO));
  });

  test('시각·요일로 찾기: ±30분, 겹치는 요일', async () => {
    const owner = await signup();
    const c = (await post(owner, { from: JAMSIL, to: JONGNO, departTime: '07:40', days: ['mon', 'wed'] })).body.commute;
    const find = async (q) => (await api('GET', `/commutes?${new URLSearchParams({ from: JAMSIL, to: JONGNO, ...q })}`)).body.commutes.some((x) => x.id === c.id);
    assert.ok(await find({}));
    assert.ok(await find({ time: '08:05', days: 'wed,fri' }));
    assert.ok(!(await find({ time: '08:30' })), '50분 차이');
    assert.ok(!(await find({ days: 'tue,thu' })), '요일 안 겹침');
  });

  test('참여·나가기, 정원·성별 조건, 만든 사람이 나가면 넘겨줌', async () => {
    const owner = await signup('female');
    const c = (await post(owner, { maxSeats: 2, genderPref: 'female' })).body.commute;
    const man = await signup('male');
    assert.equal((await api('POST', `/commutes/${c.id}/join`, { token: man.token })).status, 409);
    const woman = await signup('female');
    const joined = await api('POST', `/commutes/${c.id}/join`, { token: woman.token });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.commute.joined, true);
    assert.equal(joined.body.commute.meetingPoint, '강남구 역삼1동', '만남 장소를 따로 안 정하면 출발 동');
    assert.equal((await api('POST', `/commutes/${c.id}/join`, { token: (await signup('female')).token })).status, 409, '정원 초과');
    // 만든 사람이 나가면 다음 멤버가 넘겨받음
    await api('POST', `/commutes/${c.id}/leave`, { token: owner.token });
    const after = (await api('GET', `/commutes/${c.id}`, { token: woman.token })).body.commute;
    assert.equal(after.isOwner, true);
    assert.equal(after.memberCount, 1);
  });

  test('크루 채팅은 멤버만, 만든 사람은 일정 수정·멤버 내보내기', async () => {
    const owner = await signup();
    const c = (await post(owner)).body.commute;
    const member = await signup();
    await api('POST', `/commutes/${c.id}/join`, { token: member.token });
    const outsider = await signup();
    assert.equal((await api('POST', `/commutes/${c.id}/messages`, { token: outsider.token, body: { body: '안녕' } })).status, 403);
    assert.equal((await api('POST', `/commutes/${c.id}/messages`, { token: member.token, body: { body: '내일 5분 늦어요' } })).status, 201);
    const { messages } = (await api('GET', `/commutes/${c.id}/messages`, { token: owner.token })).body;
    assert.equal(messages.at(-1).body, '내일 5분 늦어요');

    assert.equal((await api('PATCH', `/commutes/${c.id}`, { token: member.token, body: { departTime: '08:10' } })).status, 403);
    const edited = (await api('PATCH', `/commutes/${c.id}`, { token: owner.token, body: { departTime: '08:10', days: ['mon', 'tue'] } })).body.commute;
    assert.equal(edited.departTime, '08:10');
    assert.equal(edited.daysLabel, '월·화');
    const removed = await api('DELETE', `/commutes/${c.id}/members/${member.user.id}`, { token: owner.token });
    assert.equal(removed.body.commute.memberCount, 1);
    const notes = (await api('GET', '/notifications', { token: member.token })).body.notifications;
    assert.ok(notes.some((n) => n.type === 'commute_update'));
  });

  test('운행일 출발 1시간 전에 멤버들로 합승방이 열린다', async () => {
    // 지금부터 50분 뒤 출발하는 매일 노선
    const soon = kstParts(Date.now() + 50 * 60 * 1000);
    const time = `${String(Math.floor(soon.minutes / 60)).padStart(2, '0')}:${String(soon.minutes % 60).padStart(2, '0')}`;
    const owner = await signup();
    const c = (await post(owner, { from: SEOGYO, to: YEOKSAM1, days: ALL_DAYS, departTime: time })).body.commute;
    const [a, b] = [await signup(), await signup()];
    await api('POST', `/commutes/${c.id}/join`, { token: a.token });
    await api('POST', `/commutes/${c.id}/join`, { token: b.token });
    assert.equal((await api('GET', `/commutes/${c.id}`, { token: a.token })).body.commute.currentRide, null);

    await tick();
    const detail = (await api('GET', `/commutes/${c.id}`, { token: a.token })).body.commute;
    const today = detail.currentRide;
    assert.ok(today?.rideId, '오늘 합승방 생성');
    assert.equal((await api('GET', `/commutes/${c.id}`)).body.commute.currentRide, undefined, '비멤버에게는 안 보임');
    const ride = (await api('GET', `/rides/${today.rideId}`, { token: a.token })).body.ride;
    assert.equal(ride.memberCount, 3);
    assert.equal(ride.hostId, owner.user.id);
    assert.match(ride.memo, /정기 노선/);
    const notes = (await api('GET', '/notifications', { token: b.token })).body.notifications;
    assert.ok(notes.some((n) => n.type === 'commute_trip' && n.rideId === today.rideId));
    // 다시 돌려도 중복 생성 안 함
    await tick();
    assert.equal((await api('GET', '/rides/mine', { token: a.token })).body.rides.filter((r) => /정기 노선/.test(r.memo)).length, 1);
  });

  test('멤버가 1명뿐이면 합승방을 열지 않고 알려 준다', async () => {
    const soon = kstParts(Date.now() + 45 * 60 * 1000);
    const time = `${String(Math.floor(soon.minutes / 60)).padStart(2, '0')}:${String(soon.minutes % 60).padStart(2, '0')}`;
    const owner = await signup();
    const c = (await post(owner, { from: YEOKSAM2, to: SEOGYO, days: ALL_DAYS, departTime: time })).body.commute;
    await tick();
    assert.equal((await api('GET', `/commutes/${c.id}`, { token: owner.token })).body.commute.currentRide, null);
    const notes = (await api('GET', '/notifications', { token: owner.token })).body.notifications;
    assert.ok(notes.some((n) => n.type === 'commute_trip_skipped'));
  });

  test('입력 검증과 로그인 필요', async () => {
    const u = await signup();
    assert.equal((await post(u, { days: [] })).status, 400);
    assert.equal((await post(u, { days: ['xyz'] })).status, 400);
    assert.equal((await post(u, { departTime: '25:00' })).status, 400);
    assert.equal((await post(u, { to: YEOKSAM1 })).status, 400, '같은 동');
    assert.equal((await post(u, { from: '0000000000' })).status, 400, '없는 동');
    assert.equal((await api('POST', '/commutes', { body: {} })).status, 401);
    assert.equal((await api('GET', '/commutes/99999')).status, 404);
  });
});

describe('노선 목록', () => {
  test('조건 없이 부르면 전체 노선, 위치는 거르지 않고 가까운 순으로 정렬만', async () => {
    const u = await signup();
    const far = (await post(u, { from: SEOGYO, to: JONGNO, departTime: '09:00' })).body.commute;
    const all = (await api('GET', '/commutes')).body.commutes;
    assert.ok(all.some((c) => c.id === far.id));
    // 역삼1동 근처 위치
    const sorted = (await api('GET', '/commutes?nearLat=37.4959&nearLng=127.0330')).body.commutes;
    assert.equal(sorted.length, all.length, '거르지 않음');
    const farIndex = sorted.findIndex((c) => c.id === far.id);
    const nearIndex = sorted.findIndex((c) => c.origin.code === YEOKSAM1 && c.seatsLeft > 0);
    assert.ok(nearIndex < farIndex, '역삼 출발 노선이 서교동 출발보다 먼저');
  });
});

describe('노선 채팅', () => {
  test('같은 노선에 관심 있는 누구나 로그인하면 읽고 쓸 수 있고, 노선마다 따로다', async () => {
    const [a, b] = [await signup(), await signup()];
    const path = `/commutes/routes/${JAMSIL}/${SEOGYO}/messages`;
    assert.equal((await api('GET', path)).status, 401, '로그인 필요');
    const posted = await api('POST', path, { token: a.token, body: { body: '잠실새내역 4번 출구에서 타면 어때요?' } });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    await api('POST', path, { token: b.token, body: { body: '좋아요! 도착은 홍대입구역 9번 출구로' } });
    const { messages } = (await api('GET', path, { token: b.token })).body;
    assert.deepEqual(messages.slice(-2).map((m) => m.body), ['잠실새내역 4번 출구에서 타면 어때요?', '좋아요! 도착은 홍대입구역 9번 출구로']);
    assert.equal(messages.at(-1).nickname, b.user.nickname);
    // 반대 방향은 다른 채팅방
    const reverse = (await api('GET', `/commutes/routes/${SEOGYO}/${JAMSIL}/messages`, { token: a.token })).body.messages;
    assert.equal(reverse.length, 0);
    assert.equal((await api('POST', path, { token: a.token, body: { body: '  ' } })).status, 400);
    assert.equal((await api('POST', `/commutes/routes/${JAMSIL}/${JAMSIL}/messages`, { token: a.token, body: { body: 'x' } })).status, 400);
  });
});
