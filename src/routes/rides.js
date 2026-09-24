import { Router } from 'express';
import { requireAuth } from '../auth.js';

/**
 * rides: ride service, notify(rideId): 방 상태가 바뀌었을 때 실시간 알림을 보내는 콜백
 */
export function ridesRouter(rides, secret, notify) {
  const router = Router();
  router.use(requireAuth(secret));

  router.get('/', (req, res) => {
    res.json({ rides: rides.search(req.query, req.userId) });
  });

  router.get('/mine', (req, res) => {
    res.json({ rides: rides.mine(req.userId) });
  });

  router.post('/', (req, res) => {
    const ride = rides.create(req.userId, req.body);
    notify(ride.id);
    res.status(201).json({ ride });
  });

  router.get('/:id', (req, res) => {
    res.json({ ride: rides.get(req.params.id) });
  });

  router.post('/:id/join', (req, res) => {
    const ride = rides.join(req.params.id, req.userId);
    notify(ride.id);
    res.json({ ride });
  });

  router.post('/:id/leave', (req, res) => {
    const ride = rides.leave(req.params.id, req.userId);
    notify(ride.id);
    res.json({ ride });
  });

  router.patch('/:id/status', (req, res) => {
    const ride = rides.updateStatus(req.params.id, req.userId, req.body?.status);
    notify(ride.id);
    res.json({ ride });
  });

  router.get('/:id/messages', (req, res) => {
    res.json({ messages: rides.messages(req.params.id, req.userId, req.query.after) });
  });

  return router;
}
