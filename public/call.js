import { emit, state } from './core.js';
import { h, toast } from './ui.js';

// 탑승자끼리 1:1 음성 통화 (WebRTC). 전화번호를 주고받지 않고 앱 안에서 통화한다.
// 서버는 연결 협상 메시지만 중계하고, 음성은 브라우저끼리 직접(또는 TURN 경유) 주고받는다.

const END_MESSAGES = {
  declined: '상대방이 통화를 거절했어요.',
  'no-answer': '상대방이 받지 않았어요.',
  ended: '통화가 끝났어요.',
  disconnected: '연결이 끊어져 통화가 끝났어요.',
  'answered-elsewhere': null, // 다른 기기에서 받음 — 조용히 닫기
  failed: '연결에 실패했어요. 네트워크 상태를 확인해 주세요.',
};

let socket = null;
let current = null; // { callId, role, other, rideId, pc, stream, pending, ui, startedAt, timer }

export const inCall = () => Boolean(current);

// ---------- 벨소리 ----------

let ringer = null;
function startRinging() {
  navigator.vibrate?.([600, 400, 600, 400, 600]);
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.08;
    gain.connect(ctx.destination);
    const beep = () => {
      for (const [offset, freq] of [[0, 880], [0.25, 660]]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.2);
      }
    };
    beep();
    ringer = { ctx, interval: setInterval(beep, 1500) };
  } catch { /* 자동재생 제한 등 — 진동/화면으로만 알림 */ }
}
function stopRinging() {
  navigator.vibrate?.(0);
  if (!ringer) return;
  clearInterval(ringer.interval);
  ringer.ctx.close().catch(() => {});
  ringer = null;
}

// ---------- 화면 ----------

function callUi(other, statusText) {
  const status = h('div', { class: 'call-status' }, statusText);
  const actions = h('div', { class: 'call-actions' });
  const audio = h('audio', { autoplay: true, playsinline: true });
  const overlay = h('div', { class: 'call-overlay', role: 'dialog', 'aria-label': '음성 통화' },
    h('div', { class: 'call-card' },
      h('div', { class: 'call-avatar' }, other.gender === 'female' ? '👩' : '👨'),
      h('strong', { class: 'call-name' }, other.nickname),
      other.route && h('div', { class: 'call-route' }, other.route),
      status,
      actions,
      audio));
  document.body.append(overlay);
  return {
    overlay, audio,
    setStatus: (text) => { status.textContent = text; },
    setActions: (...buttons) => actions.replaceChildren(...buttons),
  };
}

const hangupButton = (label = '끊기') => h('button', { class: 'danger call-btn', onclick: () => hangup() }, `📕 ${label}`);

function muteButton() {
  const btn = h('button', {
    class: 'secondary call-btn',
    onclick: () => {
      const track = current?.stream?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      btn.textContent = track.enabled ? '🎙️ 음소거' : '🔇 음소거 해제';
    },
  }, '🎙️ 음소거');
  return btn;
}

function showConnected() {
  if (!current || current.startedAt) return;
  current.startedAt = Date.now();
  current.ui.setActions(muteButton(), hangupButton());
  const tick = () => {
    const sec = Math.floor((Date.now() - current.startedAt) / 1000);
    current.ui.setStatus(`통화 중 ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`);
  };
  tick();
  current.timer = setInterval(tick, 1000);
}

// ---------- WebRTC ----------

async function getMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('이 브라우저에서는 음성 통화를 할 수 없어요. (HTTPS 주소에서 이용해 주세요)');
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new Error('마이크 권한이 필요해요. 브라우저 설정에서 마이크를 허용해 주세요.');
  }
}

function createPeer(iceServers) {
  const pc = new RTCPeerConnection({ iceServers });
  current.pc = pc;
  current.stream.getTracks().forEach((track) => pc.addTrack(track, current.stream));
  const callId = current.callId;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) socket.emit('call:signal', { callId, data: { candidate: candidate.toJSON() } });
  };
  pc.ontrack = ({ streams }) => {
    current.ui.audio.srcObject = streams[0];
    current.ui.audio.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') showConnected();
    if (pc.connectionState === 'failed') hangup('failed');
  };
  return pc;
}

async function handleSignal(data) {
  const { pc } = current;
  if (data.sdp) {
    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription(await pc.createAnswer());
      socket.emit('call:signal', { callId: current.callId, data: { sdp: pc.localDescription.toJSON() } });
    }
    // 원격 설명 전에 도착한 ICE 후보 적용
    for (const candidate of current.pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
  } else if (data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else current.pending.push(data.candidate);
  }
}

/** 연결 준비 전에 온 신호는 모아 두었다가 순서대로 처리 */
async function processSignals() {
  if (!current?.pc || current.processing) return;
  current.processing = true;
  try {
    while (current?.queue.length) await handleSignal(current.queue.shift());
  } catch (err) {
    console.error('[call]', err);
    hangup('failed');
  } finally {
    if (current) current.processing = false;
  }
}

function cleanup(reason) {
  if (!current) return;
  stopRinging();
  clearInterval(current.timer);
  current.stream?.getTracks().forEach((t) => t.stop());
  current.pc?.close();
  current.ui.overlay.remove();
  current = null;
  const message = END_MESSAGES[reason];
  if (message) toast(message);
}

/** 통화 끊기 (받기 전이면 거절) */
export function hangup(reason = 'ended') {
  if (!current) return;
  if (current.role === 'callee' && !current.accepted) socket.emit('call:decline', { callId: current.callId });
  else socket.emit('call:end', { callId: current.callId });
  cleanup(reason === 'ended' ? null : reason);
}

// ---------- 걸기 / 받기 ----------

/** 같은 합승의 탑승자에게 전화 걸기. other: { id, nickname, gender } */
export async function startCall(rideId, other) {
  if (current) return toast('이미 통화 중이에요.');
  let stream;
  try {
    stream = await getMic();
  } catch (err) {
    return toast(err.message);
  }
  current = { role: 'caller', rideId, other, stream, queue: [], pending: [], ui: callUi(other, '연결 중…') };
  current.ui.setActions(hangupButton('취소'));
  const caller = current;
  const res = await emit('call:invite', { rideId, to: other.id });
  if (current !== caller) {
    // 서버 응답 전에 취소했으면 상대방 벨을 멈춘다
    if (res.ok) socket.emit('call:end', { callId: res.callId });
    return;
  }
  if (!res.ok) {
    cleanup(null);
    return toast(res.error);
  }
  current.callId = res.callId;
  current.iceServers = res.iceServers;
  current.ui.setStatus('상대방을 부르는 중…');
}

async function accept() {
  const call = current;
  call.ui.setStatus('연결 중…');
  call.ui.setActions(hangupButton());
  stopRinging();
  try {
    call.stream = await getMic();
  } catch (err) {
    toast(err.message);
    return hangup();
  }
  const res = await emit('call:accept', { callId: call.callId });
  if (current !== call) return;
  if (!res.ok) {
    cleanup(null);
    return toast(res.error);
  }
  call.accepted = true;
  createPeer(res.iceServers);
  processSignals();
}

function onIncoming({ callId, rideId, route, from }) {
  if (current) return; // 서버에서 통화 중 여부를 막지만 다른 탭 등 예외 대비
  current = { role: 'callee', callId, rideId, other: from, queue: [], pending: [], ui: callUi({ ...from, route }, '음성 통화가 왔어요') };
  current.ui.setActions(
    h('button', { class: 'danger call-btn', onclick: () => hangup() }, '거절'),
    h('button', { class: 'ok call-btn', onclick: accept }, '📞 받기'));
  startRinging();
  // 다른 앱을 보고 있으면 시스템 알림도 띄운다
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(`📞 ${from.nickname}님의 음성 통화`, {
      body: route, tag: `call-${callId}`, data: { url: `/#/rides/${rideId}` },
    })).catch(() => {});
  }
}

async function onAccepted({ callId }) {
  if (current?.callId !== callId || current.role !== 'caller') return;
  current.accepted = true;
  const pc = createPeer(current.iceServers);
  await pc.setLocalDescription(await pc.createOffer());
  socket.emit('call:signal', { callId, data: { sdp: pc.localDescription.toJSON() } });
}

function onSignal({ callId, data }) {
  if (current?.callId !== callId) return;
  current.queue.push(data);
  processSignals();
}

function onEnded({ callId, reason }) {
  if (current?.callId === callId) cleanup(reason);
}

/** 소켓이 (재)연결될 때마다 호출 */
export function initCalls(nextSocket) {
  cleanup(null);
  socket = nextSocket;
  socket.on('call:incoming', onIncoming);
  socket.on('call:accepted', onAccepted);
  socket.on('call:signal', onSignal);
  socket.on('call:ended', onEnded);
}
