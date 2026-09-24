import { Router } from 'express';
import { requireAuth } from '../auth.js';

/**
 * rides: ride service, users: 사용자 서비스(평가), alerts: 경로 알림
 * changed(rideId): 방 상태가 바뀌었을 때 실시간 갱신을 보내는 콜백
 */
export function ridesRouter({ rides, users, alerts, secret, changed }) {
  const router = Router();
  router.use(requireAuth(secret));

  const notifyChange = (rideId) => changed(rideId).catch((err) => console.error('[realtime]', err));
  const respond = (res, ride, extra = {}) => {
    notifyChange(ride.id);
    res.json({ ride, ...extra });
  };

  router.get('/', (req, res) => {
    res.json({ rides: rides.search(req.query, req.userId) });
  });

  router.get('/mine', (req, res) => {
    res.json({ rides: rides.mine(req.userId) });
  });

  router.post('/', async (req, res) => {
    const ride = await rides.create(req.userId, req.body);
    notifyChange(ride.id);
    alerts.dispatch(ride.id);
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

  router.post('/:id/ratings', (req, res) => {
    res.json({ myRatings: users.rate(req.params.id, req.userId, req.body?.ratings) });
  });

  router.get('/:id/messages', (req, res) => {
    res.json({ messages: rides.messages(req.params.id, req.userId, req.query.after) });
  });

  return router;
}
