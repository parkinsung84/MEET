import { readFileSync } from 'node:fs';
import { haversineKm } from './geo.js';

/**
 * 서울 행정동 427개 (코드·구·동·중심점). 정기 노선은 "출발 동 → 도착 동"으로 미리 깔려 있다.
 * 출처: 통계청 SGIS 행정동 경계(공공누리 제1유형)를 가공한 vuski/admdongkor (CC BY 4.0)의 경계 중심점.
 */
const { rows } = JSON.parse(readFileSync(new URL('../public/data/seoul-dongs.json', import.meta.url), 'utf8'));
export const DONGS = rows.map(([code, gu, dong, lat, lng]) => ({ code, gu, dong, name: `${gu} ${dong}`, lat, lng }));
const byCode = new Map(DONGS.map((d) => [d.code, d]));

export const getDong = (code) => byCode.get(String(code)) ?? null;

/** 좌표에서 가장 가까운 동 (중심점 기준) */
export function nearestDong(lat, lng) {
  let best = null;
  let bestKm = Infinity;
  for (const d of DONGS) {
    const km = haversineKm(lat, lng, d.lat, d.lng);
    if (km < bestKm) {
      best = d;
      bestKm = km;
    }
  }
  return best;
}
