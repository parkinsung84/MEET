/** 작은 DOM 빌더. 문자열 자식은 textContent 로 들어가므로 XSS 걱정이 없다. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2500);
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/**
 * 하단 시트(모달). content: 노드, actions: [{ label, class, onClick(close) }]
 * → close()
 */
export function sheet(title, content, actions = []) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const overlay = h('div', { class: 'sheet-backdrop', onclick: (e) => e.target === overlay && close() },
    h('div', { class: 'sheet', role: 'dialog', 'aria-label': title },
      h('div', { class: 'sheet-head' }, h('strong', {}, title), h('button', { class: 'secondary small', 'aria-label': '닫기', onclick: close }, '✕')),
      h('div', { class: 'sheet-body' }, content),
      actions.length && h('div', { class: 'row sheet-actions' },
        actions.map((a) => h('button', { class: a.class ?? '', onclick: () => a.onClick(close) }, a.label)))));
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  return close;
}

/** 확인 시트. 확인하면 true */
export function ask(title, message, { confirmLabel = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    sheet(title, h('p', {}, message), [
      { label: '취소', class: 'secondary', onClick: (close) => { close(); resolve(false); } },
      { label: confirmLabel, class: danger ? 'danger' : '', onClick: (close) => { close(); resolve(true); } },
    ]);
  });
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('복사했어요.');
  } catch {
    toast(text);
  }
}
