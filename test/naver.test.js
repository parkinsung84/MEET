import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNaverClient, naverClientFromEnv, simplifyPath } from '../src/naver.js';

/** 요청을 기록하고, URL 경로별로 준비된 응답을 돌려주는 가짜 fetch */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, { headers }) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), headers });
    const handler = routes[u.pathname];
    if (!handler) return new Response('{}', { status: 404 });
    const [status, body] = handler(u.searchParams);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const KEYS = { ncpKeyId: 'kid', ncpKey: 'ksecret', searchClientId: 'sid', searchClientSecret: 'ssecret' };

test('NAVER_DIRECTIONS=0 이면 지도·검색은 쓰고 유료 길찾기만 끈다', () => {
  const env = { NAVER_MAP_KEY_ID: 'k', NAVER_MAP_KEY: 's', NAVER_DIRECTIONS: '0' };
  const naver = naverClientFromEnv(env);
  assert.equal(naver.mapsEnabled, true);
  assert.equal(naver.directionsEnabled, false);
  assert.equal(naverClientFromEnv({ NAVER_MAP_KEY_ID: 'k', NAVER_MAP_KEY: 's' }).directionsEnabled, true);
});

test('키가 없으면 기능이 비활성화된다', () => {
  const naver = createNaverClient();
  assert.equal(naver.mapsEnabled, false);
  assert.equal(naver.searchEnabled, false);
  assert.equal(naver.mapKeyId, null);
});

test('searchPlaces: 장소명 검색 + 주소 검색 결과를 합치고 좌표를 변환한다', async () => {
  const { fetch, calls } = fakeFetch({
    '/v1/search/local.json': () => [200, {
      items: [{
        title: '<b>스타벅스</b> 강남R점', category: '카페', address: '서울 강남구 역삼동 825',
        roadAddress: '서울 강남구 강남대로 390', mapx: '1270276210', mapy: '374979502',
      }],
    }],
    '/map-geocode/v2/geocode': () => [200, {
      status: 'OK',
      addresses: [{ roadAddress: '서울특별시 강남구 강남대로 390', jibunAddress: '서울특별시 강남구 역삼동 825', x: '127.0276', y: '37.4979' }],
    }],
  });
  const naver = createNaverClient({ ...KEYS, fetch });
  const places = await naver.searchPlaces('강남 스타벅스');

  assert.equal(places.length, 2);
  assert.deepEqual(places[0], {
    name: '스타벅스 강남R점', address: '서울 강남구 강남대로 390', category: '카페', lat: 37.4979502, lng: 127.027621,
  });
  assert.equal(places[1].name, '서울특별시 강남구 강남대로 390');
  assert.equal(places[1].lat, 37.4979);

  const local = calls.find((c) => c.path === '/v1/search/local.json');
  assert.equal(local.headers['X-Naver-Client-Id'], 'sid');
  assert.equal(local.params.query, '강남 스타벅스');
  const geo = calls.find((c) => c.path === '/map-geocode/v2/geocode');
  assert.equal(geo.headers['x-ncp-apigw-api-key-id'], 'kid');
  assert.equal(geo.headers['x-ncp-apigw-api-key'], 'ksecret');

  // 같은 검색어는 캐시에서 응답
  await naver.searchPlaces('강남 스타벅스');
  assert.equal(calls.length, 2);
});

test('searchPlaces: 한쪽 API가 실패해도 다른 쪽 결과는 돌려준다', async () => {
  const { fetch } = fakeFetch({
    '/v1/search/local.json': () => [500, { errorMessage: 'boom' }],
    '/map-geocode/v2/geocode': () => [200, { addresses: [{ roadAddress: '판교역로 166', x: '127.1112', y: '37.3948' }] }],
  });
  const places = await createNaverClient({ ...KEYS, fetch }).searchPlaces('판교역로 166');
  assert.equal(places.length, 1);
});

test('searchPlaces: 모두 실패하면 에러', async () => {
  const { fetch } = fakeFetch({});
  await assert.rejects(createNaverClient({ ...KEYS, fetch }).searchPlaces('x'));
});

test('API HUB 키가 있으면 새 주소·헤더로 장소 검색', async () => {
  const item = { title: '<b>서울대</b>학교', category: '대학교', roadAddress: '서울 관악구 관악로 1', mapx: '1269520000', mapy: '374600000' };
  const { fetch, calls } = fakeFetch({ '/search/v1/local': () => [200, { items: [item] }] });
  const naver = naverClientFromEnv({ NAVER_APIHUB_KEY_ID: 'hid', NAVER_APIHUB_KEY: 'hsecret' });
  assert.equal(naver.searchEnabled, true);
  const places = await createNaverClient({ apiHubKeyId: 'hid', apiHubKey: 'hsecret', fetch }).searchPlaces('서울대');
  assert.deepEqual(places, [{ name: '서울대학교', address: '서울 관악구 관악로 1', category: '대학교', lat: 37.46, lng: 126.952 }]);
  assert.equal(calls[0].path, '/search/v1/local');
  assert.equal(calls[0].params.query, '서울대');
  assert.equal(calls[0].headers['X-NCP-APIGW-API-KEY-ID'], 'hid');
  assert.equal(calls[0].headers['X-NCP-APIGW-API-KEY'], 'hsecret');
});

test('API HUB가 실패하면 예전 검색 키로 대체', async () => {
  const { fetch, calls } = fakeFetch({
    '/search/v1/local': () => [401, { error: 'unauthorized' }],
    '/v1/search/local.json': () => [200, { items: [{ title: '강남역', address: '서울', mapx: '1270276000', mapy: '374979000' }] }],
  });
  const places = await createNaverClient({ apiHubKeyId: 'h', apiHubKey: 'x', searchClientId: 'sid', searchClientSecret: 's', fetch }).searchPlaces('강남역');
  assert.equal(places[0].name, '강남역');
  assert.deepEqual(calls.map((c) => c.path), ['/search/v1/local', '/v1/search/local.json']);
});

test('reverseGeocode: 도로명 주소와 건물명을 돌려준다', async () => {
  const { fetch, calls } = fakeFetch({
    '/map-reversegeocode/v2/gc': () => [200, {
      status: { code: 0 },
      results: [
        { name: 'addr', region: { area1: { name: '서울특별시' }, area2: { name: '중구' }, area3: { name: '봉래동2가' } }, land: { number1: '122' } },
        {
          name: 'roadaddr',
          region: { area1: { name: '서울특별시' }, area2: { name: '중구' }, area3: { name: '봉래동2가' } },
          land: { name: '한강대로', number1: '405', number2: '', addition0: { type: 'building', value: '서울역' } },
        },
      ],
    }],
  });
  const place = await createNaverClient({ ...KEYS, fetch }).reverseGeocode(37.5547, 126.9707);
  assert.deepEqual(place, { name: '서울역', address: '서울특별시 중구 봉래동2가 한강대로 405', lat: 37.5547, lng: 126.9707 });
  assert.equal(calls[0].params.coords, '126.9707,37.5547');
});

test('route: 거리·시간·택시요금·경로를 변환한다', async () => {
  const path = Array.from({ length: 1000 }, (_, i) => [127 + i / 1e4, 37.5]);
  const { fetch, calls } = fakeFetch({
    '/map-direction/v1/driving': () => [200, {
      code: 0,
      route: { traoptimal: [{ summary: { distance: 10543, duration: 1_560_000, taxiFare: 13200 }, path }] },
    }],
  });
  const route = await createNaverClient({ ...KEYS, fetch }).route({ lat: 37.55, lng: 126.97 }, { lat: 37.49, lng: 127.02 });
  assert.equal(route.distanceKm, 10.5);
  assert.equal(route.durationMin, 26);
  assert.equal(route.taxiFare, 13200);
  assert.equal(route.path.length, 400);
  assert.deepEqual(route.path.at(-1), path.at(-1));
  assert.equal(calls[0].params.start, '126.97,37.55');
  assert.equal(calls[0].params.goal, '127.02,37.49');
});

test('route: 경로가 없으면 에러', async () => {
  const { fetch } = fakeFetch({ '/map-direction/v1/driving': () => [200, { code: 1, message: '출발지와 도착지가 동일' }] });
  await assert.rejects(createNaverClient({ ...KEYS, fetch }).route({ lat: 1, lng: 1 }, { lat: 1, lng: 1 }));
});

test('simplifyPath: 짧은 경로는 그대로', () => {
  assert.deepEqual(simplifyPath([[1, 2], [3, 4]]), [[1, 2], [3, 4]]);
});
