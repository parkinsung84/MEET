import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createSmsSender } from '../src/sms.js';

test('SENS 미설정이면 개발용 콘솔 모드', async () => {
  const logs = [];
  const sms = createSmsSender({}, { log: { info: (m) => logs.push(m) } });
  assert.equal(sms.configured, false);
  await sms.send('01012345678', '[MEET] 인증번호 123456');
  assert.match(logs[0], /01012345678/);
});

test('SENS: 서명 헤더와 본문 형식', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('{"statusCode":"202"}', { status: 202 });
  };
  const env = { NCP_ACCESS_KEY: 'ak', NCP_SECRET_KEY: 'sk', NCP_SENS_SERVICE_ID: 'ncp:sms:kr:1:meet', SMS_FROM: '0212345678' };
  await createSmsSender(env, { fetch }).send('01012345678', 'hello');
  const { url, init } = calls[0];
  const path = '/sms/v2/services/ncp:sms:kr:1:meet/messages';
  assert.equal(url, `https://sens.apigw.ntruss.com${path}`);
  const ts = init.headers['x-ncp-apigw-timestamp'];
  assert.equal(init.headers['x-ncp-iam-access-key'], 'ak');
  assert.equal(init.headers['x-ncp-apigw-signature-v2'], createHmac('sha256', 'sk').update(`POST ${path}\n${ts}\nak`).digest('base64'));
  assert.deepEqual(JSON.parse(init.body), { type: 'SMS', from: '0212345678', content: 'hello', messages: [{ to: '01012345678' }] });
});

test('SENS 오류 응답은 에러', async () => {
  const fetch = async () => new Response('bad', { status: 401 });
  const env = { NCP_ACCESS_KEY: 'a', NCP_SECRET_KEY: 's', NCP_SENS_SERVICE_ID: 'x', SMS_FROM: '1' };
  await assert.rejects(createSmsSender(env, { fetch }).send('01012345678', 'x'), /SENS 401/);
});
