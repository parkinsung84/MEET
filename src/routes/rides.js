import { Router } from 'express';
import { badRequest } from '../errors.js';

/**
 * rides: ride service, users: 사용자 서비스(평가), alerts: 경로 알림, inquiries: 참여 전 문의
 * changed(rideId): 방 상태가 바뀌었을 때 실시간 갱신을 보내는 콜백
 * inquiryPosted(message): 문의 메시지를 실시간으로 전달하는 콜백
 */
export function ridesRouter({ rides, users, alerts, inquiries, auth, matcher, changed, inquiryPosted }) {
  const router = Router();
  router.use(auth.required);

  const notifyChange = (rideId) => changed(rideId).catch((err) => console.error('[realtime]', err));
  const respond = (res, ride, extra = {}) => {
    notifyChange(ride.id);
    res.json({ ride, ...extra });
  };

  router.get('/', (req, res) => {
    const { originLat, originLng, destLat, destLng, from, to } = req.query;
    const ridesFound = rides.search(req.query, req.userId);
    // 출발지·도착지를 모두 주면 "이 경로를 찾는 사람 수"도 함께
    const demand = originLat && destLat
      ? matcher.demand({ origin: { lat: Number(originLat), lng: Number(originLng) }, destination: { lat: Number(destLat), lng: Number(destLng) }, from, to }, req.userId)
      : null;
    res.json({ rides: ridesFound, demand });
  });

  // 방 만들기 전 확인: 출발·도착 1km, 출발 시간 ±20분 안의 비슷한 방
  router.get('/similar', (req, res) => {
    const at = Date.parse(req.query.departAt);
    if (!Number.isFinite(at)) throw badRequest('출발 시간이 올바르지 않습니다.');
    const found = rides.search({
      ...req.query, radiusKm: 1,
      from: new Date(at - 20 * 60 * 1000).toISOString(), to: new Date(at + 20 * 60 * 1000).toISOString(),
    }, req.userId, { log: false }).filter((r) => !r.joined);
    res.json({ rides: found });
  });

  router.get('/mine', (req, res) => {
    res.json({ rides: rides.mine(req.userId) });
  });

  router.post('/', async (req, res) => {
    const ride = await rides.create(req.userId, req.body);
    notifyChange(ride.id);
    alerts.dispatch(ride.id);
    // 기다리던 매칭 요청을 이 방에 넣고, 비슷한 방 방장들에게 알림
    matcher.onRideCreated(ride.id).catch((err) => console.error('[matcher]', err));
    res.status(201).json({ ride });
  });

  router.get('/:id', (req, res) => {
    res.json({ ride: rides.get(req.params.id, req.userId), myRatings: users.myRatings(req.params.id, req.userId) });
  });

  router.post('/:id/join', (req, res) => respond(res, rides.join(req.params.id, req.userId, req.body ?? {})));

  router.post('/:id/leave', (req, res) => {
    const { ride, lateCancel } = rides.leave(req.params.id, req.userId);
    respond(res, ride, { lateCancel });
  });

  router.patch('/:id/meeting-point', (req, res) => respond(res, rides.setMeetingPoint(req.params.id, req.userId, req.body?.meetingPoint)));

  router.post('/:id/arrive', (req, res) => respond(res, rides.arrive(req.params.id, req.userId)));

  router.patch('/:id/status', (req, res) => {
    respond(res, rides.updateStatus(req.params.id, req.userId, req.body?.status, { noShowIds: req.body?.noShowIds }));
  });

  router.post('/:id/settlement', (req, res) => respond(res, rides.settle(req.params.id, req.userId, req.body ?? {})));

  router.post('/:id/settlement/paid', (req, res) => {
    respond(res, rides.markPaid(req.params.id, req.userId, req.body?.userId ?? req.userId));
  });

  router.get('/:id/similar', (req, res) => res.json({ rides: rides.similarRides(req.params.id, req.userId) }));
  router.post('/:id/merge', (req, res) => {
    const ride = rides.mergeInto(req.params.id, req.userId, req.body?.targetId);
    notifyChange(Number(req.params.id));
    respond(res, ride);
  });

  router.put('/:id/seat', (req, res) => respond(res, rides.setSeat(req.params.id, req.userId, req.body?.seat)));
  router.post('/:id/emergency', (req, res) => res.json(rides.emergency(req.params.id, req.userId)));

  router.put('/:id/taxi', (req, res) => respond(res, rides.recordTaxi(req.params.id, req.userId, req.body ?? {})));

  router.post('/:id/share', (req, res) => {
    const token = rides.createShare(req.params.id, req.userId);
    res.status(201).json({ token, url: `/share.html#${token}` });
  });
  router.delete('/:id/share', (req, res) => {
    rides.revokeShares(req.params.id, req.userId);
    res.json({ ok: true });
  });

  router.post('/:id/ratings', (req, res) => {
    res.json({ myRatings: users.rate(req.params.id, req.userId, req.body?.ratings) });
  });

  // 참여 전 문의 — 멤버: 문의 목록, 문의자/멤버: 대화 보기·보내기
  router.get('/:id/inquiries', (req, res) => {
    res.json({ threads: inquiries.threads(req.params.id, req.userId) });
  });
  router.get('/:id/inquiries/:guestId', (req, res) => {
    res.json({ messages: inquiries.messages(req.params.id, req.params.guestId, req.userId) });
  });
  router.post('/:id/inquiries/:guestId', (req, res) => {
    const message = inquiries.post(req.params.id, req.params.guestId, req.userId, req.body?.body);
    inquiryPosted(message);
    res.status(201).json({ message });
  });

  router.get('/:id/messages', (req, res) => {
    res.json({ messages: rides.messages(req.params.id, req.userId, req.query.after) });
  });

  return router;
}
