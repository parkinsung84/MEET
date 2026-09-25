import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createIdentityClient, identityClientFromEnv } from '../src/identity.js';
import { AGREE_ALL, relaxedLimits } from './helpers.js';

// 휴대폰 본인확인(PASS, 포트원): 서버가 발급한 인증 건을 업체에 직접 조회해서 본인정보를 확정

/** 포트원 대역: 인증 건 번호 → 본인확인 결과 (테스트가 채워 넣는다) */
const results = new Map();
const fakeIdentity = {
  enabled: true,
  publicConfig: { provider: 'portone', storeId: 'store-test', channelKey: 'channel-test' },
  async fetchVerified(id) { return results.get(id) ?? null; },
};
const person = (overrides = {}) => ({
  name: '김민지', birthDate: '1996-05-02', gender: 'female', phone: '01055556666', key: 'ci-kim', isForeigner: false, ...overrides,
});

let server;
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
  // 본인확인을 쓰면 가입할 때 이름·생년월일·번호를 입력하지 않는다
  const res = await api('POST', '/auth/register', {
    body: { email: `pass${seq}@test.com`, password: 'password123', nickname: `패스${seq}`, gender, agreements: AGREE_ALL },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { token: res.body.token, user: res.body.user };
}
async function verifyAs(u, result) {
  const { identityVerificationId } = (await api('POST', '/auth/identity/start', { token: u.token })).body;
  if (result) results.set(identityVerificationId, result);
  return { id: identityVerificationId, res: await api('POST', '/auth/identity/complete', { token: u.token, body: { identityVerificationId } }) };
}

before(async () => {
  ({ server } = createApp({ secret: 'pass-secret', push: null, identity: fakeIdentity, authLimits: relaxedLimits() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

describe('휴대폰 본인확인 (PASS)', () => {
  test('설정값을 브라우저에 알려주고, 문자 인증 경로는 막는다', async () => {
    const config = (await api('GET', '/config')).body;
    assert.deepEqual(config.identity, { provider: 'portone', storeId: 'store-test', channelKey: 'channel-test' });
    const u = await signup();
    assert.equal(u.user.verified, false);
    assert.equal((await api('POST', '/auth/phone/send', { token: u.token })).status, 400);
    assert.equal((await api('PUT', '/auth/identity', { token: u.token, body: { name: '가짜', birthDate: '1990-01-01', phone: '01011112222' } })).status, 400);
    // 인증 전에는 합승 이용 불가
    assert.equal((await api('POST', '/rides', { token: u.token, body: {} })).status, 403);
  });

  test('본인확인 결과로 이름·생년월일·성별·번호가 확정된다 (가입 때 고른 성별보다 우선)', async () => {
    const u = await signup('male');
    const { res } = await verifyAs(u, person());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const me = res.body.user;
    assert.equal(me.verified, true);
    assert.equal(me.identityMethod, 'pass');
    assert.equal(me.name, '김민지');
    assert.equal(me.birthDate, '1996-05-02');
    assert.equal(me.gender, 'female');
    assert.equal(me.phone, '010-****-6666');
  });

  test('인증이 끝나지 않았거나, 남의 인증 건이거나, 이미 쓴 인증 건이면 거절', async () => {
    const a = await signup();
    const pending = await verifyAs(a, null);
    assert.equal(pending.res.status, 400, '업체에서 VERIFIED 가 아니면 거절');

    const b = await signup();
    const { identityVerificationId } = (await api('POST', '/auth/identity/start', { token: b.token })).body;
    results.set(identityVerificationId, person({ key: 'ci-b', phone: '01077778888' }));
    const stolen = await api('POST', '/auth/identity/complete', { token: a.token, body: { identityVerificationId } });
    assert.equal(stolen.status, 400, '다른 계정이 발급받은 인증 건은 쓸 수 없음');
    assert.equal((await api('POST', '/auth/identity/complete', { token: a.token, body: { identityVerificationId: 'made-up' } })).status, 400);

    assert.equal((await api('POST', '/auth/identity/complete', { token: b.token, body: { identityVerificationId } })).status, 200);
    const c = await signup();
    const reused = await api('POST', '/auth/identity/complete', { token: c.token, body: { identityVerificationId } });
    assert.equal(reused.status, 400);
  });

  test('같은 사람은 계정 하나만 (번호를 바꿔도)', async () => {
    const first = await signup();
    assert.equal((await verifyAs(first, person({ key: 'ci-lee', phone: '01020203030' }))).res.status, 200);
    const second = await signup();
    const dup = await verifyAs(second, person({ key: 'ci-lee', phone: '01040405050' }));
    assert.equal(dup.res.status, 409);
    assert.match(dup.res.body.error, /이미 가입된 계정/);
  });

  test('만 19세 미만은 이용할 수 없다', async () => {
    const teen = await signup();
    const year = new Date().getFullYear() - 17;
    const res = (await verifyAs(teen, person({ key: 'ci-teen', phone: '01090909090', birthDate: `${year}-01-01` }))).res;
    assert.equal(res.status, 403);
    assert.equal((await api('GET', '/auth/me', { token: teen.token })).body.user.verified, false);
  });

  test('탈퇴하면 같은 사람이 다시 가입할 수 있다', async () => {
    const u = await signup();
    assert.equal((await verifyAs(u, person({ key: 'ci-back', phone: '01012121212' }))).res.status, 200);
    assert.equal((await api('DELETE', '/auth/me', { token: u.token, body: { password: 'password123' } })).status, 200);
    const again = await signup();
    assert.equal((await verifyAs(again, person({ key: 'ci-back', phone: '01012121212' }))).res.status, 200);
  });
});

describe('포트원 본인인증 조회', () => {
  const client = (reply) => {
    const calls = [];
    const fetch = async (url, { headers }) => {
      calls.push({ url, headers });
      return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
    };
    return { calls, identity: createIdentityClient({ storeId: 's', channelKey: 'c', apiSecret: 'secret-x', fetch }) };
  };

  test('인증 완료 건의 본인정보를 앱 형식으로 바꾼다', async () => {
    const { calls, identity } = client({
      body: {
        status: 'VERIFIED',
        verifiedCustomer: { name: '박서준', birthDate: '1990-01-31', gender: 'MALE', phoneNumber: '010-2222-3333', ci: 'CI', di: 'DI', isForeigner: false },
      },
    });
    const v = await identity.fetchVerified('meet-1-abc');
    assert.deepEqual(v, { name: '박서준', birthDate: '1990-01-31', gender: 'male', phone: '01022223333', key: 'CI', isForeigner: false });
    assert.equal(calls[0].url, 'https://api.portone.io/identity-verifications/meet-1-abc');
    assert.equal(calls[0].headers.Authorization, 'PortOne secret-x');
  });

  test('완료되지 않은 건은 null, 서버 오류는 에러', async () => {
    assert.equal(await client({ body: { status: 'READY' } }).identity.fetchVerified('x'), null);
    assert.equal(await client({ status: 404, body: {} }).identity.fetchVerified('x'), null);
    await assert.rejects(client({ status: 401, body: { message: 'bad secret' } }).identity.fetchVerified('x'));
  });

  test('환경변수가 비었거나 none 이면 꺼진다', () => {
    assert.equal(identityClientFromEnv({}).enabled, false);
    assert.equal(identityClientFromEnv({ PORTONE_STORE_ID: 's', PORTONE_CHANNEL_KEY: 'c', PORTONE_API_SECRET: 'none' }).enabled, false);
    const on = identityClientFromEnv({ PORTONE_STORE_ID: 's', PORTONE_CHANNEL_KEY: 'c', PORTONE_API_SECRET: 'k' });
    assert.equal(on.enabled, true);
    assert.deepEqual(on.publicConfig, { provider: 'portone', storeId: 's', channelKey: 'c' });
  });
});
