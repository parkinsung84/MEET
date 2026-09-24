/**
 * 알림 허브. 한 번의 notify 로
 *  1) 알림함(notifications 테이블)에 저장하고
 *  2) 접속 중인 사용자에게 소켓으로 즉시 보내고
 *  3) 앱을 닫아둔 사용자에게는 Web Push 를 보낸다.
 * 합승 채팅방을 보고 있는 사람에게는 채팅 푸시를 보내지 않는다.
 */
export function createNotifier(db, { push = null, log = console } = {}) {
  let io = null;
  const stmt = {
    insert: db.prepare(`INSERT INTO notifications (user_id, ride_id, type, title, body, url) VALUES (?, ?, ?, ?, ?, ?)`),
    byId: db.prepare('SELECT * FROM notifications WHERE id = ?'),
    list: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    readAll: db.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`),
    subs: db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?'),
    upsertSub: db.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES (?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`),
    deleteSub: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
  };

  const toJson = (n) => ({
    id: n.id, rideId: n.ride_id, type: n.type, title: n.title, body: n.body, url: n.url,
    read: Boolean(n.read_at), createdAt: n.created_at,
  });

  /** 채팅방(소켓 room)에 지금 들어와 있는 사용자 id */
  async function usersInRideRoom(rideId) {
    if (!io) return new Set();
    const sockets = await io.in(`ride:${rideId}`).fetchSockets();
    return new Set(sockets.map((s) => s.data.userId));
  }

  async function sendPush(userId, payload) {
    if (!push) return;
    for (const sub of stmt.subs.all(userId)) {
      try {
        const { expired } = await push.send({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        if (expired) stmt.deleteSub.run(sub.endpoint);
      } catch (err) {
        log.error('[push]', err.message);
      }
    }
  }

  return {
    attach(server) { io = server; },

    /**
     * userIds 에게 알림. skipViewers: 해당 합승 채팅방을 보고 있는 사람은 건너뜀 (채팅 등 빈번한 알림용)
     * store: false 면 알림함에 남기지 않음 (채팅 메시지 — 채팅 내역이 이미 있으므로)
     */
    async notify(userIds, { type, title, body, rideId = null, skipViewers = false, store = true }) {
      const url = rideId ? `/#/rides/${rideId}` : '/#/notifications';
      const viewers = skipViewers && rideId ? await usersInRideRoom(rideId) : new Set();
      await Promise.all([...new Set(userIds)].filter((id) => !viewers.has(id)).map(async (userId) => {
        let notification = { type, title, body, url, rideId };
        if (store) {
          const { lastInsertRowid } = stmt.insert.run(userId, rideId, type, title, body, url);
          notification = toJson(stmt.byId.get(lastInsertRowid));
        }
        io?.to(`user:${userId}`).emit('notification', notification);
        await sendPush(userId, { title, body, url, tag: rideId ? `ride-${rideId}-${type}` : type });
      }));
    },

    list(userId) {
      return { notifications: stmt.list.all(userId).map(toJson), unread: stmt.unread.get(userId).n };
    },
    markAllRead(userId) { stmt.readAll.run(userId); },

    subscribe(userId, subscription) {
      const { endpoint, keys } = subscription ?? {};
      if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys?.p256dh || !keys?.auth) {
        return false;
      }
      stmt.upsertSub.run(endpoint, userId, keys.p256dh, keys.auth);
      return true;
    },
    unsubscribe(endpoint) { stmt.deleteSub.run(endpoint); },
  };
}
