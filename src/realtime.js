import { verifyToken } from './auth.js';
import { HttpError } from './errors.js';

const room = (rideId) => `ride:${rideId}`;

/**
 * 실시간 채널.
 *  - client → server: ride:subscribe(rideId, ack), ride:unsubscribe(rideId), chat:send({ rideId, body }, ack)
 *  - server → client: ride:updated(ride), chat:message(message), rides:changed(), notification(n)
 * 연결되면 개인 room(user:<id>)에 들어가 알림을 받는다.
 */
export function attachRealtime(io, rides, secret) {
  io.use((socket, next) => {
    const userId = verifyToken(socket.handshake.auth?.token ?? '', secret);
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

    socket.on('ride:subscribe', handle((rideId) => {
      if (!rides.isMember(rideId, userId)) throw new HttpError(403, '합승 멤버만 입장할 수 있습니다.');
      socket.join(room(Number(rideId)));
      return {};
    }));

    socket.on('ride:unsubscribe', (rideId) => socket.leave(room(Number(rideId))));

    socket.on('chat:send', handle(({ rideId, body } = {}) => {
      const message = rides.postMessage(rideId, userId, body);
      io.to(room(Number(rideId))).emit('chat:message', { rideId: Number(rideId), ...message });
      return { message };
    }));
  });

  return {
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
