import { HttpError } from './errors.js';
import { inquiryRoom } from './inquiries.js';

const room = (rideId) => `ride:${rideId}`;
const commuteRoom = (id) => `commute:${id}`;

/**
 * 실시간 채널.
 *  - client → server: ride:subscribe(rideId, ack), ride:unsubscribe(rideId), chat:send({ rideId, body }, ack),
 *                     inquiry:subscribe(rideId, ack), inquiry:unsubscribe(rideId)
 *  - server → client: ride:updated(ride), chat:message(message), rides:changed(), notification(n),
 *                     inquiry:message(message) — 문의자 본인과 방을 보고 있는 멤버에게
 * 연결되면 개인 room(user:<id>)에 들어가 알림을 받는다.
 */
export function attachRealtime(io, rides, auth, { calls = null, commutes = null } = {}) {
  io.use((socket, next) => {
    const userId = auth.verify(socket.handshake.auth?.token ?? '');
    if (!userId) return next(new Error('unauthorized'));
    socket.data.userId = userId;
    next();
  });

  const handle = (fn) => (payload, ack = () => {}) => {
    try {
      ack({ ok: true, ...fn(payload) });
    } catch (err) {
      ack({ ok: false, error: err instanceof HttpError ? err.message : '서버 오류가 발생했습니다.' });
    }
  };

  io.on('connection', (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);
    calls?.register(socket);

    socket.on('ride:subscribe', handle((rideId) => {
      if (!rides.isMember(rideId, userId)) throw new HttpError(403, '합승 멤버만 입장할 수 있습니다.');
      socket.join(room(Number(rideId)));
      return {};
    }));

    socket.on('ride:unsubscribe', (rideId) => socket.leave(room(Number(rideId))));

    // 참여 전 문의: 문의자는 자기 대화 room 에만 들어갈 수 있다 (멤버는 ride room 으로 모든 문의를 받음)
    socket.on('inquiry:subscribe', handle((rideId) => {
      socket.join(inquiryRoom(Number(rideId), userId));
      return {};
    }));
    socket.on('inquiry:unsubscribe', (rideId) => socket.leave(inquiryRoom(Number(rideId), userId)));

    // 정기 노선 크루 채팅·갱신 (멤버만)
    socket.on('commute:subscribe', handle((id) => {
      if (!commutes?.isMember(id, userId)) throw new HttpError(403, '노선 멤버만 입장할 수 있습니다.');
      socket.join(commuteRoom(Number(id)));
      return {};
    }));
    socket.on('commute:unsubscribe', (id) => socket.leave(commuteRoom(Number(id))));

    socket.on('chat:send', handle(({ rideId, body } = {}) => {
      const message = rides.postMessage(rideId, userId, body);
      io.to(room(Number(rideId))).emit('chat:message', { rideId: Number(rideId), ...message });
      return { message };
    }));
  });

  return {
    commuteMessage(message) {
      io.to(commuteRoom(message.commuteId)).emit('commute:message', message);
    },
    /** 노선 정보가 바뀌면 멤버 화면 갱신, 나간 사람 소켓은 room 에서 뺀다 */
    async commuteChanged(id) {
      for (const socket of await io.in(commuteRoom(id)).fetchSockets()) {
        if (!commutes.isMember(id, socket.data.userId)) socket.leave(commuteRoom(id));
      }
      io.to(commuteRoom(id)).emit('commute:updated', { id });
      io.emit('commutes:changed');
    },

    /** 문의 메시지를 문의자 대화 room 과 멤버(ride room)에게 전달 (두 room 에 모두 있는 소켓에는 한 번만 감) */
    inquiryPosted(message) {
      io.to(inquiryRoom(message.rideId, message.guestId)).to(room(message.rideId)).emit('inquiry:message', message);
    },

    /**
     * 합승방 상태가 바뀌면 멤버 화면과 목록을 갱신.
     * 나가거나 노쇼 처리된 사람의 소켓은 먼저 방에서 내보낸다 (만남 장소·계좌 등 멤버 전용 정보 차단).
     */
    async rideChanged(rideId) {
      const members = new Set(rides.memberIds(rideId));
      for (const socket of await io.in(room(rideId)).fetchSockets()) {
        if (!members.has(socket.data.userId)) socket.leave(room(rideId));
      }
      io.to(room(rideId)).emit('ride:updated', rides.getForMembers(rideId));
      io.emit('rides:changed');
    },
  };
}
