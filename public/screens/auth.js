import { api, refreshMe, setSession, state } from '../core.js';
import { h, toast } from '../ui.js';

const MIN_AGE = 19;
const PRIVACY_NOTE = '🔒 실명·생년월일·휴대폰 번호는 본인 확인에만 쓰이고 다른 사용자에게 공개되지 않아요. 동승자에게는 닉네임과 성별만 보여요.';

/** 휴대폰 번호 입력 시 010-1234-5678 형태로 */
function formatPhone(input) {
  input.addEventListener('input', () => {
    const d = input.value.replace(/\D/g, '').slice(0, 11);
    input.value = d.length > 7 ? `${d.slice(0, 3)}-${d.slice(3, d.length - 4)}-${d.slice(-4)}` : d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
  });
  return input;
}

const maxBirthDate = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - MIN_AGE);
  return d.toISOString().slice(0, 10);
};

/** 본인정보 입력칸 (가입 화면과 기존 가입자 입력 화면에서 공통 사용) */
function identityFields(user = {}) {
  return [
    h('input', { name: 'name', placeholder: '이름 (실명)', required: true, maxlength: 20, autocomplete: 'name', value: user.name ?? '' }),
    h('label', {}, '생년월일', h('input', { name: 'birthDate', type: 'date', required: true, max: maxBirthDate(), value: user.birthDate ?? '' })),
    formatPhone(h('input', { name: 'phone', type: 'tel', inputmode: 'numeric', placeholder: '휴대폰 번호 (010-0000-0000)', required: true, autocomplete: 'tel' })),
  ];
}

export function authScreen() {
  let mode = 'login';
  const root = h('div');

  function render() {
    const form = h('form', { class: 'card stack' },
      mode === 'register' && h('h2', {}, '계정'),
      h('input', { name: 'email', type: 'email', placeholder: '이메일', required: true, autocomplete: 'email' }),
      h('input', { name: 'password', type: 'password', placeholder: '비밀번호 (8자 이상)', required: true, minlength: 8 }),
      mode === 'register' && [
        h('input', { name: 'nickname', placeholder: '닉네임 (동승자에게 보여요)', required: true, maxlength: 20 }),
        h('h2', {}, '본인정보'),
        ...identityFields(),
        h('div', { class: 'row gender-pick' },
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'gender', value: 'male', required: true }), '👨 남성'),
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'gender', value: 'female' }), '👩 여성')),
        h('p', { class: 'muted' }, PRIVACY_NOTE),
        h('p', { class: 'muted' }, `만 ${MIN_AGE}세 이상만 가입할 수 있어요. 학교·회사 이메일로 가입하면 가입 후 소속 인증을 할 수 있어요.`),
      ],
      h('button', {}, mode === 'login' ? '로그인' : '가입하고 인증문자 받기'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        const { token, user, devCode } = await api('POST', `/auth/${mode}`, data);
        setSession(token, user);
        if (devCode) sessionStorage.setItem('meet.devCode', devCode);
        location.hash = user.verified ? '#/' : '#/verify';
      } catch (err) {
        toast(err.message);
      }
    });
    root.replaceChildren(
      h('h1', {}, '같은 방향, 택시비는 N분의 1'),
      h('div', { class: 'tabs' },
        h('button', { class: mode === 'login' ? '' : 'secondary', onclick: () => { mode = 'login'; render(); } }, '로그인'),
        h('button', { class: mode === 'register' ? '' : 'secondary', onclick: () => { mode = 'register'; render(); } }, '회원가입')),
      form,
    );
  }
  render();
  return root;
}

/** 휴대폰 본인 확인. 본인정보가 없는 기존 가입자는 먼저 입력한다. */
export function verifyScreen() {
  const root = h('div');
  if (state.user.verified) {
    location.hash = '#/';
    return root;
  }

  function identityForm() {
    const form = h('form', { class: 'card stack' },
      h('p', {}, '안전한 합승을 위해 본인정보를 입력하고 휴대폰 인증을 해 주세요.'),
      ...identityFields(state.user),
      h('p', { class: 'muted' }, PRIVACY_NOTE),
      h('button', {}, '인증문자 받기'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const { devCode } = await api('PUT', '/auth/identity', Object.fromEntries(new FormData(form)));
        if (devCode) sessionStorage.setItem('meet.devCode', devCode);
        toast('인증문자를 보냈어요.');
      } catch (err) {
        toast(err.message);
        // 저장은 됐지만 재발송 대기 중일 수 있음 — 코드 입력 화면으로 넘어가 다시 받기 가능
      }
      await refreshMe().catch(() => {});
      render();
    });
    return form;
  }

  function codeForm() {
    const devCode = sessionStorage.getItem('meet.devCode');
    const input = h('input', {
      name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '인증번호 6자리', required: true,
    });
    const form = h('form', { class: 'card stack' },
      h('p', {}, h('strong', {}, `${state.user.name} · ${state.user.phone}`), ' 으로 보낸 인증번호를 입력해 주세요.'),
      devCode && h('p', { class: 'muted dev-note' }, `개발 모드(문자 발송 미설정) 인증번호: ${devCode}`),
      input,
      h('button', {}, '인증하기'),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'secondary',
          onclick: async () => {
            try {
              const { devCode: code } = await api('POST', '/auth/phone/send');
              if (code) sessionStorage.setItem('meet.devCode', code);
              toast('인증문자를 다시 보냈어요.');
              render();
            } catch (err) {
              toast(err.message);
            }
          },
        }, '다시 받기'),
        h('button', { type: 'button', class: 'secondary', onclick: () => { editing = true; render(); } }, '정보 수정')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/auth/phone/verify', { code: input.value });
        sessionStorage.removeItem('meet.devCode');
        await refreshMe();
        toast('본인 확인이 완료되었어요!');
        location.hash = '#/';
      } catch (err) {
        toast(err.message);
      }
    });
    return form;
  }

  let editing = false;
  function render() {
    root.replaceChildren(
      h('h1', {}, '📱 휴대폰 본인 확인'),
      h('p', { class: 'muted' }, '본인 확인을 마친 사람만 합승을 만들고 참여할 수 있어요. 휴대폰 번호 하나당 계정 하나만 만들 수 있어요.'),
      editing || !state.user.identityComplete ? identityForm() : codeForm(),
    );
    editing = false;
  }
  render();
  return root;
}
