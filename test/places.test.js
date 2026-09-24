import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';

/** 테스트용 네이버 클라이언트 대역 */
const fakeNaver = {
  mapsEnabled: true,
  searchEnabled: true,
  mapKeyId: 'public-key-id',
  searchPlaces: async (q) => (q === 'fail' ? Promise.reject(new Error('down')) : [{ name: `${q} 결과`, address: '', category: '', lat: 35.1, lng: 129.04 }]),
  reverseGeocode: async (lat, lng) => ({ name: '부산역', address: '부산광역시 동구 중앙대로 206', lat, lng }),
  route: async (origin, destination) => (destination.name === '경로없음'
    ? Promise.reject(new Error('no route'))
    : { distanceKm: 12.3, durationMin: 25, taxiFare: 15600, path: [[origin.lng, origin.lat], [destination.lng, destination.lat]] }),
};

const servers = [];
async function start(options) {
  const { server } = createApp({ secret: 's', push: null, ...options });
  await new Promise((resolve) => server.listen(0, resolve));
  servers.push(server);
  const base = `http://localhost:${server.address().port}/api`;
  const res = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@a.com', password: 'password123', nickname: 'a', gender: 'male' }),
  });
  const { token, devCode } = await res.json();
  await fetch(`${base}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ code: devCode }),
  });
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  return call;
}

let plain;
let withNaver;
before(async () => {
  plain = await start({});
  withNaver = await start({ naver: fakeNaver });
});
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

// 같은 사용자가 여러 방을 만들므로 출발 시간을 서로 겹치지 않게 벌린다
let hours = 0;
const ride = (dest) => ({
  origin: { name: '부산역', lat: 35.1151, lng: 129.0414 },
  destination: { name: dest, lat: 35.1631, lng: 129.1635 },
  departAt: new Date(Date.now() + (hours += 3) * 3600_000).toISOString(),
});

test('config: 지도 키 노출 여부', async () => {
  assert.equal((await plain('GET', '/config')).body.naverMapKeyId, null);
  assert.equal((await withNaver('GET', '/config')).body.naverMapKeyId, 'public-key-id');
});

test('검색: 네이버 미설정 시 주요 거점 목록에서 검색', async () => {
  const { body } = await plain('GET', `/places/search?q=${encodeURIComponent('인천공항')}`);
  assert.equal(body.source, 'preset');
  assert.deepEqual(body.places.map((p) => p.name), ['인천공항 T1', '인천공항 T2']);
});

test('검색: 네이버 결과 사용, 실패 시 502, 빈 검색어 400', async () => {
  const ok = await withNaver('GET', `/places/search?q=${encodeURIComponent('해운대')}`);
  assert.equal(ok.body.places[0].name, '해운대 결과');
  assert.equal((await withNaver('GET', '/places/search?q=fail')).status, 502);
  assert.equal((await withNaver('GET', '/places/search?q=')).status, 400);
});

test('역지오코딩: 설정 시 주소, 미설정 시 기본 이름', async () => {
  assert.equal((await withNaver('GET', '/places/reverse?lat=35.11&lng=129.04')).body.place.name, '부산역');
  assert.equal((await plain('GET', '/places/reverse?lat=35.11&lng=129.04')).body.place.name, '선택한 위치');
  assert.equal((await plain('GET', '/places/reverse?lat=abc&lng=1')).status, 400);
});

test('합승방 생성 시 네이버 경로/택시요금을 저장한다', async () => {
  const { status, body } = await withNaver('POST', '/rides', ride('해운대해수욕장'));
  assert.equal(status, 201);
  assert.equal(body.ride.fare.source, 'naver');
  assert.equal(body.ride.fare.total, 15600);
  assert.equal(body.ride.fare.distanceKm, 12.3);
  assert.equal(body.ride.fare.durationMin, 25);
  assert.equal(body.ride.fare.perPersonFull, 3900);
  assert.equal(body.ride.routePath.length, 2);
});

test('길찾기 실패 시 직선거리 추정 요금으로 대체', async () => {
  const { status, body } = await withNaver('POST', '/rides', ride('경로없음'));
  assert.equal(status, 201);
  assert.equal(body.ride.fare.source, 'estimate');
  assert.equal(body.ride.routePath, null);
  assert.ok(body.ride.fare.total > 4800);
});
