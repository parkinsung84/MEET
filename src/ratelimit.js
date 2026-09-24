/**
 * 간단한 메모리 기반 호출 제한 (서버 1대 기준).
 * hit(key): 이번 시도를 기록하고 { allowed, retryAfterSec } 반환. 창(windowMs) 안의 시도가 max 를 넘으면 거절.
 */
export function createLimiter({ windowMs, max }) {
  const hits = new Map(); // key → [timestamps]
  const recent = (key, now) => (hits.get(key) ?? []).filter((t) => now - t < windowMs);

  return {
    /** 시도 기록 없이 이미 막혀 있는지만 확인 */
    check(key, now = Date.now()) {
      const list = recent(key, now);
      return list.length >= max
        ? { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - list[0])) / 1000) }
        : { allowed: true, retryAfterSec: 0 };
    },
    hit(key, now = Date.now()) {
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 10_000) {
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      }
      return list.length > max
        ? { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - list[0])) / 1000) }
        : { allowed: true, retryAfterSec: 0 };
    },
    reset(key) {
      hits.delete(key);
    },
  };
}
