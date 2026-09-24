import webpush from 'web-push';

/**
 * Web Push 발송기. VAPID 키는 환경변수 → DB 저장값 → 새로 생성 순으로 사용한다.
 * (한 번 만든 키를 DB에 저장해 두어야 서버 재시작 후에도 기존 구독이 유효하다)
 */
export function createWebPush(db, env = process.env) {
  const get = db.prepare('SELECT value FROM settings WHERE key = ?');
  const set = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  let keys;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else {
    const stored = get.get('vapid');
    keys = stored ? JSON.parse(stored.value) : webpush.generateVAPIDKeys();
    if (!stored) set.run('vapid', JSON.stringify(keys));
  }
  const subject = env.VAPID_SUBJECT || 'mailto:admin@example.com';

  return {
    publicKey: keys.publicKey,
    /** 발송. 구독이 만료됐으면 { expired: true } */
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload), {
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 60 * 60,
        });
        return { expired: false };
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) return { expired: true };
        throw err;
      }
    },
  };
}
