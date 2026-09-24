import { rideCard, trustChips } from '../components.js';
import { api, formatTime, listen, logout, refreshMe, state } from '../core.js';
import { disablePush, enablePush, pushStatus } from '../push.js';
import { h, toast } from '../ui.js';

export function myRidesScreen() {
  const root = h('div', {}, h('h1', {}, '내 합승'));
  api('GET', '/rides/mine')
    .then(({ rides }) => {
      const active = rides.filter((r) => r.status === 'open' || r.status === 'departed');
      const past = rides.filter((r) => r.status === 'completed' || r.status === 'cancelled');
      root.append(
        h('h2', {}, '진행 중'),
        ...(active.length ? active.map(rideCard) : [h('div', { class: 'empty' }, '진행 중인 합승이 없어요.')]),
        ...(past.length ? [h('h2', {}, '지난 합승'), ...past.map(rideCard)] : []),
      );
    })
    .catch((err) => toast(err.message));
  return root;
}

export function notificationsScreen() {
  const list = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  async function load() {
    const { notifications } = await api('GET', '/notifications');
    list.replaceChildren(...(notifications.length
      ? notifications.map((n) => h('a', { class: `card notification${n.read ? '' : ' unread'}`, href: n.url.replace(/^\//, '') },
        h('strong', {}, n.title), h('div', {}, n.body), h('div', { class: 'muted' }, formatTime(n.createdAt.replace(' ', 'T') + 'Z'))))
      : [h('div', { class: 'empty' }, '알림이 없어요.')]));
    await api('POST', '/notifications/read');
    window.dispatchEvent(new Event('notifications:read'));
  }
  load().catch((err) => toast(err.message));
  listen(window, 'notification', () => load().catch(() => {}));
  return h('div', {}, h('h1', {}, '🔔 알림'), list);
}

function pushCard() {
  const box = h('div', { class: 'card stack' });
  async function render() {
    const status = await pushStatus();
    const text = {
      on: '✅ 이 기기에서 알림을 받고 있어요.',
      off: '앱을 닫아도 참여·채팅·출발 10분 전·정산 알림을 받을 수 있어요.',
      denied: '알림이 차단되어 있어요. 브라우저 사이트 설정에서 알림을 허용해 주세요.',
      unsupported: '이 브라우저는 푸시 알림을 지원하지 않아요. 아이폰은 Safari 공유 → "홈 화면에 추가" 후 앱에서 켜 주세요.',
    }[status];
    box.replaceChildren(
      h('h2', {}, '📲 푸시 알림'),
      h('p', { class: 'muted' }, text),
      status === 'off' && h('button', {
        onclick: async () => {
          try { await enablePush(); toast('알림을 켰어요.'); } catch (err) { toast(err.message); }
          render();
        },
      }, '알림 켜기'),
      status === 'on' && h('button', { class: 'secondary', onclick: async () => { await disablePush(); render(); } }, '이 기기 알림 끄기'),
    );
  }
  render();
  return box;
}

function alertsCard() {
  const box = h('div', { class: 'card stack' });
  async function render() {
    const { alerts } = await api('GET', '/alerts');
    box.replaceChildren(
      h('h2', {}, '🔔 경로 알림'),
      h('p', { class: 'muted' }, '검색 결과가 없을 때 "알림 받기"를 누르면, 그 경로로 합승방이 생길 때 알려드려요.'),
      ...(alerts.length ? alerts.map((a) => h('div', { class: 'settle-row' },
        h('span', {}, `${a.origin.name} → ${a.destination.name}`, h('div', { class: 'muted' }, `${formatTime(a.from)} ~ ${formatTime(a.to)}`)),
        h('button', { class: 'secondary small', onclick: async () => { await api('DELETE', `/alerts/${a.id}`); render(); } }, '삭제')))
        : [h('div', { class: 'muted' }, '등록된 알림이 없어요.')]),
    );
  }
  render().catch(() => {});
  return box;
}

function blockedCard() {
  const box = h('div', { class: 'card stack' });
  async function render() {
    const { users } = await api('GET', '/users/blocked');
    box.replaceChildren(h('h2', {}, '🚫 차단한 사용자'),
      ...(users.length ? users.map((u) => h('div', { class: 'settle-row' }, h('span', {}, u.nickname),
        h('button', { class: 'secondary small', onclick: async () => { await api('DELETE', `/users/${u.id}/block`); render(); } }, '차단 해제')))
        : [h('div', { class: 'muted' }, '없음')]));
  }
  render().catch(() => {});
  return box;
}

/** 학교·회사 이메일 인증 (선택) — 같은 소속 전용 합승 */
function orgCard(user) {
  if (user.org || !user.orgCandidate) return null;
  const input = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '인증번호 6자리', 'aria-label': '이메일 인증번호' });
  const dev = h('p', { class: 'muted dev-note', hidden: true });
  return h('div', { class: 'card stack' },
    h('h2', {}, '🎓 소속 인증'),
    h('p', { class: 'muted' }, `${user.email} 로 인증하면 @${user.orgCandidate} 사람들끼리만 타는 합승을 만들 수 있어요.`),
    h('button', {
      class: 'secondary',
      onclick: async () => {
        try {
          const { devCode } = await api('POST', '/auth/email/send');
          if (devCode) Object.assign(dev, { hidden: false, textContent: `개발 모드 인증번호: ${devCode}` });
          toast('인증 메일을 보냈어요.');
        } catch (err) { toast(err.message); }
      },
    }, '인증 메일 받기'),
    dev,
    h('div', { class: 'row' }, input, h('button', {
      class: 'fit',
      onclick: async () => {
        try {
          await api('POST', '/auth/email/verify', { code: input.value });
          await refreshMe();
          toast(`🎓 ${state.user.org} 소속으로 인증되었어요!`);
          location.reload();
        } catch (err) { toast(err.message); }
      },
    }, '인증')));
}

export function profileScreen() {
  const root = h('div', {}, h('h1', {}, '내 정보'));
  refreshMe().then((user) => {
    const s = user.stats;
    // h() 로 감싸 null 카드(소속 인증 불필요 등)를 걸러낸다
    root.append(h('div', {},
      h('div', { class: 'card stack' },
        h('div', { class: 'route' }, user.nickname),
        h('div', { class: 'muted' }, user.email),
        h('div', { class: 'chips' }, trustChips(user)),
        user.identityComplete && h('div', { class: 'muted' }, `${user.name} · ${user.birthDate} · ${user.phone} (나만 보여요)`),
        !user.verified && h('a', { class: 'btn', href: '#/verify' }, '휴대폰 본인 확인하기'),
        h('div', { class: 'fare' },
          h('div', {}, h('span', { class: 'muted' }, '완료한 합승'), h('strong', {}, `${s.completedRides}회`)),
          h('div', {}, h('span', { class: 'muted' }, '매너 점수'), h('strong', {}, s.mannerPercent === null ? '-' : `${s.mannerPercent}%`)),
          h('div', {}, h('span', { class: 'muted' }, '노쇼 / 직전취소'), h('strong', {}, `${s.noShows} / ${s.lateCancels}`))),
        h('p', { class: 'muted' }, '매너 점수와 노쇼 기록은 다른 사용자에게 공개돼요.')),
      orgCard(user),
      pushCard(),
      alertsCard(),
      blockedCard(),
      h('button', { class: 'secondary wide', onclick: logout }, '로그아웃'),
    ));
  }).catch((err) => toast(err.message));
  return root;
}
