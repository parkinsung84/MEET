import { Server } from 'socket.io';
import { verifyToken } from './auth.js';
import { HttpError } from './errors.js';

const room = (rideId) => `ride:${rideId}`;

/**
 * 실시간 채널.
 *  - client → server: ride:subscribe(rideId, ack), chat:send({ rideId, body }, ack)
 *  - server → client: ride:updated(ride), chat:message(message), rides:changed()
 */
export function attachRealtime(httpServer, rides, secret) {
  const io = new Server(httpServer);

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
    io,
    notifyRide(rideId) {
      io.to(room(rideId)).emit('ride:updated', rides.get(rideId));
      io.emit('rides:changed');
    },
  };
}
