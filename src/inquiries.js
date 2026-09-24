import { conflict, forbidden, HttpError, notFound } from './errors.js';

const MAX_UNANSWERED = 5; // 답장을 받기 전 문의자가 연속으로 보낼 수 있는 메시지 수 (도배 방지)
const MAX_LENGTH = 500;

export const inquiryRoom = (rideId, guestId) => `inquiry:${rideId}:${guestId}`;

/**
 * 참여 전 문의. 합승방마다 문의자(guest)별로 하나의 대화가 있고, 방의 멤버 누구나 답할 수 있다.
 * 문의자는 참여 조건(성별·소속·차단)을 만족하는 인증 사용자여야 한다.
 */
export function createInquiryService(db, { rides, users, notifier, log = console }) {
  const stmt = {
    insert: db.prepare('INSERT INTO inquiry_messages (ride_id, guest_id, sender_id, body) VALUES (?, ?, ?, ?)'),
    byId: db.prepare(`SELECT i.id, i.guest_id AS guestId, i.sender_id AS senderId, u.nickname, i.body, i.created_at AS createdAt
      FROM inquiry_messages i JOIN users u ON u.id = i.sender_id WHERE i.id = ?`),
    thread: db.prepare(`SELECT i.id, i.guest_id AS guestId, i.sender_id AS senderId, u.nickname, i.body, i.created_at AS createdAt
      FROM inquiry_messages i JOIN users u ON u.id = i.sender_id
      WHERE i.ride_id = ? AND i.guest_id = ? ORDER BY i.id LIMIT 300`),
    threads: db.prepare(`
      SELECT i.guest_id AS guestId, COUNT(*) AS count, MAX(i.id) AS lastId
      FROM inquiry_messages i WHERE i.ride_id = ? GROUP BY i.guest_id ORDER BY lastId DESC`),
    lastSenders: db.prepare('SELECT sender_id FROM inquiry_messages WHERE ride_id = ? AND guest_id = ? ORDER BY id DESC LIMIT ?'),
    hasThread: db.prepare('SELECT 1 FROM inquiry_messages WHERE ride_id = ? AND guest_id = ? LIMIT 1'),
  };

  function fire(userIds, notification) {
    if (!userIds.length) return;
    notifier.notify(userIds, notification).catch((err) => log.error('[notify]', err.message));
  }

  /** 대화를 볼 수 있는 사람: 문의자 본인 또는 방의 멤버 */
  function assertCanView(ride, guestId, userId) {
    if (userId !== guestId && !rides.isMember(ride.id, userId)) throw forbidden('볼 수 없는 대화입니다.');
  }

  return {
    /** 멤버용: 이 방에 온 문의 목록 (최근 대화 순) */
    threads(rideId, userId) {
      const ride = rides.rideRow(rideId);
      if (!rides.isMember(ride.id, userId)) throw forbidden('합승 멤버만 문의 목록을 볼 수 있습니다.');
      return stmt.threads.all(ride.id).map((t) => {
        const last = stmt.byId.get(t.lastId);
        return {
          guest: users.profile(t.guestId),
          joined: rides.isMember(ride.id, t.guestId),
          count: t.count,
          lastMessage: last,
          // 마지막 메시지가 문의자 것이면 아직 답을 기다리는 중
          awaitingReply: last.senderId === t.guestId,
        };
      });
    },

    messages(rideId, guestId, userId) {
      const ride = rides.rideRow(rideId);
      assertCanView(ride, Number(guestId), userId);
      return stmt.thread.all(ride.id, Number(guestId));
    },

    /** 메시지 보내기. 문의자는 자기 대화에, 멤버는 기존 문의에 답장 */
    post(rideId, guestId, senderId, body) {
      const ride = rides.rideRow(rideId);
      const guest = Number(guestId);
      const text = typeof body === 'string' ? body.trim() : '';
      if (!text) throw new HttpError(400, '메시지를 입력해 주세요.');
      if (text.length > MAX_LENGTH) throw new HttpError(400, `메시지는 ${MAX_LENGTH}자 이하로 입력해 주세요.`);
      if (ride.status !== 'open') throw conflict('모집이 끝난 합승방에는 문의할 수 없어요.');

      const fromGuest = senderId === guest;
      if (fromGuest) {
        users.requireVerified(senderId);
        if (rides.isMember(ride.id, senderId)) throw conflict('이미 참여 중이에요. 합승 채팅을 이용해 주세요.');
        const reason = rides.eligibilityReason(ride.id, senderId);
        if (reason) throw forbidden(reason);
        const recent = stmt.lastSenders.all(ride.id, guest, MAX_UNANSWERED).map((r) => r.sender_id);
        if (recent.length === MAX_UNANSWERED && recent.every((id) => id === guest)) {
          throw new HttpError(429, '답장을 받은 뒤에 더 보낼 수 있어요.');
        }
      } else {
        if (!rides.isMember(ride.id, senderId)) throw forbidden('합승 멤버만 문의에 답할 수 있습니다.');
        if (!stmt.hasThread.get(ride.id, guest)) throw notFound('존재하지 않는 문의입니다.');
        if (users.blockedSet(senderId).has(guest)) throw forbidden('차단한 사용자입니다.');
      }

      const { lastInsertRowid } = stmt.insert.run(ride.id, guest, senderId, text);
      const message = stmt.byId.get(lastInsertRowid);
      const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      if (fromGuest) {
        // 방 화면을 보고 있는 멤버는 실시간으로 보이므로 푸시 생략
        fire(rides.memberIds(ride.id), {
          type: 'inquiry', rideId: ride.id, title: `💬 참여 문의 · ${message.nickname}`, body: preview, skipViewers: true,
        });
      } else {
        fire([guest], {
          type: 'inquiry-reply', rideId: ride.id, title: `💬 ${message.nickname}님의 답장`,
          body: `${ride.origin_name} → ${ride.dest_name}: ${preview}`, skipRoom: inquiryRoom(ride.id, guest),
        });
      }
      return { rideId: ride.id, ...message };
    },
  };
}
