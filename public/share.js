import { h } from './ui.js';

// 안심 공유 페이지: 링크(#토큰)로 받은 가족·지인이 로그인 없이 합승 정보를 확인한다.

const STATUS = {
  open: ['⏳ 탑승 전', '합승 인원을 모으거나 만나는 중이에요.'],
  departed: ['🚕 이동 중', '택시를 타고 이동하고 있어요.'],
  completed: ['✅ 도착 완료', '목적지에 도착했어요.'],
  cancelled: ['❌ 취소됨', '합승이 취소되었어요.'],
};
const token = location.hash.slice(1);
const app = document.getElementById('app');
const time = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });

function render(ride) {
  const [label, desc] = STATUS[ride.status];
  app.replaceChildren(h('div', {},
    h('div', { class: 'card stack' },
      h('p', { class: 'muted' }, `${ride.sharedBy}님이 합승 정보를 공유했어요.`),
      h('div', { class: 'route' }, ride.origin, h('span', { class: 'arrow' }, '→'), ride.destination),
      h('div', {}, `${time(ride.departAt)} 출발 · 약 ${ride.distanceKm}km${ride.durationMin ? ` · ${ride.durationMin}분` : ''}`),
      h('div', { class: `share-status ${ride.status}` }, h('strong', {}, label), h('div', {}, desc)),
      ride.completedAt && h('div', { class: 'muted' }, `도착 처리: ${time(ride.completedAt)}`)),
    h('div', { class: 'card stack' },
      h('h2', {}, '🚕 탑승 택시'),
      ride.taxi
        ? [h('span', { class: 'plate big' }, ride.taxi.plate), ride.taxi.note && h('div', {}, ride.taxi.note),
          h('div', { class: 'muted' }, `${ride.taxi.recordedBy}님이 ${time(ride.taxi.recordedAt)}에 기록`)]
        : h('p', { class: 'muted' }, '아직 차량번호가 기록되지 않았어요.')),
    h('div', { class: 'card' },
      h('h2', {}, `👥 탑승자 ${ride.riders.length}명`),
      h('ul', { class: 'members' }, ride.riders.map((r) => h('li', {}, `${r.gender === 'female' ? '👩' : '👨'} ${r.nickname}`)))),
    h('div', { class: 'card stack emergency' },
      h('strong', {}, '위급한 상황이라면 바로 신고하세요'),
      h('div', { class: 'row' },
        h('a', { class: 'btn danger-btn', href: 'tel:112' }, '📞 112 경찰'),
        h('a', { class: 'btn danger-btn', href: 'tel:119' }, '📞 119 구급')),
      h('p', { class: 'muted' }, '신고할 때 위 차량번호와 경로를 알려주세요. 이 화면은 30초마다 새로고침돼요.'))));
}

async function load() {
  try {
    const res = await fetch(`/api/share/${encodeURIComponent(token)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    render(data.ride);
  } catch (err) {
    app.replaceChildren(h('div', { class: 'empty' }, err.message || '공유 정보를 불러올 수 없어요.'));
    clearInterval(timer);
  }
}

const timer = setInterval(load, 30000);
if (token) load();
else app.replaceChildren(h('div', { class: 'empty' }, '잘못된 공유 링크예요.'));
