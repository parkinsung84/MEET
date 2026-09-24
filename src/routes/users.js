import { Router } from 'express';
import { badRequest } from '../errors.js';

const targetId = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw badRequest('잘못된 사용자입니다.');
  return id;
};

export function usersRouter(users, auth) {
  const router = Router();
  router.use(auth.required);

  router.get('/blocked', (req, res) => res.json({ users: users.listBlocked(req.userId) }));
  router.get('/:id', (req, res) => res.json({ user: users.profile(targetId(req)) }));
  router.post('/:id/block', (req, res) => {
    users.block(req.userId, targetId(req));
    res.json({ ok: true });
  });
  router.delete('/:id/block', (req, res) => {
    users.unblock(req.userId, targetId(req));
    res.json({ ok: true });
  });
  router.post('/:id/report', (req, res) => {
    users.report(req.userId, targetId(req), req.body ?? {});
    res.status(201).json({ ok: true });
  });
  return router;
}

export function notificationsRouter(notifier, auth) {
  const router = Router();
  router.use(auth.required);
  router.get('/', (req, res) => res.json(notifier.list(req.userId)));
  router.post('/read', (req, res) => {
    notifier.markAllRead(req.userId);
    res.json({ ok: true });
  });
  router.post('/push', (req, res) => {
    if (!notifier.subscribe(req.userId, req.body?.subscription)) throw badRequest('잘못된 푸시 구독 정보입니다.');
    res.status(201).json({ ok: true });
  });
  router.delete('/push', (req, res) => {
    if (typeof req.body?.endpoint === 'string') notifier.unsubscribe(req.body.endpoint);
    res.json({ ok: true });
  });
  return router;
}

export function alertsRouter(alerts, users, auth) {
  const router = Router();
  router.use(auth.required);
  router.get('/', (req, res) => res.json({ alerts: alerts.list(req.userId) }));
  router.post('/', (req, res) => {
    users.requireVerified(req.userId);
    res.status(201).json({ alert: alerts.create(req.userId, req.body) });
  });
  router.delete('/:id', (req, res) => {
    alerts.remove(req.userId, req.params.id);
    res.json({ ok: true });
  });
  return router;
}
