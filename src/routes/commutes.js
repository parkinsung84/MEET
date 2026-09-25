import { Router } from 'express';

/**
 * 정기 노선 API. 목록·상세는 로그인 없이도 볼 수 있다 (링크 공유로 사람을 모으기 위해).
 * changed(commuteId): 멤버 화면 실시간 갱신, messagePosted(message): 크루 채팅 전달
 */
export function commutesRouter({ commutes, auth, changed = () => {}, messagePosted = () => {} }) {
  const router = Router();

  router.get('/', auth.optional, (req, res) => {
    res.json({ commutes: commutes.search(req.query, req.userId) });
  });

  router.get('/mine', auth.required, (req, res) => {
    res.json({ commutes: commutes.mine(req.userId) });
  });

  router.get('/:id', auth.optional, (req, res) => {
    res.json({ commute: commutes.get(req.params.id, req.userId) });
  });

  router.post('/', auth.required, async (req, res) => {
    res.status(201).json({ commute: await commutes.create(req.userId, req.body) });
  });

  router.patch('/:id', auth.required, (req, res) => {
    const commute = commutes.update(req.params.id, req.userId, req.body);
    changed(commute.id);
    res.json({ commute });
  });

  router.post('/:id/join', auth.required, (req, res) => {
    const commute = commutes.join(req.params.id, req.userId);
    changed(commute.id);
    res.json({ commute });
  });

  router.post('/:id/leave', auth.required, (req, res) => {
    commutes.leave(req.params.id, req.userId);
    changed(Number(req.params.id));
    res.json({ ok: true });
  });

  router.delete('/:id/members/:userId', auth.required, (req, res) => {
    const commute = commutes.removeMember(req.params.id, req.userId, Number(req.params.userId));
    changed(commute.id);
    res.json({ commute });
  });

  router.get('/:id/messages', auth.required, (req, res) => {
    res.json({ messages: commutes.messages(req.params.id, req.userId, req.query.after) });
  });

  router.post('/:id/messages', auth.required, (req, res) => {
    const message = commutes.postMessage(req.params.id, req.userId, req.body?.body);
    messagePosted(message);
    res.status(201).json({ message });
  });

  return router;
}
