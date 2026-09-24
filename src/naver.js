/**
 * 네이버 지도/검색 API 클라이언트 (서버 전용 — 비밀키가 브라우저로 나가지 않도록 여기서만 호출한다).
 *
 *  - NAVER Cloud Platform Maps (ncpKeyId / ncpKey): Geocoding, Reverse Geocoding, Directions 5
 *  - NAVER Developers 검색 API (searchClientId / searchClientSecret): 지역(장소명) 검색
 *
 * 키가 없는 기능은 비활성화되며, 호출하는 쪽에서 대체 동작을 한다.
 */

const DEFAULT_MAPS_BASE_URL = 'https://maps.apigw.ntruss.com';
const DEFAULT_OPENAPI_BASE_URL = 'https://openapi.naver.com';
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const MAX_PATH_POINTS = 400;

export class NaverApiError extends Error {}

const stripTags = (s = '') => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** 경로 좌표가 너무 많으면 균등하게 솎아낸다 (시작/끝점은 유지). */
export function simplifyPath(path, max = MAX_PATH_POINTS) {
  if (path.length <= max) return path;
  const step = (path.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => path[Math.round(i * step)]);
}

function createCache() {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit || hit.expires < Date.now()) return undefined;
      return hit.value;
    },
    set(key, value) {
      if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
      map.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
    },
  };
}

export function createNaverClient({
  ncpKeyId,
  ncpKey,
  searchClientId,
  searchClientSecret,
  mapsBaseUrl = DEFAULT_MAPS_BASE_URL,
  openApiBaseUrl = DEFAULT_OPENAPI_BASE_URL,
  fetch = globalThis.fetch,
  directionsEnabled = true,
} = {}) {
  const mapsEnabled = Boolean(ncpKeyId && ncpKey);
  const searchEnabled = Boolean(searchClientId && searchClientSecret);
  const cache = createCache();

  async function getJson(url, headers) {
    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new NaverApiError(`네이버 API 연결 실패: ${err.message}`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new NaverApiError(`네이버 API 오류 ${res.status}: ${JSON.stringify(body)}`);
    return body;
  }

  const ncpHeaders = () => ({ 'x-ncp-apigw-api-key-id': ncpKeyId, 'x-ncp-apigw-api-key': ncpKey });

  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    cache.set(key, value);
    return value;
  }

  /** 장소명(POI) 검색: "스타벅스 강남역점", "서울대학교" 등 */
  async function localSearch(query) {
    const url = `${openApiBaseUrl}/v1/search/local.json?${new URLSearchParams({ query, display: '5' })}`;
    const body = await getJson(url, {
      'X-Naver-Client-Id': searchClientId,
      'X-Naver-Client-Secret': searchClientSecret,
    });
    // mapx/mapy: WGS84 경위도 × 10^7 정수 문자열
    return (body.items ?? []).map((item) => ({
      name: stripTags(item.title),
      address: item.roadAddress || item.address || '',
      category: item.category || '',
      lat: Number(item.mapy) / 1e7,
      lng: Number(item.mapx) / 1e7,
    }));
  }

  /** 주소 검색: "테헤란로 152", "분당구 불정로 6" 등 */
  async function geocode(query) {
    const url = `${mapsBaseUrl}/map-geocode/v2/geocode?${new URLSearchParams({ query })}`;
    const body = await getJson(url, ncpHeaders());
    return (body.addresses ?? []).map((a) => ({
      name: a.roadAddress || a.jibunAddress,
      address: a.jibunAddress || a.roadAddress || '',
      category: '주소',
      lat: Number(a.y),
      lng: Number(a.x),
    }));
  }

  function formatReverse(result) {
    const { region = {}, land } = result;
    const area = [region.area1?.name, region.area2?.name, region.area3?.name].filter(Boolean).join(' ');
    if (!land) return area;
    const number = [land.number1, land.number2].filter(Boolean).join('-');
    const road = result.name === 'roadaddr' ? [land.name, number].filter(Boolean).join(' ') : number;
    return [area, region.area4?.name, road].filter(Boolean).join(' ');
  }

  return {
    mapsEnabled,
    searchEnabled,
    directionsEnabled: mapsEnabled && directionsEnabled,
    /** 브라우저 지도 SDK 로딩용 공개 키 (NCP 콘솔에서 Web 서비스 URL로 사용처가 제한됨) */
    mapKeyId: mapsEnabled ? ncpKeyId : null,

    /** 장소명 + 주소 검색 결과를 합쳐 돌려준다. 한쪽이 실패해도 다른 쪽 결과는 살린다. */
    async searchPlaces(query) {
      const q = query.trim();
      return cached(`search:${q}`, async () => {
        const tasks = [];
        if (searchEnabled) tasks.push(localSearch(q));
        if (mapsEnabled) tasks.push(geocode(q));
        const settled = await Promise.allSettled(tasks);
        if (settled.length && settled.every((s) => s.status === 'rejected')) throw settled[0].reason;
        const seen = new Set();
        return settled
          .flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
          .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.name)
          .filter((p) => {
            const key = `${p.name}|${p.lat.toFixed(4)}|${p.lng.toFixed(4)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      });
    },

    /** 좌표 → 주소. 결과가 없으면 null. */
    async reverseGeocode(lat, lng) {
      const key = `rev:${lat.toFixed(5)},${lng.toFixed(5)}`;
      return cached(key, async () => {
        const url = `${mapsBaseUrl}/map-reversegeocode/v2/gc?${new URLSearchParams({
          coords: `${lng},${lat}`,
          output: 'json',
          orders: 'roadaddr,addr',
        })}`;
        const body = await getJson(url, ncpHeaders());
        const results = body.results ?? [];
        const best = results.find((r) => r.name === 'roadaddr') ?? results[0];
        if (!best) return null;
        const building = best.land?.addition0?.value;
        const address = formatReverse(best);
        return { name: building || address, address, lat, lng };
      });
    },

    /** 자동차 경로. 실제 도로 거리, 소요시간, 네이버 예상 택시요금, 경로 좌표([lng, lat]) */
    async route(origin, destination) {
      const url = `${mapsBaseUrl}/map-direction/v1/driving?${new URLSearchParams({
        start: `${origin.lng},${origin.lat}`,
        goal: `${destination.lng},${destination.lat}`,
        option: 'traoptimal',
      })}`;
      const body = await getJson(url, ncpHeaders());
      const best = body.route?.traoptimal?.[0];
      if (body.code !== 0 || !best) throw new NaverApiError(`경로를 찾을 수 없습니다: ${body.message ?? body.code}`);
      const { summary, path = [] } = best;
      return {
        distanceKm: Math.round(summary.distance / 100) / 10,
        durationMin: Math.round(summary.duration / 60000),
        taxiFare: summary.taxiFare,
        path: simplifyPath(path),
      };
    },
  };
}

export function naverClientFromEnv(env = process.env) {
  return createNaverClient({
    // 길찾기(Directions 5)는 유료 — NAVER_DIRECTIONS=0 이면 쓰지 않고 직선거리로 요금 추정
    directionsEnabled: env.NAVER_DIRECTIONS !== '0',
    ncpKeyId: env.NAVER_MAP_KEY_ID,
    ncpKey: env.NAVER_MAP_KEY,
    searchClientId: env.NAVER_SEARCH_CLIENT_ID,
    searchClientSecret: env.NAVER_SEARCH_CLIENT_SECRET,
    mapsBaseUrl: env.NAVER_MAPS_BASE_URL || undefined,
    openApiBaseUrl: env.NAVER_OPENAPI_BASE_URL || undefined,
  });
}
