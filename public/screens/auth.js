import { api, refreshMe, setSession, state } from '../core.js';
import { h, toast } from '../ui.js';

export function authScreen() {
  let mode = 'login';
  const root = h('div');

  function render() {
    const form = h('form', { class: 'card stack' },
      h('input', { name: 'email', type: 'email', placeholder: '이메일', required: true, autocomplete: 'email' }),
      h('input', { name: 'password', type: 'password', placeholder: '비밀번호 (8자 이상)', required: true, minlength: 8 }),
      mode === 'register' && [
        h('input', { name: 'nickname', placeholder: '닉네임', required: true, maxlength: 20 }),
        h('select', { name: 'gender', required: true },
          h('option', { value: '' }, '성별 선택'),
          h('option', { value: 'male' }, '남성'),
          h('option', { value: 'female' }, '여성')),
        h('p', { class: 'muted' }, '💡 학교·회사 이메일로 가입하면 같은 소속끼리만 타는 합승을 이용할 수 있어요. 성별은 동성 합승 매칭에만 사용됩니다.'),
      ],
      h('button', {}, mode === 'login' ? '로그인' : '가입하고 인증번호 받기'),
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

export function verifyScreen() {
  const devCode = sessionStorage.getItem('meet.devCode');
  const input = h('input', {
    name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '인증번호 6자리', required: true,
  });
  const form = h('form', { class: 'card stack' },
    h('p', {}, h('strong', {}, state.user.email), '(으)로 보낸 인증번호를 입력해 주세요.'),
    devCode && h('p', { class: 'muted dev-note' }, `개발 모드(메일 서버 미설정) 인증번호: ${devCode}`),
    input,
    h('button', {}, '인증하기'),
    h('button', {
      type: 'button',
      class: 'secondary',
      onclick: async () => {
        try {
          const { devCode: code } = await api('POST', '/auth/verify/send');
          if (code) sessionStorage.setItem('meet.devCode', code);
          toast('인증번호를 다시 보냈어요.');
        } catch (err) {
          toast(err.message);
        }
      },
    }, '인증번호 다시 받기'),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/auth/verify', { code: input.value });
      sessionStorage.removeItem('meet.devCode');
      await refreshMe();
      toast(state.user.org ? `🎓 ${state.user.org} 소속으로 인증되었어요!` : '인증되었어요!');
      location.hash = '#/';
    } catch (err) {
      toast(err.message);
    }
  });
  return h('div', {}, h('h1', {}, '이메일 인증'),
    h('p', { class: 'muted' }, '안전한 합승을 위해 이메일 인증을 한 사람만 합승을 만들고 참여할 수 있어요.'),
    form);
}
