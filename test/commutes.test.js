import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { areaLabel, daysLabel, kstInstant, kstParts, nextRun } from '../src/commutes.js';
import { identity, relaxedLimits } from './helpers.js';

// 정기 노선(출퇴근 택시 크루): 공개 목록 → 참여 → 크루 채팅 → 운행일에 합승방 자동 생성

const BUNDANG = { name: '정자역', address: '경기도 성남시 분당구 정자동 7', lat: 37.3670, lng: 127.1085 };
const BUNDANG_NEAR = { name: '정자동 카페', address: '경기도 성남시 분당구 정자동 100', lat: 37.3690, lng: 127.1100 };
const GANGNAM = { name: '강남역', address: '서울특별시 강남구 역삼동 858', lat: 37.4979, lng: 127.0276 };
const GANGNAM_NEAR = { name: '역삼역', address: '서울특별시 강남구 역삼동 804', lat: 37.5006, lng: 127.0364 };
const HONGDAE = { name: '홍대입구역', address: '서울특별시 마포구 동교동', lat: 37.5572, lng: 126.9245 };
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
const post = (u, body) => api('POST', '/commutes', { token: u.token, body: { origin: BUNDANG, destination: GANGNAM, days: WEEKDAYS, departTime: '08:00', ...body } });

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
    assert.equal(areaLabel(BUNDANG), '분당구 정자동');
    assert.equal(areaLabel({ name: '강남역', address: '' }), '강남역');
  });
});

describe('정기 노선', () => {
  test('올리면 로그인 없이도 목록·상세에서 보이고, 정확한 위치는 멤버에게만', async () => {
    const owner = await signup();
    const res = await post(owner, { memo: '매일 정자역 3번 출구에서 타요', meetingPoint: '정자역 3번 출구' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const c = res.body.commute;
    assert.equal(c.daysLabel, '월~금');
    assert.equal(c.memberCount, 1);
    assert.equal(c.origin.name, '정자역', '만든 사람은 정확한 위치를 봄');
    assert.ok(c.fare.total > 10000 && c.fare.perPerson < c.fare.total);

    const list = (await api('GET', '/commutes')).body.commutes;
    const pub = list.find((x) => x.id === c.id);
    assert.equal(pub.origin.area, '분당구 정자동');
    assert.equal(pub.destination.area, '강남구 역삼동');
    assert.equal(pub.origin.name, undefined, '공개 목록에는 정확한 위치 없음');
    assert.equal(pub.meetingPoint, undefined);
    const detail = (await api('GET', `/commutes/${c.id}`)).body.commute;
    assert.equal(detail.origin.lat, undefined);
    assert.equal(detail.owner.nickname, owner.user.nickname);
  });

  test('경로·시각·요일로 찾기: 출발·도착 3km, ±30분, 겹치는 요일', async () => {
    const owner = await signup();
    const c = (await post(owner, { departTime: '07:40', days: ['mon', 'wed'] })).body.commute;
    const find = async (q) => (await api('GET', `/commutes?${new URLSearchParams(q)}`)).body.commutes.some((x) => x.id === c.id);
    const route = { originLat: BUNDANG_NEAR.lat, originLng: BUNDANG_NEAR.lng, destLat: GANGNAM_NEAR.lat, destLng: GANGNAM_NEAR.lng };
    assert.ok(await find(route));
    assert.ok(await find({ ...route, time: '08:05', days: 'wed,fri' }));
    assert.ok(!(await find({ ...route, time: '08:30' })), '50분 차이');
    assert.ok(!(await find({ ...route, days: 'tue,thu' })), '요일 안 겹침');
    assert.ok(!(await find({ ...route, destLat: HONGDAE.lat, destLng: HONGDAE.lng })), '도착지 다름');
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
    assert.equal(joined.body.commute.meetingPoint, '정자역', '만남 장소를 따로 안 정하면 출발지');
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
    const c = (await post(owner, { origin: HONGDAE, destination: GANGNAM, days: ALL_DAYS, departTime: time })).body.commute;
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
    const c = (await post(owner, { origin: GANGNAM, destination: HONGDAE, days: ALL_DAYS, departTime: time })).body.commute;
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
    assert.equal((await post(u, { destination: BUNDANG_NEAR })).status, 400, '너무 가까움');
    assert.equal((await api('POST', '/commutes', { body: {} })).status, 401);
    assert.equal((await api('GET', '/commutes/99999')).status, 404);
  });
});

describe('노선 목록', () => {
  test('조건 없이 부르면 전체 노선, 위치는 거르지 않고 가까운 순으로 정렬만', async () => {
    const u = await signup();
    const far = (await post(u, { origin: HONGDAE, destination: GANGNAM, departTime: '09:00' })).body.commute;
    const all = (await api('GET', '/commutes')).body.commutes;
    assert.ok(all.some((c) => c.id === far.id));
    const sorted = (await api('GET', `/commutes?nearLat=${BUNDANG.lat}&nearLng=${BUNDANG.lng}`)).body.commutes;
    assert.equal(sorted.length, all.length, '거르지 않음');
    const farIndex = sorted.findIndex((c) => c.id === far.id);
    const bundangIndex = sorted.findIndex((c) => c.origin.area === '분당구 정자동' && c.seatsLeft > 0);
    assert.ok(bundangIndex < farIndex, '분당 출발 노선이 홍대 출발보다 먼저');
  });
});
