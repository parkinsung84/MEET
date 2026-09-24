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

  const myGender = state.user.gender === 'male' ? '남성' : '여성';
  // 성별 조건은 대형 택시일 때만 고를 수 있다 (일반 택시는 같은 성별끼리로 고정)
  const genderSelect = h('select', { name: 'genderPref' },
    h('option', { value: 'any' }, '성별 무관'),
    h('option', { value: state.user.gender }, `${myGender}만`));
  const genderField = h('label', { hidden: true }, '성별 조건', genderSelect);
  function syncGender() {
    genderField.hidden = form.taxiType.value !== 'large';
  }

  const form = h('form', { class: 'card stack' },
    origin.el, dest.el,
    h('label', {}, '만남 장소 (자세히)',
      h('input', { name: 'meetingPoint', maxlength: 100, placeholder: '예: 서울역 2번 출구 앞 택시승강장' })),
    h('label', {}, '출발 시간', h('input', { name: 'departAt', type: 'datetime-local', required: true, value: toLocalInput(departDefault) })),
    h('fieldset', { class: 'taxi-type' },
      h('legend', {}, '택시 종류'),
      h('label', { class: 'check option-card' },
        h('input', { type: 'radio', name: 'taxiType', value: 'standard', checked: true, onchange: syncGender }),
        h('span', {}, h('strong', {}, '🚕 일반 택시 (중형 이하)'), h('br'),
          h('span', { class: 'muted' }, `법령에 따라 같은 성별끼리만 탈 수 있어요 → ${myGender}끼리`))),
      h('label', { class: 'check option-card' },
        h('input', { type: 'radio', name: 'taxiType', value: 'large', onchange: syncGender }),
        h('span', {}, h('strong', {}, '🚐 대형 택시 (6인승 이상·승합)'), h('br'),
          h('span', { class: 'muted' }, '성별 제한 없이 탈 수 있어요. 탑승할 때 대형 택시를 불러야 해요.')))),
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
        taxiType: form.taxiType.value,
        genderPref: form.taxiType.value === 'large' ? genderSelect.value : state.user.gender,
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
