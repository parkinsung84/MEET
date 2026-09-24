import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { identity } from './helpers.js';

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };

let server;
let baseUrl;

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function signup({ gender = 'male', verify = true } = {}) {
  seq += 1;
  const res = await api('POST', '/auth/register', {
    body: { email: `inq${seq}@test.com`, password: 'password123', nickname: `문의${seq}`, gender, ...identity() },
  });
  const { token, devCode } = res.body;
  if (verify) await api('POST', '/auth/phone/verify', { token, body: { code: devCode } });
  return { token, user: (await api('GET', '/auth/me', { token })).body.user };
}

let hours = 0;
async function rideBy(host, overrides = {}) {
  const res = await api('POST', '/rides', {
    token: host.token,
    body: {
      origin: SEOUL_STN, destination: GANGNAM,
      departAt: new Date(Date.now() + (hours += 3) * 3600_000).toISOString(),
      ...overrides,
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.ride;
}

const ask = (user, rideId, body, guestId = user.user.id) =>
  api('POST', `/rides/${rideId}/inquiries/${guestId}`, { token: user.token, body: { body } });
const notificationsOf = async (user) => (await api('GET', '/notifications', { token: user.token })).body.notifications;
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  ({ server } = createApp({ secret: 'inq-secret', push: null }));
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

test('참여 전 문의 → 멤버 알림·문의 목록 → 멤버 답장 → 문의자 알림', async () => {
  const host = await signup();
  const member = await signup();
  const ride = await rideBy(host);
  await api('POST', `/rides/${ride.id}/join`, { token: member.token });
  const guest = await signup();

  const sent = await ask(guest, ride.id, '캐리어 하나 있는데 괜찮을까요?');
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  await settle();
  for (const m of [host, member]) {
    assert.ok((await notificationsOf(m)).some((n) => n.type === 'inquiry' && n.body.includes('캐리어')));
  }

  const { body } = await api('GET', `/rides/${ride.id}/inquiries`, { token: host.token });
  assert.equal(body.threads.length, 1);
  assert.equal(body.threads[0].guest.id, guest.user.id);
  assert.equal(body.threads[0].awaitingReply, true);
  assert.equal(body.threads[0].guest.email, undefined, '이메일은 노출하지 않음');

  // 방장이 아닌 멤버도 답할 수 있다
  assert.equal((await ask(member, ride.id, '네 트렁크 넉넉해요!', guest.user.id)).status, 201);
  await settle();
  const reply = (await notificationsOf(guest)).find((n) => n.type === 'inquiry-reply');
  assert.match(reply.body, /트렁크/);
  assert.equal(reply.url, `/#/rides/${ride.id}`);

  const thread = await api('GET', `/rides/${ride.id}/inquiries/${guest.user.id}`, { token: guest.token });
  assert.deepEqual(thread.body.messages.map((m) => m.body), ['캐리어 하나 있는데 괜찮을까요?', '네 트렁크 넉넉해요!']);
  const threads = await api('GET', `/rides/${ride.id}/inquiries`, { token: host.token });
  assert.equal(threads.body.threads[0].awaitingReply, false);
});

test('다른 사람의 문의는 볼 수도, 답할 수도 없다', async () => {
  const host = await signup();
  const ride = await rideBy(host);
  const guest = await signup();
  const stranger = await signup();
  await ask(guest, ride.id, '안녕하세요');

  assert.equal((await api('GET', `/rides/${ride.id}/inquiries/${guest.user.id}`, { token: stranger.token })).status, 403);
  assert.equal((await ask(stranger, ride.id, '끼어들기', guest.user.id)).status, 403);
  assert.equal((await api('GET', `/rides/${ride.id}/inquiries`, { token: guest.token })).status, 403, '문의 목록은 멤버 전용');
  assert.equal((await ask(host, ride.id, '먼저 말 걸기', stranger.user.id)).status, 404, '멤버가 새 문의를 시작할 수는 없음');
});

test('참여 조건이 안 맞거나 인증 전·차단 관계면 문의 불가', async () => {
  const host = await signup({ gender: 'female' });
  const ride = await rideBy(host, { genderPref: 'female' });
  assert.equal((await ask(await signup({ gender: 'male' }), ride.id, '저도 될까요')).status, 403);
  assert.equal((await ask(await signup({ gender: 'female', verify: false }), ride.id, '안녕하세요')).status, 403);

  const blocked = await signup({ gender: 'female' });
  await api('POST', `/users/${blocked.user.id}/block`, { token: host.token });
  assert.equal((await ask(blocked, ride.id, '안녕하세요')).status, 403);
  assert.equal((await ask(await signup({ gender: 'female' }), ride.id, '안녕하세요')).status, 201);
});

test('답장 없이 연속 5개까지만, 답장 후 다시 가능', async () => {
  const host = await signup();
  const ride = await rideBy(host);
  const guest = await signup();
  for (let i = 1; i <= 5; i++) assert.equal((await ask(guest, ride.id, `메시지 ${i}`)).status, 201);
  assert.equal((await ask(guest, ride.id, '6번째')).status, 429);
  await ask(host, ride.id, '네 말씀하세요', guest.user.id);
  assert.equal((await ask(guest, ride.id, '감사합니다')).status, 201);
  assert.equal((await ask(guest, ride.id, '   ')).status, 400);
});

test('참여한 뒤나 모집이 끝난 뒤에는 문의 불가 (기존 대화는 보존)', async () => {
  const host = await signup();
  const ride = await rideBy(host);
  const guest = await signup();
  await ask(guest, ride.id, '출발 5분 늦어도 될까요?');
  await api('POST', `/rides/${ride.id}/join`, { token: guest.token });
  const res = await ask(guest, ride.id, '참여했어요');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /합승 채팅/);
  const threads = await api('GET', `/rides/${ride.id}/inquiries`, { token: host.token });
  assert.equal(threads.body.threads[0].joined, true);

  const other = await signup();
  await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'cancelled' } });
  assert.equal((await ask(other, ride.id, '아직 자리 있나요?')).status, 409);
});

test('실시간: 멤버는 방 화면에서, 문의자는 자기 대화에서 메시지를 받는다', async () => {
  const host = await signup();
  const ride = await rideBy(host);
  const guest = await signup();
  const stranger = await signup();
  const sock = (token) => new Promise((resolve, reject) => {
    const s = connect(baseUrl, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
  const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
  const [h, g, x] = await Promise.all([sock(host.token), sock(guest.token), sock(stranger.token)]);
  try {
    await emit(h, 'ride:subscribe', ride.id);
    await emit(g, 'inquiry:subscribe', ride.id);
    await emit(x, 'inquiry:subscribe', ride.id); // 자기 대화 room 이라 남의 대화는 안 옴
    let strangerGot = 0;
    x.on('inquiry:message', () => { strangerGot += 1; });

    const toHost = new Promise((r) => h.once('inquiry:message', r));
    await ask(guest, ride.id, '자리 있나요?');
    const m1 = await toHost;
    assert.equal(m1.guestId, guest.user.id);
    assert.equal(m1.rideId, ride.id);

    const toGuest = new Promise((r) => g.once('inquiry:message', r));
    await ask(host, ride.id, '네 있어요', guest.user.id);
    assert.equal((await toGuest).body, '네 있어요');
    await settle();
    assert.equal(strangerGot, 0);
  } finally {
    [h, g, x].forEach((s) => s.disconnect());
  }
});
