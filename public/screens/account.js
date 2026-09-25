import { rideCard, trustChips } from '../components.js';
import { api, formatTime, listen, logout, refreshMe, setSession, state } from '../core.js';
import { disablePush, enablePush, pushStatus } from '../push.js';
import { ask, h, sheet, toast } from '../ui.js';
import { commuteCard } from './commutes.js';

export function myRidesScreen() {
  const root = h('div', {}, h('h1', {}, '내 출퇴근 노선'));
  const commuteBox = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  root.append(commuteBox, h('h1', {}, '내 합승'));
  api('GET', '/commutes/mine')
    .then(({ commutes }) => commuteBox.replaceChildren(...(commutes.length
      ? commutes.map(commuteCard)
      : [h('div', { class: 'empty stack' }, h('div', {}, '참여 중인 노선이 없어요.'),
        h('a', { class: 'btn', href: '#/' }, '노선 찾아보기'))])))
    .catch((err) => toast(err.message));
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
    // h() 로 감싸 false 자식(상태에 맞지 않는 버튼)을 걸러낸다
    box.replaceChildren(h('div', { class: 'stack' },
      h('h2', {}, '📲 푸시 알림'),
      h('p', { class: 'muted' }, text),
      status === 'off' && h('button', {
        onclick: async () => {
          try { await enablePush(); toast('알림을 켰어요.'); } catch (err) { toast(err.message); }
          render();
        },
      }, '알림 켜기'),
      status === 'on' && h('button', { class: 'secondary', onclick: async () => { await disablePush(); render(); } }, '이 기기 알림 끄기'),
    ));
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

const LOCATION_ACTIONS = {
  reverse_geocode: '📍 현재 위치 → 주소 변환',
  place_search: '🔎 장소 검색 (현재 위치 근처 먼저)',
  commute_create: '🔁 정기 노선 등록',
  search: '🔍 주변 합승 검색',
  ride_create: '🚕 합승방 생성',
  dropoff: '🛑 하차 지점 설정',
  alert: '🔔 경로 알림 등록',
  share_view: '🔗 안심 공유 조회',
};

/** 위치정보 이용·제공 사실 확인자료 열람 (위치정보법) */
function locationLogCard() {
  const list = h('div', { class: 'stack', hidden: true });
  return h('div', { class: 'card stack' },
    h('h2', {}, '📍 위치정보 이용 내역'),
    h('p', { class: 'muted' }, '내 위치정보를 언제, 무슨 목적으로 이용·제공했는지 확인할 수 있어요 (1년 보관). 좌표는 기록하지 않아요.'),
    h('button', {
      class: 'secondary',
      onclick: async () => {
        list.hidden = !list.hidden;
        if (list.hidden) return;
        try {
          const { logs } = await api('GET', '/me/location-logs');
          list.replaceChildren(...(logs.length ? logs.map((l) => h('div', { class: 'log-row' },
            h('div', {}, LOCATION_ACTIONS[l.action] ?? l.action),
            h('div', { class: 'muted' }, `${formatTime(l.createdAt)} · ${l.purpose}${l.recipient ? ` · 제공: ${l.recipient}` : ''}`)))
            : [h('div', { class: 'muted' }, '기록이 없어요.')]));
        } catch (err) { toast(err.message); }
      },
    }, '내역 보기'),
    list);
}

/** 계정 보안: 비밀번호 변경, 모든 기기 로그아웃, 회원 탈퇴 */
function securityCard() {
  const current = h('input', { type: 'password', placeholder: '현재 비밀번호', autocomplete: 'current-password', 'aria-label': '현재 비밀번호' });
  const next = h('input', { type: 'password', placeholder: '새 비밀번호 (8자 이상)', autocomplete: 'new-password', 'aria-label': '새 비밀번호' });
  const changeForm = h('form', { class: 'stack', hidden: true }, current, next, h('button', {}, '변경하기'));
  changeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('POST', '/auth/password', { currentPassword: current.value, newPassword: next.value });
      setSession(token, state.user);
      toast('비밀번호를 바꿨어요. 다른 기기에서는 로그아웃되었어요.');
      changeForm.hidden = true;
      current.value = next.value = '';
    } catch (err) {
      toast(err.message);
    }
  });

  function openWithdraw() {
    const password = h('input', { type: 'password', placeholder: '비밀번호 확인', autocomplete: 'current-password', 'aria-label': '탈퇴 비밀번호 확인' });
    sheet('회원 탈퇴', h('div', { class: 'stack' },
      h('p', {}, '탈퇴하면 이메일·실명·생년월일·휴대폰 번호 등 개인정보가 즉시 삭제되고 되돌릴 수 없어요.'),
      h('ul', { class: 'muted' },
        h('li', {}, '함께 탄 합승 기록과 채팅은 "탈퇴한 사용자"로 익명화되어 남아요.'),
        h('li', {}, '노쇼·직전취소 횟수는 부정 이용 방지를 위해 1년간 보관되고, 같은 번호로 다시 가입하면 이어져요.'),
        h('li', {}, '진행 중인 합승이나 보내지 않은 정산이 있으면 먼저 정리해야 해요.')),
      password), [
      { label: '취소', class: 'secondary', onClick: (close) => close() },
      {
        label: '탈퇴하기',
        class: 'danger',
        onClick: async (close) => {
          try {
            await api('DELETE', '/auth/me', { password: password.value });
            close();
            toast('탈퇴가 완료되었어요. 그동안 이용해 주셔서 고마워요.');
            logout();
          } catch (err) {
            toast(err.message);
          }
        },
      },
    ]);
  }

  return h('div', { class: 'card stack' },
    h('h2', {}, '🔐 계정 보안'),
    h('button', { class: 'secondary', onclick: () => { changeForm.hidden = !changeForm.hidden; } }, '비밀번호 변경'),
    changeForm,
    h('button', {
      class: 'secondary',
      onclick: async () => {
        if (!await ask('모든 기기에서 로그아웃할까요?', '폰을 잃어버렸거나 다른 사람이 로그인한 것 같을 때 사용하세요. 이 기기도 로그아웃돼요.', { confirmLabel: '모두 로그아웃', danger: true })) return;
        try {
          await api('POST', '/auth/logout-all');
          logout();
        } catch (err) { toast(err.message); }
      },
    }, '모든 기기에서 로그아웃'),
    h('button', { class: 'link danger-text', onclick: openWithdraw }, '회원 탈퇴'));
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
        !user.verified && state.config.verificationRequired !== false && h('a', { class: 'btn', href: '#/verify' }, '휴대폰 본인 확인하기'),
        h('div', { class: 'fare' },
          h('div', {}, h('span', { class: 'muted' }, '완료한 합승'), h('strong', {}, `${s.completedRides}회`)),
          h('div', {}, h('span', { class: 'muted' }, '매너 점수'), h('strong', {}, s.mannerPercent === null ? '-' : `${s.mannerPercent}%`)),
          h('div', {}, h('span', { class: 'muted' }, '노쇼 / 직전취소'), h('strong', {}, `${s.noShows} / ${s.lateCancels}`))),
        h('p', { class: 'muted' }, '매너 점수와 노쇼 기록은 다른 사용자에게 공개돼요.')),
      orgCard(user),
      pushCard(),
      alertsCard(),
      blockedCard(),
      locationLogCard(),
      securityCard(),
      h('button', { class: 'secondary wide', onclick: logout }, '로그아웃'),
      h('p', { class: 'legal-links muted' },
        h('a', { href: '/legal/terms.html', target: '_blank' }, '이용약관'), ' · ',
        h('a', { href: '/legal/privacy.html', target: '_blank' }, h('strong', {}, '개인정보처리방침')), ' · ',
        h('a', { href: '/legal/location.html', target: '_blank' }, '위치기반서비스 이용약관')),
    ));
  }).catch((err) => toast(err.message));
  return root;
}
