import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { AGREE_ALL, identity, relaxedLimits } from './helpers.js';

const SEOUL_STN = { name: '서울역', lat: 37.5547, lng: 126.9707 };
const GANGNAM = { name: '강남역', lat: 37.4979, lng: 127.0276 };

const servers = [];
let base;
let db;

async function start(options = {}) {
  const app = createApp({ secret: 'acct-secret', push: null, ...options });
  await new Promise((resolve) => app.server.listen(0, resolve));
  servers.push(app.server);
  return { ...app, url: `http://localhost:${app.server.address().port}` };
}

function client(url) {
  return async (method, path, { token, body } = {}) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
}
let api;

let seq = 0;
async function signup({ verify = true, info = identity(), gender = 'male' } = {}) {
  seq += 1;
  const email = `acct${seq}@test.com`;
  const res = await api('POST', '/auth/register', {
    body: { email, password: 'password123', nickname: `계정${seq}`, gender, ...info },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  let { token, user } = res.body;
  if (verify) ({ user } = (await api('POST', '/auth/phone/verify', { token, body: { code: res.body.devCode } })).body);
  return { token, user, email };
}

let hours = 0;
async function rideWith(host, ...members) {
  const { body } = await api('POST', '/rides', {
    token: host.token,
    // 이 파일의 테스트는 성별과 무관하므로 남녀가 함께 탈 수 있는 대형 택시 합승으로 만든다
    body: { origin: SEOUL_STN, destination: GANGNAM, departAt: new Date(Date.now() + (hours += 3) * 3600_000).toISOString(), taxiType: 'large' },
  });
  assert.ok(body.ride, JSON.stringify(body));
  for (const m of members) await api('POST', `/rides/${body.ride.id}/join`, { token: m.token });
  return body.ride;
}

before(async () => {
  const app = await start({ authLimits: relaxedLimits() });
  base = app.url;
  db = app.db;
  api = client(base);
});
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

describe('약관·개인정보 동의', () => {
  test('필수 동의 없이는 가입 불가', async () => {
    const res = await api('POST', '/auth/register', {
      body: { email: 'noconsent@test.com', password: 'password123', nickname: 'x', gender: 'male', ...identity({ agreements: { terms: true } }) },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /개인정보 수집·이용 동의/);
  });

  test('약관이 바뀌면 다시 동의해야 이용 가능', async () => {
    const user = await signup();
    assert.deepEqual(user.user.consentsRequired, []);
    db.prepare("UPDATE user_consents SET version = 'old' WHERE user_id = ? AND kind = 'privacy'").run(user.user.id);
    const me = (await api('GET', '/auth/me', { token: user.token })).body.user;
    assert.deepEqual(me.consentsRequired, ['privacy']);
    const blocked = await api('POST', '/rides', {
      token: user.token, body: { origin: SEOUL_STN, destination: GANGNAM, departAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /약관/);
    assert.equal((await api('POST', '/auth/consents', { token: user.token, body: { kinds: ['terms'] } })).status, 400);
    const agreed = await api('POST', '/auth/consents', { token: user.token, body: { kinds: Object.keys(AGREE_ALL) } });
    assert.deepEqual(agreed.body.user.consentsRequired, []);
  });

  test('약관 페이지 제공', async () => {
    for (const page of ['terms', 'privacy', 'location']) {
      const res = await fetch(`${base}/legal/${page}.html`);
      assert.equal(res.status, 200, page);
    }
  });
});

describe('로그인 보안', () => {
  test('같은 계정 5회 실패 시 잠금 (맞는 비밀번호도 거절), 보안 헤더', async () => {
    const strict = await start();
    const call = client(strict.url);
    const email = 'lock@test.com';
    await call('POST', '/auth/register', { body: { email, password: 'password123', nickname: 'x', gender: 'male', ...identity() } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/auth/login', { body: { email, password: 'wrong-password' } })).status, 401);
    }
    const locked = await call('POST', '/auth/login', { body: { email, password: 'password123' } });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    // 다른 계정은 영향 없음
    const other = 'other@test.com';
    await call('POST', '/auth/register', { body: { email: other, password: 'password123', nickname: 'y', gender: 'male', ...identity() } });
    assert.equal((await call('POST', '/auth/login', { body: { email: other, password: 'password123' } })).status, 200);

    const health = await call('GET', '/health');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.match(health.headers.get('permissions-policy'), /microphone=\(self\)/);
  });

  test('모든 기기 로그아웃: 기존 토큰 무효 + 접속 중인 소켓 끊김', async () => {
    const user = await signup();
    const socket = connect(base, { auth: { token: user.token }, transports: ['websocket'], forceNew: true });
    await new Promise((resolve) => socket.on('connect', resolve));
    const dropped = new Promise((resolve) => socket.on('disconnect', resolve));
    assert.equal((await api('POST', '/auth/logout-all', { token: user.token })).status, 200);
    await dropped;
    assert.equal((await api('GET', '/auth/me', { token: user.token })).status, 401);
    const again = connect(base, { auth: { token: user.token }, transports: ['websocket'], forceNew: true });
    await new Promise((resolve) => again.on('connect_error', resolve));
    again.disconnect();
    // 다시 로그인하면 정상
    assert.equal((await api('POST', '/auth/login', { body: { email: user.email, password: 'password123' } })).status, 200);
  });

  test('비밀번호 변경: 현재 비밀번호 확인, 다른 기기 로그아웃, 이 기기는 새 토큰', async () => {
    const user = await signup();
    const other = (await api('POST', '/auth/login', { body: { email: user.email, password: 'password123' } })).body.token;
    const change = (currentPassword, newPassword) => api('POST', '/auth/password', { token: user.token, body: { currentPassword, newPassword } });
    assert.equal((await change('wrong-password', 'newpassword1')).status, 400);
    assert.equal((await change('password123', 'short')).status, 400);
    const { body } = await change('password123', 'newpassword1');
    assert.equal((await api('GET', '/auth/me', { token: other })).status, 401);
    assert.equal((await api('GET', '/auth/me', { token: body.token })).status, 200);
    assert.equal((await api('POST', '/auth/login', { body: { email: user.email, password: 'newpassword1' } })).status, 200);
  });

  test('비밀번호 찾기: 인증된 휴대폰으로 코드 → 재설정 → 기존 로그인 전부 해제', async () => {
    const user = await signup();
    const unknown = await api('POST', '/auth/password/forgot', { body: { email: 'nobody@test.com' } });
    assert.equal(unknown.status, 200, '가입 여부를 알려주지 않음');
    assert.equal(unknown.body.devCode, undefined);

    const sent = await api('POST', '/auth/password/forgot', { body: { email: user.email } });
    assert.match(sent.body.devCode, /^\d{6}$/);
    assert.equal((await api('POST', '/auth/password/forgot', { body: { email: user.email } })).status, 429, '1분 재발송 제한');
    const reset = (code, password) => api('POST', '/auth/password/reset', { body: { email: user.email, code, password } });
    assert.equal((await reset('000000', 'brandnew123')).status, 400);
    assert.equal((await reset(sent.body.devCode, 'short')).status, 400);
    assert.equal((await reset(sent.body.devCode, 'brandnew123')).status, 200);
    assert.equal((await reset(sent.body.devCode, 'again12345')).status, 400, '한 번 쓴 코드는 무효');
    assert.equal((await api('GET', '/auth/me', { token: user.token })).status, 401);
    assert.equal((await api('POST', '/auth/login', { body: { email: user.email, password: 'brandnew123' } })).status, 200);
  });

  test('비밀번호 찾기: 휴대폰 인증 전 계정은 이메일로, 5회 틀리면 무효', async () => {
    const user = await signup({ verify: false });
    const sent = await api('POST', '/auth/password/forgot', { body: { email: user.email } });
    assert.ok(sent.body.devCode);
    for (let i = 0; i < 5; i++) await api('POST', '/auth/password/reset', { body: { email: user.email, code: '999999', password: 'brandnew123' } });
    const res = await api('POST', '/auth/password/reset', { body: { email: user.email, code: sent.body.devCode, password: 'brandnew123' } });
    assert.equal(res.status, 400);
  });
});

describe('회원 탈퇴', () => {
  test('진행 중인 합승·미송금 정산이 있으면 탈퇴 불가', async () => {
    const [host, rider] = [await signup(), await signup()];
    const ride = await rideWith(host, rider);
    const withdraw = (u, password = 'password123') => api('DELETE', '/auth/me', { token: u.token, body: { password } });
    assert.equal((await withdraw(rider, 'wrong-password')).status, 400);
    assert.equal((await withdraw(rider)).status, 409);

    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed' } });
    await api('POST', `/rides/${ride.id}/settlement`, { token: host.token, body: { actualFare: 10000, account: '토스 1000' } });
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'completed' } });
    const unpaid = await withdraw(rider);
    assert.equal(unpaid.status, 409);
    assert.match(unpaid.body.error, /송금/);
    await api('POST', `/rides/${ride.id}/settlement/paid`, { token: rider.token });
    assert.equal((await withdraw(rider)).status, 200);
  });

  test('탈퇴하면 개인정보 파기·익명화, 로그인 불가, 같은 번호 재가입 시 노쇼 기록 승계', async () => {
    const host = await signup();
    const info = identity();
    const leaver = await signup({ info });
    const ride = await rideWith(host, leaver);
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed', noShowIds: [leaver.user.id] } });

    assert.equal((await api('DELETE', '/auth/me', { token: leaver.token, body: { password: 'password123' } })).status, 200);
    assert.equal((await api('GET', '/auth/me', { token: leaver.token })).status, 401);
    assert.equal((await api('POST', '/auth/login', { body: { email: leaver.email, password: 'password123' } })).status, 401);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(leaver.user.id);
    assert.equal(row.real_name, null);
    assert.equal(row.phone, null);
    assert.equal(row.birth_date, null);
    assert.match(row.email, /@deleted\.invalid$/);
    assert.equal(row.nickname, '탈퇴한 사용자');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_consents WHERE user_id = ?').get(leaver.user.id).n, 0);

    // 같은 이메일로 다시 가입 가능, 같은 번호면 노쇼 기록 이어받음
    const again = await api('POST', '/auth/register', {
      body: { email: leaver.email, password: 'password123', nickname: '새출발', gender: 'male', ...info },
    });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const verified = await api('POST', '/auth/phone/verify', { token: again.body.token, body: { code: again.body.devCode } });
    assert.equal(verified.body.user.stats.noShows, 1);
  });
});

describe('택시 차량번호·안심 공유', () => {
  test('차량번호 기록: 형식 검사, 멤버만, 다른 멤버에게 알림', async () => {
    const [host, rider, outsider] = [await signup(), await signup(), await signup()];
    const ride = await rideWith(host, rider);
    const record = (u, plate, note) => api('PUT', `/rides/${ride.id}/taxi`, { token: u.token, body: { plate, note } });
    assert.equal((await record(rider, '1234')).status, 400);
    assert.equal((await record(outsider, '서울12가3456')).status, 403);
    const res = await record(rider, '서울 12가 3456', '흰색 쏘나타');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual({ plate: res.body.ride.taxi.plate, note: res.body.ride.taxi.note }, { plate: '서울12가3456', note: '흰색 쏘나타' });
    assert.equal((await record(host, '123바4567')).status, 200, '신형 번호판(3자리)도 가능');
    await new Promise((r) => setTimeout(r, 20));
    const { notifications } = (await api('GET', '/notifications', { token: host.token })).body;
    assert.ok(notifications.some((n) => n.type === 'taxi' && n.body.includes('서울12가3456')));
    assert.equal((await api('GET', `/rides/${ride.id}`, { token: outsider.token })).body.ride.taxi, null, '비멤버에게는 비공개');
  });

  test('안심 공유 링크: 로그인 없이 조회, 민감정보 제외, 해제·만료', async () => {
    const [host, rider, outsider] = [await signup({ gender: 'female' }), await signup(), await signup()];
    const ride = await rideWith(host, rider);
    assert.equal((await api('POST', `/rides/${ride.id}/share`, { token: outsider.token })).status, 403);
    await api('PUT', `/rides/${ride.id}/taxi`, { token: rider.token, body: { plate: '12가3456' } });
    const { body } = await api('POST', `/rides/${ride.id}/share`, { token: host.token });
    assert.equal(body.url, `/share.html#${body.token}`);

    const view = await api('GET', `/share/${body.token}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.ride.taxi.plate, '12가3456');
    assert.deepEqual(view.body.ride.riders.map((r) => r.gender), ['female', 'male']);
    const text = JSON.stringify(view.body);
    for (const secret of ['meetingPoint', 'phone', 'email', 'account', 'settlement', '홍길동']) assert.ok(!text.includes(secret), secret);
    assert.equal(view.headers.get('cache-control'), 'no-store');
    assert.equal((await api('GET', '/share/not-a-token')).status, 404);

    // 도착 완료 후 12시간이 지나면 만료
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'departed' } });
    await api('PATCH', `/rides/${ride.id}/status`, { token: host.token, body: { status: 'completed' } });
    assert.equal((await api('GET', `/share/${body.token}`)).body.ride.status, 'completed');
    db.prepare('UPDATE rides SET completed_at = ? WHERE id = ?').run(new Date(Date.now() - 13 * 3600_000).toISOString(), ride.id);
    assert.equal((await api('GET', `/share/${body.token}`)).status, 410);

    // 공유 해제
    const ride2 = await rideWith(host, rider);
    const share2 = (await api('POST', `/rides/${ride2.id}/share`, { token: rider.token })).body.token;
    await api('DELETE', `/rides/${ride2.id}/share`, { token: rider.token });
    assert.equal((await api('GET', `/share/${share2}`)).status, 404);
  });
});
