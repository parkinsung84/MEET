import { MAJOR_STATIONS, STATION_NAMES } from './stations.js';

// 한글 자동완성 보조: 입력 중인 글자(받침이 다음 글자 첫소리일 수 있음)까지 고려해 앞부분 일치를 찾는다.

const BASE = 0xac00;
// 받침 → [남길 받침, 다음 글자 첫소리] (예: 댁 → 대 + ㄱ… / 닭 → 달 + ㄱ…)
const JONG_SPLIT = {
  1: [0, 0], 2: [0, 1], 3: [1, 9], 4: [0, 2], 5: [4, 12], 6: [4, 18], 7: [0, 3], 8: [0, 5],
  9: [8, 0], 10: [8, 6], 11: [8, 7], 12: [8, 9], 13: [8, 16], 14: [8, 17], 15: [8, 18],
  16: [0, 6], 17: [0, 7], 18: [17, 9], 19: [0, 9], 20: [0, 10], 21: [0, 11], 22: [0, 12],
  23: [0, 14], 24: [0, 15], 25: [0, 16], 26: [0, 17], 27: [0, 18],
};
// 홀로 입력된 자음(ㄱ~ㅎ) → 첫소리 번호
const JAMO_CHO = { ㄱ: 0, ㄲ: 1, ㄴ: 2, ㄷ: 3, ㄸ: 4, ㄹ: 5, ㅁ: 6, ㅂ: 7, ㅃ: 8, ㅅ: 9, ㅆ: 10, ㅇ: 11, ㅈ: 12, ㅉ: 13, ㅊ: 14, ㅋ: 15, ㅌ: 16, ㅍ: 17, ㅎ: 18 };

const isSyllable = (ch) => ch >= '가' && ch <= '힣';
const choOf = (ch) => (isSyllable(ch) ? Math.floor((ch.charCodeAt(0) - BASE) / 588) : -1);

/** 비교용: 공백·괄호 제거, 끝의 '역' 제거 */
export const normalizeName = (s) => s.replace(/\(.*?\)/g, '').replace(/\s+/g, '').replace(/역$/, '');

/**
 * 입력 q 로 name 이 "시작"될 수 있는지.
 * "동대" → 동대구 O, "동댁" → 동대구 O (ㄱ 받침은 다음 글자 첫소리일 수 있음), "동대ㄱ" → 동대구 O
 */
export function startsLike(name, q) {
  if (!q) return false;
  if (name.startsWith(q)) return true;
  const head = q.slice(0, -1);
  const last = q.at(-1);
  if (last in JAMO_CHO) {
    return name.startsWith(head) && choOf(name[head.length]) === JAMO_CHO[last];
  }
  if (!isSyllable(last)) return false;
  const code = last.charCodeAt(0) - BASE;
  const split = JONG_SPLIT[code % 28];
  if (!split) return false;
  const withoutJong = String.fromCharCode(BASE + code - (code % 28) + split[0]);
  const prefix = head + withoutJong;
  return name.startsWith(prefix) && choOf(name[prefix.length]) === split[1];
}

/** 입력으로 시작하는 역 이름 (주요 역 먼저, 짧은 이름 먼저) */
export function matchStations(query, limit = 3) {
  const q = normalizeName(query);
  if ([...q].length < 2) return [];
  return STATION_NAMES
    .filter((name) => startsLike(name, q))
    .sort((a, b) => (MAJOR_STATIONS.has(b) - MAJOR_STATIONS.has(a)) || a.length - b.length || a.localeCompare(b, 'ko'))
    .slice(0, limit);
}

/** 검색 결과 정렬: 이름이 입력으로 시작 → 이름에 포함 → 나머지 (같은 순위는 원래 순서 유지) */
export function rankByName(places, query) {
  const q = normalizeName(query);
  const rank = (p) => {
    const name = normalizeName(p.name);
    if (startsLike(name, q)) return 0;
    if (name.includes(q)) return 1;
    return 2;
  };
  return places.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.p);
}
