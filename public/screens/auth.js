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

const CONSENT_ITEMS = [
  ['age', '[필수] 만 19세 이상입니다', null],
  ['terms', '[필수] 이용약관 동의', '/legal/terms.html'],
  ['privacy', '[필수] 개인정보 수집·이용 동의', '/legal/privacy.html'],
  ['location', '[필수] 위치기반서비스 이용약관 동의', '/legal/location.html'],
];

/** 개인정보 수집·이용 동의에 필요한 고지 (항목·목적·보유기간·거부 권리) */
function privacySummary() {
  const row = (a, b, c) => h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', {}, c));
  return h('details', { class: 'privacy-summary' },
    h('summary', {}, '수집하는 개인정보 요약 보기'),
    h('table', {},
      h('tr', {}, h('th', {}, '항목'), h('th', {}, '목적'), h('th', {}, '보유 기간')),
      row('이메일, 비밀번호, 닉네임, 실명, 생년월일, 성별, 휴대폰 번호', '회원 식별, 본인·성인 확인, 1인 1계정, 동성 합승 매칭', '탈퇴 시 즉시 파기'),
      row('출발지·도착지, 채팅, 차량번호, 정산 계좌(입력 시), 평가', '합승 진행, 정산 안내, 안전·분쟁 대응', '탈퇴 시 익명화'),
      row('노쇼·직전 취소 횟수', '재가입을 통한 부정 이용 방지', '탈퇴 후 1년 (번호는 해시로만)')),
    h('p', { class: 'muted' }, '동의를 거부할 수 있지만, 필수 항목에 동의하지 않으면 가입할 수 없어요.'));
}

/** 약관 동의 체크박스 묶음 (전체 동의 포함). → { el, values() } */
function consentBox(kinds = CONSENT_ITEMS.map(([k]) => k)) {
  const items = CONSENT_ITEMS.filter(([k]) => kinds.includes(k));
  const boxes = items.map(([kind, label, url]) => {
    const input = h('input', { type: 'checkbox', name: `agree_${kind}`, 'data-kind': kind });
    return { kind, input, el: h('div', { class: 'consent-row' },
      h('label', { class: 'check' }, input, label),
      url && h('a', { href: url, target: '_blank', rel: 'noopener' }, '보기')) };
  });
  const all = h('input', { type: 'checkbox', 'aria-label': '전체 동의' });
  all.addEventListener('change', () => boxes.forEach((b) => { b.input.checked = all.checked; }));
  boxes.forEach((b) => b.input.addEventListener('change', () => { all.checked = boxes.every((x) => x.input.checked); }));
  return {
    el: h('div', { class: 'consents' },
      h('label', { class: 'check consent-all' }, all, h('strong', {}, '전체 동의')),
      boxes.map((b) => b.el),
      kinds.includes('privacy') && privacySummary()),
    values: () => Object.fromEntries(boxes.map((b) => [b.kind, b.input.checked])),
    missing: () => boxes.filter((b) => !b.input.checked).map((b) => b.kind),
  };
}

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
    const consents = consentBox();
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
        h('h2', {}, '약관 동의'),
        consents.el,
      ],
      h('button', {}, mode === 'login' ? '로그인' : '가입하고 인증문자 받기'),
      mode === 'login' && h('a', { class: 'link-center', href: '#/forgot' }, '비밀번호를 잊으셨나요?'),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const data = Object.fromEntries([...new FormData(form)].filter(([k]) => !k.startsWith('agree_')));
      try {
        if (mode === 'register') {
          if (consents.missing().length) throw new Error('필수 약관에 모두 동의해 주세요.');
          data.agreements = consents.values();
        }
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

/**
 * 문자 발송이 준비되지 않았을 때 안내 (문자가 안 가는데 기다리지 않도록).
 *  - 시범 운영 모드: 인증번호를 화면에 보여준다 → 번호가 없으면 "다시 받기"를 누르라고 안내
 *  - 그 외: 운영자가 설정해야 한다고 안내
 */
function smsNotice(sms, devCode) {
  if (sms.ready) return null;
  if (sms.showCodes) {
    return devCode ? null : h('p', { class: 'sms-notice' },
      '📵 문자 발송은 아직 준비 중이라 문자가 오지 않아요. 아래 ', h('strong', {}, '"다시 받기"'), '를 누르면 인증번호가 이 화면에 표시돼요.');
  }
  return h('div', { class: 'sms-notice warn' },
    h('strong', {}, '📵 아직 인증 문자를 보낼 수 없어요'),
    h('p', {}, '서비스 운영자가 문자 발송 설정을 마치면 가입할 수 있어요.'),
    h('p', { class: 'muted' }, '운영자 안내: Render → meet → Environment 에서 네이버 클라우드 SENS 키 4개를 넣거나, 비공개 시범 운영이라면 SHOW_VERIFICATION_CODES 를 1 로 바꾼 뒤 "다시 받기"를 눌러 주세요.'));
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
    const sms = state.config.sms ?? { ready: true, showCodes: false };
    const form = h('form', { class: 'card stack' },
      smsNotice(sms, devCode),
      h('p', {}, h('strong', {}, `${state.user.name} · ${state.user.phone}`), sms.ready ? ' 으로 보낸 인증번호를 입력해 주세요.' : ' 의 인증번호를 입력해 주세요.'),
      devCode && h('p', { class: 'muted dev-note' }, `시범 운영 모드 인증번호: ${devCode}`),
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

/** 비밀번호 찾기: 이메일 → 인증번호(휴대폰 또는 이메일) → 새 비밀번호 */
export function forgotScreen() {
  const root = h('div');
  let email = '';

  function requestForm() {
    const input = h('input', { type: 'email', placeholder: '가입한 이메일', required: true, autocomplete: 'email' });
    const form = h('form', { class: 'card stack' }, input, h('button', {}, '인증번호 받기'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await api('POST', '/auth/password/forgot', { email: input.value });
        email = input.value;
        toast(res.message);
        render(res.devCode);
      } catch (err) {
        toast(err.message);
      }
    });
    return form;
  }

  function resetForm(devCode) {
    const code = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '인증번호 6자리', required: true, autocomplete: 'one-time-code' });
    const password = h('input', { type: 'password', placeholder: '새 비밀번호 (8자 이상)', minlength: 8, required: true, autocomplete: 'new-password' });
    const form = h('form', { class: 'card stack' },
      h('p', {}, h('strong', {}, email), ' 계정의 인증된 휴대폰(휴대폰 인증 전 계정은 이메일)으로 보낸 인증번호를 입력해 주세요.'),
      devCode && h('p', { class: 'muted dev-note' }, `시범 운영 모드 인증번호: ${devCode}`),
      code, password,
      h('button', {}, '비밀번호 바꾸기'),
      h('button', { type: 'button', class: 'secondary', onclick: () => render() }, '다시 받기'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('POST', '/auth/password/reset', { email, code: code.value, password: password.value });
        toast('비밀번호를 바꿨어요. 모든 기기에서 로그아웃되었으니 다시 로그인해 주세요.');
        location.hash = '#/login';
      } catch (err) {
        toast(err.message);
      }
    });
    return form;
  }

  function render(devCode) {
    root.replaceChildren(h('h1', {}, '🔑 비밀번호 찾기'), email ? resetForm(devCode) : requestForm());
  }
  render();
  return root;
}

/** 약관이 바뀌었을 때 다시 동의 */
export function consentScreen() {
  const consents = consentBox(state.user.consentsRequired);
  const form = h('form', { class: 'card stack' },
    h('p', {}, '약관이 바뀌었어요. 계속 이용하려면 아래 내용에 동의해 주세요.'),
    consents.el,
    h('button', {}, '동의하고 계속하기'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (consents.missing().length) throw new Error('필수 항목에 모두 동의해 주세요.');
      // 이미 동의한 최신 항목도 함께 보내 전체 동의로 기록
      ({ user: state.user } = await api('POST', '/auth/consents', { kinds: ['age', 'terms', 'privacy', 'location'] }));
      location.hash = '#/';
    } catch (err) {
      toast(err.message);
    }
  });
  return h('div', {}, h('h1', {}, '📄 약관 동의'), form);
}
