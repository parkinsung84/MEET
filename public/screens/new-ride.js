import { placePicker, rideCard, timePicker } from '../components.js';
import { api, state } from '../core.js';
import { h, sheet, toast } from '../ui.js';

export function newRideScreen() {
  const origin = placePicker('출발지', { allowCurrent: true });
  const dest = placePicker('도착지');
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem('meet.draft')) ?? {}; } catch { /* 없음 */ }
  sessionStorage.removeItem('meet.draft');
  if (draft.origin) origin.set(draft.origin);
  if (draft.destination) dest.set(draft.destination);
  const departDefault = draft.departAt && new Date(draft.departAt) > new Date() ? draft.departAt : Date.now() + 15 * 60000;

  const myGender = state.user.gender === 'male' ? '남성' : '여성';
  // 기본은 성별 무관, 원하면 같은 성별만
  const genderSelect = h('select', { name: 'genderPref' },
    h('option', { value: 'any' }, '성별 무관'),
    h('option', { value: state.user.gender }, `${myGender}만`));
  const genderField = h('label', {}, '모집 성별', genderSelect);
  const departPick = timePicker(new Date(departDefault).getTime());

  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('label', {}, '만남 장소 (자세히)',
      h('input', { name: 'meetingPoint', maxlength: 100, placeholder: '예: 서울역 2번 출구 앞 택시승강장' })),
    h('div', { class: 'field' }, h('span', { class: 'field-label' }, '출발 시간'), departPick.el),
    h('div', { class: 'row' },
      h('label', {}, '정원 (본인 포함)',
        h('select', { name: 'maxSeats' }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === 4 }, `${n}명`)))),
      genderField),
    state.user.org && h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'orgOnly' }),
      `🎓 ${state.user.org} 인증 사용자만 참여`),
    h('label', {}, '메모 (선택)', h('textarea', { name: 'memo', rows: 2, maxlength: 200, placeholder: '예: 캐리어 1개 있어요' })),
    h('p', { class: 'muted' }, '💡 같은 방향이면 가는 길에 먼저 내리는 사람도 참여할 수 있고, 요금은 탄 거리만큼 나눠요.'),
    h('button', {}, '합승방 만들기'),
  );

  /** 비슷한 방이 이미 있으면 먼저 보여주고, 그래도 만들지 물어본다 → 만들면 true */
  async function confirmNoSimilar(o, d, departAt) {
    const params = new URLSearchParams({ originLat: o.lat, originLng: o.lng, destLat: d.lat, destLng: d.lng, departAt });
    const { rides } = await api('GET', `/rides/similar?${params}`).catch(() => ({ rides: [] }));
    if (!rides.length) return true;
    return new Promise((resolve) => {
      sheet('🙌 비슷한 방이 이미 있어요', h('div', { class: 'stack' },
        h('p', {}, '같은 방향으로 가는 방에 참여하면 더 빨리 모이고 요금도 더 싸져요.'),
        rides.slice(0, 3).map((r) => {
          const card = rideCard(r);
          card.addEventListener('click', () => resolve(false));
          return card;
        })), [
        { label: '그래도 새로 만들기', class: 'secondary', onClick: (close) => { close(); resolve(true); } },
      ]);
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const o = origin.value();
      const d = dest.value();
      if (!o || !d) throw new Error('출발지와 도착지를 입력해 주세요.');
      if (!await confirmNoSimilar(o, d, departPick.value().toISOString())) return;
      const { ride } = await api('POST', '/rides', {
        origin: o,
        destination: d,
        meetingPoint: form.meetingPoint.value,
        departAt: departPick.value().toISOString(),
        maxSeats: Number(form.maxSeats.value),
        genderPref: genderSelect.value,
        orgOnly: Boolean(form.orgOnly?.checked),
        memo: form.memo.value,
      });
      toast('합승방이 만들어졌어요!');
      location.hash = `#/rides/${ride.id}`;
    } catch (err) {
      toast(err.message);
    }
  });

  return h('div', {}, h('h1', {}, '합승방 만들기'), form);
}
