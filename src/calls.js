import { createHmac, randomUUID } from 'node:crypto';

const RING_TIMEOUT_MS = 30 * 1000;
const MAX_SIGNAL_BYTES = 64 * 1024;
const CALLABLE_STATUSES = new Set(['open', 'departed']);
const TURN_TTL_SEC = 60 * 60;

/**
 * 통화 연결(NAT 통과)용 ICE 서버 목록.
 *  - TURN_SECRET: coturn 의 use-auth-secret 방식 — 사용자별 1시간짜리 임시 계정 발급 (권장)
 *  - TURN_USERNAME / TURN_CREDENTIAL: 고정 계정
 * TURN 이 없으면 STUN 만 사용 (일부 모바일망에서는 연결이 안 될 수 있음)
 */
export function iceServersFor(userId, env = process.env) {
  const servers = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',') }];
  if (env.TURN_URLS) {
    const urls = env.TURN_URLS.split(',');
    if (env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SEC}:${userId}`;
      const credential = createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      servers.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    }
  }
  return servers;
}

/**
 * 탑승자끼리 1:1 음성 통화 (WebRTC). 서버는 연결 협상(SDP/ICE) 메시지만 중계하고 음성은 브라우저끼리 직접 오간다.
 *
 *  client → server: call:invite({ rideId, to }, ack) · call:accept({ callId }, ack) · call:decline({ callId })
 *                   call:signal({ callId, data }) · call:end({ callId })
 *  server → client: call:incoming({ callId, rideId, from }) · call:accepted({ callId }) · call:signal({ callId, data })
 *                   call:ended({ callId, reason })   reason: declined | no-answer | ended | disconnected | answered-elsewhere
 *
 * 통화 상태는 메모리에만 둔다 (서버 1대 기준).
 */
export function createCallService(io, { rides, users, notifier, env = process.env, ringTimeoutMs = RING_TIMEOUT_MS, log = console }) {
  const calls = new Map();   // callId → call
  const busy = new Map();    // userId → callId

  function fire(userIds, notification) {
    notifier?.notify(userIds, notification).catch((err) => log.error('[notify]', err.message));
  }

  function end(call, reason, { notifyUserId = null } = {}) {
    if (!calls.has(call.id)) return;
    clearTimeout(call.timer);
    calls.delete(call.id);
    if (busy.get(call.callerId) === call.id) busy.delete(call.callerId);
    if (busy.get(call.calleeId) === call.id) busy.delete(call.calleeId);
    const payload = { callId: call.id, reason };
    io.to(call.callerSocket).emit('call:ended', payload);
    // 받기 전이면 받는 사람의 모든 기기에서 벨을 멈춘다
    io.to(call.calleeSocket ?? `user:${call.calleeId}`).emit('call:ended', payload);
    if (notifyUserId) {
      fire([notifyUserId], {
        type: 'missed-call', rideId: call.rideId, title: '📞 부재중 통화', body: `${call.callerNickname}님이 음성 통화를 걸었어요.`,
      });
    }
  }

  const fail = (ack, error) => ack({ ok: false, error });

  return {
    /** 소켓 연결마다 호출 */
    register(socket) {
      const { userId } = socket.data;

      socket.on('call:invite', ({ rideId, to } = {}, ack = () => {}) => {
        try {
          const ride = rides.rideRow(rideId);
          const calleeId = Number(to);
          if (!rides.isMember(ride.id, userId) || !rides.isMember(ride.id, calleeId)) return fail(ack, '같은 합승의 탑승자끼리만 통화할 수 있어요.');
          if (calleeId === userId) return fail(ack, '자기 자신에게는 걸 수 없어요.');
          if (!CALLABLE_STATUSES.has(ride.status)) return fail(ack, '모집 중이거나 이동 중인 합승에서만 통화할 수 있어요.');
          if (users.blockedSet(userId).has(calleeId)) return fail(ack, '통화할 수 없는 사용자예요.');
          if (busy.has(userId)) return fail(ack, '이미 통화 중이에요.');
          if (busy.has(calleeId)) return fail(ack, '상대방이 통화 중이에요.');

          const caller = users.profile(userId);
          const call = {
            id: randomUUID(), rideId: ride.id, callerId: userId, calleeId, callerSocket: socket.id, calleeSocket: null,
            callerNickname: caller.nickname, state: 'ringing',
          };
          call.timer = setTimeout(() => end(call, 'no-answer', { notifyUserId: calleeId }), ringTimeoutMs);
          calls.set(call.id, call);
          busy.set(userId, call.id);
          busy.set(calleeId, call.id);

          const from = { id: caller.id, nickname: caller.nickname, gender: caller.gender };
          io.to(`user:${calleeId}`).emit('call:incoming', { callId: call.id, rideId: ride.id, route: `${ride.origin_name} → ${ride.dest_name}`, from });
          // 앱이 꺼져 있으면 푸시로 알린다 (접속 중이면 위 이벤트로 벨이 울림)
          fire([calleeId], {
            type: 'call', rideId: ride.id, title: `📞 ${caller.nickname}님의 음성 통화`, body: '눌러서 MEET 를 열고 받아 주세요.',
            skipRoom: `user:${calleeId}`, store: false,
          });
          ack({ ok: true, callId: call.id, iceServers: iceServersFor(userId, env) });
        } catch (err) {
          fail(ack, err.status ? err.message : '통화를 시작할 수 없어요.');
        }
      });

      socket.on('call:accept', ({ callId } = {}, ack = () => {}) => {
        const call = calls.get(callId);
        if (!call || call.calleeId !== userId || call.state !== 'ringing') return fail(ack, '이미 끝난 통화예요.');
        clearTimeout(call.timer);
        call.state = 'active';
        call.calleeSocket = socket.id;
        // 다른 기기에서 울리던 벨은 끈다
        socket.to(`user:${userId}`).emit('call:ended', { callId, reason: 'answered-elsewhere' });
        io.to(call.callerSocket).emit('call:accepted', { callId });
        ack({ ok: true, iceServers: iceServersFor(userId, env) });
      });

      socket.on('call:decline', ({ callId } = {}) => {
        const call = calls.get(callId);
        if (call?.calleeId === userId && call.state === 'ringing') end(call, 'declined');
      });

      socket.on('call:signal', ({ callId, data } = {}) => {
        const call = calls.get(callId);
        if (!call || call.state !== 'active' || !data || typeof data !== 'object') return;
        if (JSON.stringify(data).length > MAX_SIGNAL_BYTES) return;
        const target = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
        if (target) io.to(target).emit('call:signal', { callId, data });
      });

      socket.on('call:end', ({ callId } = {}) => {
        const call = calls.get(callId);
        if (!call || (socket.id !== call.callerSocket && socket.id !== call.calleeSocket)) return;
        // 받기 전에 건 사람이 끊으면 받는 사람에게는 부재중
        end(call, 'ended', { notifyUserId: call.state === 'ringing' ? call.calleeId : null });
      });

      socket.on('disconnect', () => {
        for (const call of calls.values()) {
          if (call.callerSocket === socket.id || call.calleeSocket === socket.id) end(call, 'disconnected');
        }
      });
    },

    /** 테스트/모니터링용 */
    activeCount: () => calls.size,
  };
}
