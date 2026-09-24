const RETENTION_MS = 365 * 24 * 3600 * 1000; // 법정 최소 6개월, 여유 있게 1년 보관 후 파기

/**
 * 위치정보 이용·제공 사실 확인자료 자동 기록 (위치정보법 제16조 제2항).
 * 좌표는 저장하지 않고, 누구의 위치정보를 언제·어떤 목적으로 이용했는지, 누구에게 제공했는지만 남긴다.
 */
export function createLocationLog(db) {
  const insert = db.prepare('INSERT INTO location_usage_logs (user_id, action, purpose, recipient, created_at) VALUES (?, ?, ?, ?, ?)');
  const list = db.prepare(`SELECT action, purpose, recipient, created_at AS createdAt FROM location_usage_logs
    WHERE user_id = ? ORDER BY id DESC LIMIT 200`);
  const recent = db.prepare(`SELECT 1 FROM location_usage_logs WHERE user_id = ? AND action = ? AND recipient IS ? AND created_at > ? LIMIT 1`);
  const purge = db.prepare('DELETE FROM location_usage_logs WHERE created_at < ?');

  return {
    /** throttleMs: 같은 기록이 이 시간 안에 이미 있으면 생략 (반복 조회 등) */
    record(userId, { action, purpose, recipient = null }, { throttleMs = 0 } = {}) {
      if (!userId) return;
      const now = Date.now();
      if (throttleMs && recent.get(userId, action, recipient, new Date(now - throttleMs).toISOString())) return;
      insert.run(userId, action, purpose, recipient, new Date(now).toISOString());
    },
    list(userId) {
      return list.all(userId);
    },
    purgeExpired(now = Date.now()) {
      purge.run(new Date(now - RETENTION_MS).toISOString());
    },
  };
}
