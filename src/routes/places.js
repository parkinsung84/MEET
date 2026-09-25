import { Router } from 'express';
import { badRequest, HttpError } from '../errors.js';
import { searchPresetPlaces } from '../places.js';

export function placesRouter(naver, auth, locationLog = null) {
  const router = Router();
  router.use(auth.required);
  const searchConfigured = naver.searchEnabled || naver.mapsEnabled;

  const upstream = (err) => {
    console.error('[naver]', err.message);
    return new HttpError(502, '장소 검색 서비스에 일시적인 문제가 있습니다.');
  };

  router.get('/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) throw badRequest('검색어를 입력해 주세요.');
    if (q.length > 50) throw badRequest('검색어가 너무 깁니다.');
    // 현재 위치(선택): 가까운 장소를 먼저 보여준다
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const near = req.query.lat != null && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
      ? { lat, lng } : null;
    if (near) {
      locationLog?.record(req.userId, { action: 'place_search', purpose: '장소 검색 시 현재 위치 근처 결과를 먼저 표시' }, { throttleMs: 10 * 60 * 1000 });
    }
    if (!searchConfigured) return res.json({ places: searchPresetPlaces(q, near), source: 'preset' });
    try {
      res.json({ places: await naver.searchPlaces(q, near), source: 'naver' });
    } catch (err) {
      throw upstream(err);
    }
  });

  router.get('/reverse', async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw badRequest('좌표가 올바르지 않습니다.');
    }
    const fallback = { name: '선택한 위치', address: '', lat, lng };
    // 기기 위치(현재 위치 버튼)를 주소로 바꾸는 것도 개인위치정보 이용이므로 기록 (좌표는 저장하지 않음)
    locationLog?.record(req.userId, { action: 'reverse_geocode', purpose: '현재 위치 또는 지도에서 고른 위치를 주소로 변환' });
    if (!naver.mapsEnabled) return res.json({ place: fallback });
    try {
      res.json({ place: (await naver.reverseGeocode(lat, lng)) ?? fallback });
    } catch (err) {
      throw upstream(err);
    }
  });

  return router;
}
