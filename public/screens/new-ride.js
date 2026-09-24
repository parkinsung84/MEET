import { placePicker, toLocalInput } from '../components.js';
import { api, state } from '../core.js';
import { h, toast } from '../ui.js';

export function newRideScreen() {
  const origin = placePicker('출발지', { allowCurrent: true });
  const dest = placePicker('도착지');
  let draft = {};
  try { draft = JSON.parse(sessionStorage.getItem('meet.draft')) ?? {}; } catch { /* 없음 */ }
  sessionStorage.removeItem('meet.draft');
  if (draft.origin) origin.set(draft.origin);
  if (draft.destination) dest.set(draft.destination);
  const departDefault = draft.departAt && new Date(draft.departAt) > new Date() ? draft.departAt : Date.now() + 15 * 60000;

  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('label', {}, '만남 장소 (자세히)',
      h('input', { name: 'meetingPoint', maxlength: 100, placeholder: '예: 서울역 2번 출구 앞 택시승강장' })),
    h('label', {}, '출발 시간', h('input', { name: 'departAt', type: 'datetime-local', required: true, value: toLocalInput(departDefault) })),
    h('div', { class: 'row' },
      h('label', {}, '정원 (본인 포함)',
        h('select', { name: 'maxSeats' }, [2, 3, 4].map((n) => h('option', { value: n, selected: n === 4 }, `${n}명`)))),
      h('label', {}, '성별 조건',
        h('select', { name: 'genderPref' },
          h('option', { value: 'any' }, '성별 무관'),
          h('option', { value: state.user.gender }, `${state.user.gender === 'male' ? '남성' : '여성'}만`)))),
    state.user.org && h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'orgOnly' }),
      `🎓 ${state.user.org} 인증 사용자만 참여`),
    h('label', {}, '메모 (선택)', h('textarea', { name: 'memo', rows: 2, maxlength: 200, placeholder: '예: 캐리어 1개 있어요' })),
    h('p', { class: 'muted' }, '💡 같은 방향이면 가는 길에 먼저 내리는 사람도 참여할 수 있고, 요금은 탄 거리만큼 나눠요.'),
    h('button', {}, '합승방 만들기'),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const o = origin.value();
      const d = dest.value();
      if (!o || !d) throw new Error('출발지와 도착지를 입력해 주세요.');
      const { ride } = await api('POST', '/rides', {
        origin: o,
        destination: d,
        meetingPoint: form.meetingPoint.value,
        departAt: new Date(form.departAt.value).toISOString(),
        maxSeats: Number(form.maxSeats.value),
        genderPref: form.genderPref.value,
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
