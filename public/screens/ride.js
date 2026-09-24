import { startCall } from '../call.js';
import { genderChip, placePicker, routeSummary, trustChips } from '../components.js';
import { api, emit, formatTime, GENDER_LABEL, listen, minutesUntil, onLeave, relativeTime, state, STATUS_LABEL, won } from '../core.js';
import { mapsAvailable, renderRouteMap } from '../maps.js';
import { ask, copyText, h, sheet, toast } from '../ui.js';

const CHECKIN_OPEN_MIN = 60;
const LATE_CANCEL_MIN = 10;
const SAME_DEST_KM = 0.5;

function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

export function rideScreen(rideId) {
  const root = h('div', {}, h('div', { class: 'empty' }, '불러오는 중…'));
  const chatLog = h('div', { class: 'chat-log' });
  // 지도는 한 번만 그리고, 아래 정보 영역(root)만 다시 렌더링한다
  const mapEl = h('div', { class: 'route-map' });
  const mapCard = h('div', { class: 'card map-card needs-map', hidden: true }, mapEl);
  let ride = null;
  let myRatings = [];
  let subscribed = false;
  // 참여 전 문의: 문의자(나)의 대화 / 멤버가 보는 문의 목록과 열려 있는 대화
  const inquiryLog = h('div', { class: 'chat-log' });
  let inquiryLoaded = false;
  let inquirySubscribed = false;
  let threads = [];
  let threadsLoaded = false;
  let openThread = null; // { guestId, log }

  const me = () => state.user.id;
  const isMember = () => ride?.members.some((m) => m.id === me());
  const isHost = () => ride?.hostId === me();
  const myMember = () => ride?.members.find((m) => m.id === me());

  function bubble(log, senderId, nickname, body) {
    const mine = senderId === me();
    log.append(h('div', { class: `msg${mine ? ' me' : ''}` },
      !mine && h('div', { class: 'who' }, nickname),
      body));
    log.scrollTop = log.scrollHeight;
  }
  const appendMessage = (msg) => bubble(chatLog, msg.userId, msg.nickname, msg.body);
  const appendInquiry = (log, msg) => bubble(log, msg.senderId, msg.nickname, msg.body);

  /** 채팅 입력줄. send(text)가 성공하면 입력창을 비운다 */
  function composer(placeholder, send) {
    const input = h('input', { placeholder, maxlength: 500, autocomplete: 'off' });
    const form = h('form', { class: 'row' }, input, h('button', { class: 'fit' }, '전송'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      try {
        await send(input.value);
        input.value = '';
      } catch (err) {
        toast(err.message);
      }
    });
    return { form, input };
  }

  // ---------- 참여 전 문의 ----------

  async function loadGuestInquiry() {
    if (!inquirySubscribed) {
      await emit('inquiry:subscribe', ride.id);
      inquirySubscribed = true;
    }
    if (inquiryLoaded) return;
    const { messages } = await api('GET', `/rides/${ride.id}/inquiries/${me()}`);
    inquiryLoaded = true;
    inquiryLog.replaceChildren();
    messages.forEach((m) => appendInquiry(inquiryLog, m));
  }

  const canInquire = () => !isMember() && ride.status === 'open' && state.user.verified;
  // 입력 중인 글이 다시 그리기로 지워지지 않도록 카드는 한 번만 만들어 재사용한다
  let inquiryInput = null;
  let guestCard = null;
  function guestInquiryCard() {
    if (!canInquire()) return null;
    if (guestCard) return guestCard;
    const { form, input } = composer('예: 캐리어 있어도 될까요? / 5분 늦어도 괜찮나요?',
      (text) => api('POST', `/rides/${ride.id}/inquiries/${me()}`, { body: text }));
    inquiryInput = input;
    guestCard = h('div', { class: 'card', id: 'inquiry' },
      h('h2', {}, '💬 참여 전 문의'),
      h('p', { class: 'muted' }, '참여하기 전에 방 멤버들에게 궁금한 점을 물어보고 조율해 보세요. 이 대화는 나와 방 멤버만 볼 수 있어요.'),
      h('div', { class: 'chat inquiry-chat' }, inquiryLog, form));
    return guestCard;
  }

  async function loadThreads() {
    if (!isMember()) return;
    ({ threads } = await api('GET', `/rides/${ride.id}/inquiries`));
    const box = root.querySelector('#inquiry-threads');
    if (box) box.replaceWith(threadsCard());
  }

  function openThreadSheet(thread) {
    const log = h('div', { class: 'chat-log' });
    openThread = { guestId: thread.guest.id, log };
    const { form } = composer(thread.joined ? '참여한 사람은 합승 채팅에서 대화해요' : '답장 입력',
      (text) => api('POST', `/rides/${ride.id}/inquiries/${thread.guest.id}`, { body: text }));
    const close = sheet(`${thread.guest.nickname}님의 문의`, h('div', { class: 'stack' },
      h('div', { class: 'chips' }, trustChips(thread.guest)),
      h('div', { class: 'chat inquiry-chat' }, log, !thread.joined && ride.status === 'open' && form)));
    // 시트가 닫히면 열린 대화 해제
    const observer = new MutationObserver(() => {
      if (!log.isConnected) {
        openThread = null;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true });
    api('GET', `/rides/${ride.id}/inquiries/${thread.guest.id}`)
      .then(({ messages }) => messages.forEach((m) => appendInquiry(log, m)))
      .catch((err) => { toast(err.message); close(); });
  }

  function threadsCard() {
    if (!isMember()) return null;
    // 문의가 없어도 자리를 남겨 두어 새 문의가 오면 이 자리에 그린다
    if (!threads.length) return h('div', { id: 'inquiry-threads' });
    const waiting = threads.filter((t) => t.awaitingReply && !t.joined).length;
    return h('div', { class: 'card', id: 'inquiry-threads' },
      h('h2', {}, `💬 참여 문의 ${threads.length}건`, waiting > 0 && h('span', { class: 'chip warn' }, `답장 대기 ${waiting}`)),
      h('ul', { class: 'members' }, threads.map((t) => h('li', { class: 'thread', onclick: () => openThreadSheet(t) },
        h('div', { class: 'member-name' },
          t.guest.nickname,
          genderChip(t.guest.gender),
          t.joined && h('span', { class: 'chip ok' }, '참여함'),
          t.awaitingReply && !t.joined && h('span', { class: 'chip hl' }, '답장 대기')),
        h('div', { class: 'muted preview' }, `${t.lastMessage.senderId === t.guest.id ? '' : `${t.lastMessage.nickname}: `}${t.lastMessage.body}`)))));
  }

  /** API 호출 후 응답의 ride 로 다시 그린다 */
  async function action(fn, successMessage) {
    try {
      const data = await fn();
      if (data.ride) ride = data.ride;
      if (data.myRatings) myRatings = data.myRatings;
      if (successMessage) toast(typeof successMessage === 'function' ? successMessage(data) : successMessage);
      await render();
      return data;
    } catch (err) {
      toast(err.message);
      return null;
    }
  }

  async function subscribeChat() {
    if (subscribed || !isMember()) return;
    const res = await emit('ride:subscribe', ride.id);
    if (!res.ok) return toast(res.error);
    subscribed = true;
    const { messages } = await api('GET', `/rides/${ride.id}/messages`);
    chatLog.replaceChildren();
    messages.forEach(appendMessage);
  }

  // ---------- 시트(모달) ----------

  /** 참여: 최종 도착지까지 / 가는 길에 먼저 내리기 */
  function openJoinSheet() {
    let search = {};
    try { search = JSON.parse(sessionStorage.getItem('meet.search')) ?? {}; } catch { /* 없음 */ }
    const picker = placePicker('내릴 곳');
    const suggested = search.destination && distanceKm(search.destination, ride.destination) > SAME_DEST_KM;
    if (suggested) picker.set(search.destination);
    const choice = (value, label, checked) => h('label', { class: 'check' },
      h('input', { type: 'radio', name: 'dropoffMode', value, checked, onchange: () => { pickerBox.hidden = value === 'dest'; } }), label);
    const pickerBox = h('div', { hidden: !suggested }, picker.el,
      h('p', { class: 'muted' }, '경로에서 3km 이내여야 하고, 요금은 탄 거리만큼만 내요.'));
    const body = h('div', { class: 'stack' },
      choice('dest', `${ride.destination.name}까지 같이 가요`, !suggested),
      choice('dropoff', '가는 길에 먼저 내려요', suggested),
      pickerBox);
    sheet('합승 참여', body, [{
      label: '참여하기',
      onClick: async (close) => {
        let payload = {};
        try {
          if (body.querySelector('input[name=dropoffMode]:checked').value === 'dropoff') {
            const dropoff = picker.value();
            if (!dropoff) throw new Error('내릴 곳을 선택해 주세요.');
            payload = { dropoff };
          }
        } catch (err) {
          return toast(err.message);
        }
        if (await action(() => api('POST', `/rides/${ride.id}/join`, payload), '합승에 참여했어요! 만남 장소를 확인해 주세요.')) close();
      },
    }]);
  }

  /** 출발: 안 온 사람을 노쇼로 표시 */
  function openDepartSheet() {
    const others = ride.members.filter((m) => m.id !== me());
    const body = h('div', { class: 'stack' },
      others.length
        ? others.map((m) => (m.arrived
          ? h('div', {}, `✅ ${m.nickname} (도착 체크인)`)
          : h('label', { class: 'check' }, h('input', { type: 'checkbox', value: m.id }), `${m.nickname} — 안 왔어요 (노쇼)`)))
        : h('p', {}, '동승자가 없어요. 혼자 출발할까요?'),
      others.some((m) => !m.arrived) && h('p', { class: 'muted' }, '노쇼로 표시한 사람은 합승에서 빠지고 기록이 남아요. 체크인한 사람은 노쇼 처리할 수 없어요.'));
    sheet('🚕 출발할까요?', body, [{
      label: '출발',
      onClick: async (close) => {
        const noShowIds = [...body.querySelectorAll('input[type=checkbox]:checked')].map((c) => Number(c.value));
        if (await action(() => api('PATCH', `/rides/${ride.id}/status`, { status: 'departed', noShowIds }), '출발! 도착하면 결제한 사람이 정산을 요청해 주세요.')) close();
      },
    }]);
  }

  function openMeetingSheet() {
    const input = h('input', { value: ride.meetingPoint ?? '', maxlength: 100, placeholder: '예: 2번 출구 앞 택시승강장' });
    sheet('📍 만남 장소', h('div', { class: 'stack' }, input), [{
      label: '저장',
      onClick: async (close) => {
        if (await action(() => api('PATCH', `/rides/${ride.id}/meeting-point`, { meetingPoint: input.value }), '만남 장소를 알렸어요.')) close();
      },
    }]);
  }

  function openMemberMenu(member) {
    const reason = h('textarea', { rows: 3, maxlength: 500, placeholder: '신고 사유 (예: 노쇼 후 연락 두절, 불쾌한 언행)' });
    sheet(member.nickname, h('div', { class: 'stack' },
      h('div', { class: 'chips' }, trustChips(member)),
      h('p', { class: 'muted' }, `완료한 합승 ${member.stats.completedRides}회 · 받은 평가 ${member.stats.ratings}건`),
      reason), [
      {
        label: '🚫 차단',
        class: 'secondary',
        onClick: async (close) => {
          if (!await ask('차단할까요?', `${member.nickname}님과는 서로의 합승이 보이지 않고 같은 방에 참여할 수 없어요.`, { confirmLabel: '차단', danger: true })) return;
          try {
            await api('POST', `/users/${member.id}/block`);
            toast('차단했어요.');
            close();
          } catch (err) { toast(err.message); }
        },
      },
      {
        label: '🚨 신고',
        class: 'danger',
        onClick: async (close) => {
          try {
            await api('POST', `/users/${member.id}/report`, { reason: reason.value, rideId: ride.id });
            toast('신고가 접수되었어요.');
            close();
          } catch (err) { toast(err.message); }
        },
      },
    ]);
  }

  async function leave() {
    const late = minutesUntil(ride.departAt) < LATE_CANCEL_MIN;
    const ok = await ask('합승에서 나갈까요?', late
      ? `출발 ${LATE_CANCEL_MIN}분 전 이후라 '직전 취소'로 기록되고 다른 사람들이 볼 수 있어요.`
      : '다른 동승자에게 알림이 가요.', { confirmLabel: '나가기', danger: late });
    if (ok) await action(() => api('POST', `/rides/${ride.id}/leave`), (d) => (d.lateCancel ? '나왔어요. 직전 취소로 기록되었어요.' : '합승에서 나왔어요.'));
  }

  // ---------- 화면 구성 ----------

  /** 지금 해야 할 일을 안내하는 카드 */
  function nextStepCard() {
    const mins = minutesUntil(ride.departAt);
    if (ride.status === 'cancelled') return h('div', { class: 'card step muted' }, '취소된 합승이에요.');
    if (ride.status === 'open' && !isMember()) {
      const full = ride.memberCount >= ride.maxSeats;
      if (!state.user.verified) return h('a', { class: 'card step warn', href: '#/verify' }, '📱 휴대폰 본인 확인 후 참여할 수 있어요.');
      return h('div', { class: 'card step' },
        h('div', { class: 'row' },
          h('button', { class: 'secondary', onclick: () => { inquiryInput?.focus(); inquiryInput?.scrollIntoView({ block: 'center' }); } }, '💬 먼저 물어보기'),
          h('button', { disabled: full, onclick: openJoinSheet }, full ? '정원 마감' : '합승 참여하기')));
    }
    if (ride.status === 'open') {
      const arrived = myMember()?.arrived;
      const canCheckIn = mins <= CHECKIN_OPEN_MIN;
      const arrivedCount = ride.members.filter((m) => m.arrived).length;
      return h('div', { class: 'card step' },
        h('h2', {}, mins > 0 ? `⏰ ${relativeTime(ride.departAt)} 출발` : '⏰ 출발 시간이에요'),
        h('div', { class: 'meeting' }, '📍 ', h('strong', {}, ride.meetingPoint),
          isHost() && h('button', { class: 'secondary small', onclick: openMeetingSheet }, '변경')),
        h('p', { class: 'muted' }, `도착 체크인 ${arrivedCount}/${ride.memberCount}명`),
        h('div', { class: 'row' },
          arrived
            ? h('button', { class: 'secondary', disabled: true }, '✅ 도착 체크인 완료')
            : h('button', {
              disabled: !canCheckIn,
              onclick: () => action(() => api('POST', `/rides/${ride.id}/arrive`), '도착을 알렸어요.'),
            }, canCheckIn ? '📍 도착했어요' : `체크인은 출발 ${CHECKIN_OPEN_MIN}분 전부터`),
          isHost() && h('button', { onclick: openDepartSheet }, '🚕 출발')),
        h('button', { class: 'link', onclick: leave }, '합승에서 나가기'));
    }
    if (ride.status === 'departed' && isMember()) {
      return h('div', { class: 'card step' },
        h('h2', {}, '🚕 이동 중'),
        h('p', { class: 'muted' }, '도착하면 택시비를 결제한 사람이 아래에서 정산을 요청해 주세요.'),
        isHost() && h('button', {
          onclick: async () => {
            if (await ask('도착했나요?', '도착 완료 처리하면 동승자 평가가 열려요.', { confirmLabel: '도착 완료' })) {
              await action(() => api('PATCH', `/rides/${ride.id}/status`, { status: 'completed' }), '수고했어요! 동승자를 평가해 주세요.');
            }
          },
        }, '✅ 도착 완료'));
    }
    return null;
  }

  function fareCard() {
    const myShare = ride.fare.shares?.[me()];
    return h('div', { class: 'card' },
      h('h2', {}, '💰 예상 요금'),
      h('div', { class: 'fare' },
        h('div', {}, h('span', { class: 'muted' }, '전체'), h('strong', {}, won(ride.fare.total))),
        myShare !== undefined
          ? h('div', {}, h('span', { class: 'muted' }, '내 몫 (지금)'), h('strong', {}, won(myShare)))
          : h('div', {}, h('span', { class: 'muted' }, `지금 ${ride.memberCount}명`), h('strong', {}, won(Math.ceil(ride.fare.total / ride.memberCount / 10) * 10))),
        h('div', {}, h('span', { class: 'muted' }, `만석 (${ride.maxSeats}명)`), h('strong', {}, won(ride.fare.perPersonFull)))),
      h('p', { class: 'muted' }, ride.fare.source === 'naver'
        ? `네이버 길찾기 기준 ${routeSummary(ride.fare)} 예상 요금이에요. `
        : `${routeSummary(ride.fare)} 기준 추정 요금이에요. `,
      '먼저 내리는 사람은 탄 거리만큼만 내요.'));
  }

  // 같은 합승의 탑승자끼리, 모집 중이거나 이동 중일 때 통화 가능
  const canCall = () => isMember() && (ride.status === 'open' || ride.status === 'departed');

  function membersCard() {
    return h('div', { class: 'card' },
      h('h2', {}, `👥 탑승자 ${ride.memberCount}/${ride.maxSeats}`),
      h('ul', { class: 'members' }, ride.members.map((m) => h('li', {},
        h('div', { class: 'member-name' },
          m.nickname,
          m.id === ride.hostId && h('span', { class: 'chip hl' }, '방장'),
          m.id === me() && h('span', { class: 'muted' }, '(나)'),
          ride.status === 'open' && m.arrived && h('span', { class: 'chip ok' }, '도착'),
          m.id !== me() && h('span', { class: 'member-actions' },
            canCall() && h('button', { class: 'small call', 'aria-label': `${m.nickname}에게 음성 통화`, onclick: () => startCall(ride.id, m) }, '📞 통화'),
            h('button', { class: 'secondary small', 'aria-label': `${m.nickname} 메뉴`, onclick: () => openMemberMenu(m) }, '⋯'))),
        h('div', { class: 'chips' },
          trustChips(m),
          m.dropoff && h('span', { class: 'chip' }, `🛑 ${m.dropoff.name}에서 하차`),
          ride.fare.shares && ride.status === 'open' && h('span', { class: 'chip' }, `예상 ${won(ride.fare.shares[m.id])}`))))));
  }

  function settlementCard() {
    if (!isMember() || !['departed', 'completed'].includes(ride.status)) return null;
    const s = ride.settlement;
    if (!s) {
      const fare = h('input', { type: 'number', inputmode: 'numeric', min: 1000, step: 100, value: ride.fare.total, 'aria-label': '실제 요금' });
      const account = h('input', {
        maxlength: 100, value: localStorage.getItem('meet.account') ?? '', placeholder: '예: 토스뱅크 1000-1234-5678 홍길동', 'aria-label': '받을 계좌',
      });
      return h('div', { class: 'card stack' },
        h('h2', {}, '💸 정산'),
        h('p', { class: 'muted' }, '택시비를 결제한 사람이 실제 요금과 받을 계좌를 입력하면, 각자 낼 금액을 계산해서 알림으로 보내요.'),
        h('label', {}, '실제 요금 (원)', fare),
        h('label', {}, '받을 계좌 / 송금 방법', account),
        h('button', {
          onclick: () => {
            localStorage.setItem('meet.account', account.value);
            action(() => api('POST', `/rides/${ride.id}/settlement`, { actualFare: Number(fare.value), account: account.value }), '정산을 요청했어요.');
          },
        }, '내가 결제했어요 · 정산 요청'));
    }
    const iAmPayer = s.payerId === me();
    return h('div', { class: 'card stack' },
      h('h2', {}, s.allPaid ? '🎉 정산 완료' : '💸 정산'),
      h('div', {}, `${s.payerNickname}님이 ${won(s.actualFare)} 결제`),
      h('div', { class: 'row account' },
        h('span', {}, s.account),
        h('button', { class: 'secondary small fit', onclick: () => copyText(s.account) }, '복사')),
      h('ul', { class: 'members' }, s.shares.map((row) => h('li', { class: 'settle-row' },
        h('span', {}, row.nickname, row.userId === me() && ' (나)'),
        h('strong', {}, row.userId === s.payerId ? `${won(row.amount)} (결제)` : won(row.amount)),
        row.paid
          ? h('span', { class: 'chip ok' }, row.userId === s.payerId ? '결제함' : '송금 완료')
          : row.userId === me()
            ? h('button', { class: 'small', onclick: () => action(() => api('POST', `/rides/${ride.id}/settlement/paid`), '송금 완료를 알렸어요.') }, '송금했어요')
            : iAmPayer
              ? h('button', { class: 'secondary small', onclick: () => action(() => api('POST', `/rides/${ride.id}/settlement/paid`, { userId: row.userId })) }, '받았어요')
              : h('span', { class: 'chip' }, '대기')))));
  }

  function ratingCard() {
    if (!isMember() || ride.status !== 'completed') return null;
    const others = ride.members.filter((m) => m.id !== me());
    if (!others.length) return null;
    const current = (id) => myRatings.find((r) => r.userId === id)?.good;
    const rate = (userId, good) => action(() => api('POST', `/rides/${ride.id}/ratings`, { ratings: [{ userId, good }] }), '평가해 주셔서 고마워요.');
    return h('div', { class: 'card' },
      h('h2', {}, '⭐ 동승자 평가'),
      h('p', { class: 'muted' }, '약속을 잘 지켰나요? 평가는 익명으로 매너 점수에 반영돼요.'),
      h('ul', { class: 'members' }, others.map((m) => h('li', { class: 'settle-row' },
        h('span', {}, m.nickname),
        h('button', { class: current(m.id) === true ? 'small' : 'secondary small', onclick: () => rate(m.id, true) }, '👍 좋았어요'),
        h('button', { class: current(m.id) === false ? 'small danger' : 'secondary small', onclick: () => rate(m.id, false) }, '👎 별로예요')))));
  }

  let chatCard = null;
  function chatPanel() {
    if (chatCard) return chatCard;
    const { form } = composer('메시지 입력', async (text) => {
      const res = await emit('chat:send', { rideId: ride.id, body: text });
      if (!res.ok) throw new Error(res.error);
    });
    chatCard = h('div', { class: 'card' }, h('h2', {}, '💬 합승 채팅'), h('div', { class: 'chat' }, chatLog, form));
    return chatCard;
  }

  async function render() {
    // 다시 그려도 입력 중이던 칸의 포커스를 유지
    const focused = root.contains(document.activeElement) ? document.activeElement : null;
    // h()가 null/false 자식을 걸러주므로 한 번 감싸서 넣는다
    root.replaceChildren(h('div', {},
      h('div', { class: 'card' },
        h('div', { class: 'route' }, ride.origin.name, h('span', { class: 'arrow' }, '→'), ride.destination.name),
        h('div', { class: 'muted' }, `${formatTime(ride.departAt)} 출발 · ${STATUS_LABEL[ride.status]}`),
        h('div', { class: 'chips' },
          h('span', { class: 'chip' }, `${ride.memberCount}/${ride.maxSeats}명`),
          h('span', { class: 'chip' }, GENDER_LABEL[ride.genderPref]),
          ride.orgOnly && h('span', { class: 'chip' }, `🎓 ${ride.orgOnly}만`)),
        ride.memo && h('p', {}, ride.memo),
        !isMember() && h('p', { class: 'muted' }, '참여하면 정확한 만남 장소와 채팅이 열려요.')),
      nextStepCard(),
      guestInquiryCard(),
      threadsCard(),
      settlementCard(),
      ratingCard(),
      !ride.settlement && fareCard(),
      membersCard(),
      isMember() && chatPanel(),
    ));
    if (focused?.isConnected) focused.focus();
    await subscribeChat();
    if (canInquire()) await loadGuestInquiry();
    if (isMember() && !threadsLoaded) {
      threadsLoaded = true;
      loadThreads().catch(() => {});
    }
  }

  listen(window, 'rides:changed', () => {
    // 멤버가 아닐 때는 소켓 방에 없으므로 목록 변경 이벤트로 새로 불러온다
    // (다른 방의 변경일 수도 있으므로 실제로 달라졌을 때만 다시 그린다)
    if (ride && !isMember()) {
      api('GET', `/rides/${ride.id}`).then((d) => {
        if (JSON.stringify(d.ride) === JSON.stringify(ride)) return;
        ({ ride } = d);
        render();
      }).catch(() => {});
    }
  });
  const onUpdated = (updated) => {
    if (updated.id !== ride?.id) return;
    ride = updated;
    render();
    // 문의한 사람이 참여하면 목록에 '참여함'으로 바뀌도록
    if (isMember() && threads.length) loadThreads().catch(() => {});
  };
  const onMessage = (msg) => msg.rideId === ride?.id && appendMessage(msg);
  const onInquiry = (msg) => {
    if (msg.rideId !== ride?.id) return;
    if (!isMember()) {
      if (msg.guestId === me()) appendInquiry(inquiryLog, msg);
      return;
    }
    if (openThread?.guestId === msg.guestId) appendInquiry(openThread.log, msg);
    loadThreads().catch(() => {});
  };
  state.socket.on('ride:updated', onUpdated);
  state.socket.on('chat:message', onMessage);
  state.socket.on('inquiry:message', onInquiry);
  onLeave(() => {
    state.socket?.off('ride:updated', onUpdated);
    state.socket?.off('chat:message', onMessage);
    state.socket?.off('inquiry:message', onInquiry);
    if (subscribed) state.socket?.emit('ride:unsubscribe', ride.id);
    if (inquirySubscribed) state.socket?.emit('inquiry:unsubscribe', ride.id);
  });

  Promise.all([api('GET', `/rides/${rideId}`), state.mapsReady])
    .then(async ([data]) => {
      ({ ride, myRatings } = data);
      if (ride.members.some((m) => m.id === me())) {
        threads = (await api('GET', `/rides/${ride.id}/inquiries`).catch(() => ({ threads: [] }))).threads;
        threadsLoaded = true;
      }
      if (mapsAvailable()) {
        mapCard.hidden = false;
        renderRouteMap(mapEl, ride);
      }
      return render();
    })
    .catch((err) => root.replaceChildren(h('div', { class: 'empty' }, err.message)));
  return h('div', {}, mapCard, root);
}
