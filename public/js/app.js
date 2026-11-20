import { loadSettings, buildSessionCreate, VOICES } from './config.js';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), btnCall: $('btnCall'), btnMute: $('btnMute'), btnHello: $('btnHello'),
  btnCancel: $('btnCancel'), btnCommit: $('btnCommit'), videoSource: $('videoSource'),
  preview: $('preview'), previewImg: $('previewImg'), stageEmpty: $('stageEmpty'), stageHint: $('stageHint'), orb: $('orb'),
  videoBadge: $('videoBadge'), fpsBadge: $('fpsBadge'), meterFill: $('meterFill'), meterVal: $('meterVal'),
  logid: $('logid'), sessionId: $('sessionId'), modelInfo: $('modelInfo'),
  chat: $('chat'), usage: $('usage'), log: $('log'), logAudio: $('logAudio'),
  rawEvent: $('rawEvent'), btnRaw: $('btnRaw'), toast: $('toast'),
};

let settings = loadSettings();
el.videoSource.value = settings.video.enabled ? settings.video.source : 'none';

const st = {
  ws: null,
  phase: 'idle',          // idle | connecting | ready | closing
  speaking: false,         // LISTENING / SPEAKING 状态机
  muted: false,
  micStream: null, capCtx: null, capNode: null, capSrc: null,
  playCtx: null, playTime: 0, sources: new Set(),
  videoStream: null, videoTimer: null, frameNo: 0, canvas: document.createElement('canvas'),
  eventNo: 0, audioIn: 0, audioOut: 0,
  userBubble: null, botBubble: null,
  closeTimer: null,
};

// ---------------- UI 工具 ----------------
function toast(msg, type = 'info', ms = 4000) {
  el.toast.textContent = msg;
  el.toast.className = `toast toast-${type}`;
  el.toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.toast.hidden = true; }, ms);
}

function setStatus(text, cls) {
  el.status.textContent = text;
  el.status.className = `pill pill-${cls}`;
  el.orb.className = `orb orb-${cls}`;
}

function refreshStatus() {
  if (st.phase === 'idle') return setStatus('未连接', 'idle');
  if (st.phase === 'connecting') return setStatus('连接中…', 'connecting');
  if (st.phase === 'closing') return setStatus('结束中…', 'connecting');
  if (st.speaking) return setStatus('SPEAKING · 模型播报', 'speaking');
  return setStatus(st.muted ? 'LISTENING · 已静音' : 'LISTENING · 聆听中', 'listening');
}

function setControls() {
  const ready = st.phase === 'ready';
  el.btnCall.textContent = st.phase === 'idle' ? '开始通话' : '结束通话';
  el.btnCall.className = `btn btn-lg ${st.phase === 'idle' ? 'btn-primary' : 'btn-danger'}`;
  el.btnCall.disabled = st.phase === 'closing';
  for (const b of [el.btnMute, el.btnHello, el.btnCancel, el.btnCommit, el.btnRaw]) b.disabled = !ready;
  el.btnMute.textContent = st.muted ? '🔇 取消静音' : '🎙 静音';
  el.btnMute.classList.toggle('btn-warn', st.muted);
  refreshStatus();
}

const HIDDEN_TYPES = new Set(['input_audio_buffer.append', 'input_image_buffer.append', 'response.output_audio.delta']);
function log(dir, obj) {
  const type = obj?.type || '(unknown)';
  if (HIDDEN_TYPES.has(type) && !el.logAudio.checked) return;
  const row = document.createElement('div');
  row.className = `log-row log-${dir}${type === 'error' || type.startsWith('proxy.error') ? ' log-err' : ''}`;
  const brief = { ...obj };
  for (const k of ['audio', 'image', 'delta']) {
    if (typeof brief[k] === 'string' && brief[k].length > 120) brief[k] = `<base64 ${brief[k].length} chars>`;
  }
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  row.innerHTML = `<span class="log-time">${time}</span><span class="log-dir">${dir === 'up' ? '↑' : dir === 'down' ? '↓' : '•'}</span><span class="log-type"></span><pre></pre>`;
  row.querySelector('.log-type').textContent = type;
  row.querySelector('pre').textContent = JSON.stringify(brief);
  el.log.appendChild(row);
  while (el.log.childElementCount > 600) el.log.firstElementChild.remove();
  el.log.scrollTop = el.log.scrollHeight;
}

function bubble(role, text = '') {
  el.chat.querySelector('.chat-empty')?.remove();
  const b = document.createElement('div');
  b.className = `bubble bubble-${role} pending`;
  b.innerHTML = `<div class="bubble-role">${role === 'user' ? '我' : role === 'bot' ? '模型' : '系统'}</div><div class="bubble-text"></div>`;
  b.querySelector('.bubble-text').textContent = text;
  el.chat.appendChild(b);
  el.chat.scrollTop = el.chat.scrollHeight;
  return b;
}
function bubbleAppend(b, text, replace = false) {
  const t = b.querySelector('.bubble-text');
  t.textContent = replace ? text : t.textContent + text;
  el.chat.scrollTop = el.chat.scrollHeight;
}
function bubbleDone(b) { b?.classList.remove('pending'); }

// 服务端事件字段名未在文档中完全给出，这里兼容多种可能写法
function pickText(e, ...keys) {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => (o == null ? o : o[p]), e);
    if (typeof v === 'string') return v;
  }
  return null;
}

// ---------------- WebSocket ----------------
function send(obj) {
  if (!st.ws || st.ws.readyState !== WebSocket.OPEN) return false;
  if (settings.conn.sendEventId && !obj.event_id) obj.event_id = `evt_${Date.now().toString(36)}_${(++st.eventNo).toString(36)}`;
  st.ws.send(JSON.stringify(obj));
  log('up', obj);
  return true;
}

async function startCall() {
  settings = loadSettings();
  const { payload, errors } = buildSessionCreate(settings);
  const fatal = errors.filter((e) => !e.includes('帧率'));
  if (fatal.length) { toast(`设置有误：${fatal.join('；')}`, 'error', 7000); return; }
  if (!settings.conn.apiKey) {
    try {
      const cfg = await (await fetch('/api/config')).json();
      if (!cfg.hasServerKey) { toast('请先在「模型设置」中填写 API Key（或在服务端 .env 配置 SEED_API_KEY）', 'error', 7000); return; }
    } catch { /* 忽略，交由服务端校验 */ }
  }

  st.phase = 'connecting';
  st.lastError = '';
  st.speaking = false;
  st.muted = false;
  st.audioIn = st.audioOut = 0;
  setControls();
  el.usage.hidden = true;
  const vlabel = VOICES.find(([v]) => v === settings.audio.voice)?.[1].split(' · ')[0] || settings.audio.voice;
  el.modelInfo.textContent = `${settings.session.model} / ${vlabel}`;
  el.logid.textContent = '—';
  el.sessionId.textContent = '—';

  try {
    await startMic();
    await initPlayback();
  } catch (e) {
    toast(`无法打开麦克风：${e.message}`, 'error', 7000);
    await teardown();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  st.ws = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'proxy.connect', url: settings.conn.upstreamUrl, apiKey: settings.conn.apiKey }));
    log('sys', { type: 'proxy.connect', url: settings.conn.upstreamUrl });
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') { log('down', { type: '(binary frame)', size: ev.data.size }); return; }
    let msg;
    try { msg = JSON.parse(ev.data); } catch { log('down', { type: '(non-json)', text: ev.data.slice(0, 300) }); return; }
    handleEvent(msg, payload);
  };
  ws.onclose = (ev) => {
    log('sys', { type: 'ws.closed', code: ev.code, reason: ev.reason });
    if (st.phase !== 'idle') {
      if (st.lastError) toast(st.lastError, 'error', 12000);
      else if (st.phase !== 'closing') toast(`连接已断开（code ${ev.code}${ev.reason ? '：' + ev.reason : ''}）`, 'warn');
      teardown();
    }
  };
  ws.onerror = () => toast('与本地代理服务的连接出错，请确认 node server.js 正在运行', 'error');
}

function handleEvent(e, createPayload) {
  const t = e.type || (e.status_code ? 'error' : '');
  log(t.startsWith('proxy.') ? 'sys' : 'down', e.type ? e : { type: t, ...e });

  switch (t) {
    case 'proxy.connected':
      el.logid.textContent = e.logid || '（未返回）';
      send(structuredClone(createPayload));
      break;
    case 'proxy.error': {
      let detail = e.body ? String(e.body).slice(0, 200) : '';
      try {
        const err = JSON.parse(e.body).error;
        if (err) detail = `${err.code} ${err.message}`;
      } catch { /* body 不是 JSON */ }
      const hint = e.status === 401 ? '（API Key 无效：请在豆包语音新版控制台「API管理」页 console.volcengine.com/speech/new/setting/apikeys 获取 Key，注意 Key 与项目绑定，并在同一项目的「开通管理」中开通实时音视频模型）' : '';
      st.lastError = `${e.message}${detail ? '：' + detail : ''}${hint}`;
      toast(st.lastError, 'error', 12000);
      if (e.logid) el.logid.textContent = e.logid;
      break;
    }
    case 'proxy.upstream_closed':
      break;

    case 'session.created':
      el.sessionId.textContent = e.session?.id || '—';
      st.phase = 'ready';
      setControls();
      bubbleDone(bubble('sys', '通话已建立，可以开始说话'));
      startVideo(el.videoSource.value);
      if (settings.call.autoGreeting && settings.call.greeting.trim()) sayHello();
      break;
    case 'session.updated':
      toast('会话配置已更新');
      break;
    case 'session.closed':
      finishClose();
      break;

    case 'response.created':
      st.speaking = true;
      refreshStatus();
      break;
    case 'response.canceled':
      st.speaking = false;
      stopPlayback();
      bubbleDone(st.botBubble); st.botBubble?.classList.add('canceled'); st.botBubble = null;
      refreshStatus();
      break;
    case 'response.done': {
      st.speaking = false;
      bubbleDone(st.botBubble); st.botBubble = null;
      refreshStatus();
      const usage = e.usage || e.response?.usage;
      if (usage) { el.usage.hidden = false; el.usage.textContent = `本轮用量：${JSON.stringify(usage)}`; }
      break;
    }

    case 'conversation.item.input_audio_transcription.started':
      if (!st.userBubble) st.userBubble = bubble('user');
      break;
    case 'conversation.item.input_audio_transcription.delta': {
      const d = pickText(e, 'delta', 'transcript', 'text');
      if (d == null) break;
      if (!st.userBubble) st.userBubble = bubble('user');
      bubbleAppend(st.userBubble, d);
      break;
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const full = pickText(e, 'transcript', 'text');
      if (!st.userBubble) st.userBubble = bubble('user');
      if (full != null && full !== '') bubbleAppend(st.userBubble, full, true);
      bubbleDone(st.userBubble);
      st.userBubble = null;
      break;
    }
    case 'conversation.item.input_audio_transcription.failed':
      if (st.userBubble) { bubbleAppend(st.userBubble, '（识别失败）'); bubbleDone(st.userBubble); st.userBubble = null; }
      break;

    case 'response.output_text.delta': {
      const d = pickText(e, 'delta', 'text');
      if (d == null) break;
      if (!st.botBubble) st.botBubble = bubble('bot');
      bubbleAppend(st.botBubble, d);
      break;
    }
    case 'response.output_text.done': {
      const full = pickText(e, 'text');
      if (st.botBubble && full) bubbleAppend(st.botBubble, full, true);
      break;
    }
    case 'response.output_audio.delta': {
      const b64 = pickText(e, 'delta', 'audio');
      if (b64) playChunk(b64);
      break;
    }

    case 'response.function_call_arguments.done':
      bubbleDone(bubble('sys', `模型请求函数调用：${JSON.stringify(e)}（请在事件日志中用 conversation.item.create 回传结果）`));
      break;

    case 'error': {
      const code = e.error?.code ?? e.code ?? e.status_code ?? '';
      const msg = e.error?.message ?? e.message ?? JSON.stringify(e);
      toast(`服务端错误 ${code}：${msg}`, 'error', 9000);
      break;
    }
    default:
      break;
  }
}

async function stopCall() {
  if (st.phase === 'idle') return;
  if (st.ws?.readyState === WebSocket.OPEN && st.phase === 'ready') {
    st.phase = 'closing';
    setControls();
    stopVideo();
    send({ type: 'session.close' });
    // 文档要求：发送 session.close 后等待服务端回复再断开 WS
    st.closeTimer = setTimeout(finishClose, 4000);
  } else {
    teardown();
  }
}

function finishClose() {
  clearTimeout(st.closeTimer);
  teardown();
}

async function teardown() {
  clearTimeout(st.closeTimer);
  const ws = st.ws;
  st.ws = null;
  st.phase = 'idle';
  st.speaking = false;
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
  stopVideo();
  stopMic();
  stopPlayback();
  bubbleDone(st.userBubble); bubbleDone(st.botBubble);
  st.userBubble = st.botBubble = null;
  setControls();
}

// ---------------- 麦克风上行 ----------------
const b64FromBytes = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
};

async function startMic() {
  st.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: settings.audio.echoCancellation,
      noiseSuppression: settings.audio.noiseSuppression,
      autoGainControl: settings.audio.autoGainControl,
    },
  });
  st.capCtx = new AudioContext();
  await st.capCtx.audioWorklet.addModule('/js/capture-worklet.js');
  st.capSrc = st.capCtx.createMediaStreamSource(st.micStream);
  st.capNode = new AudioWorkletNode(st.capCtx, 'capture-processor');
  const sink = st.capCtx.createGain();
  sink.gain.value = 0;
  st.capSrc.connect(st.capNode).connect(sink).connect(st.capCtx.destination);
  st.capNode.port.onmessage = ({ data }) => {
    updateMeter(data.rms);
    if (st.phase !== 'ready' || st.muted) return;
    st.audioIn++;
    send({ type: 'input_audio_buffer.append', audio: b64FromBytes(new Uint8Array(data.pcm)) });
  };
}

function stopMic() {
  st.micStream?.getTracks().forEach((t) => t.stop());
  st.capNode?.port && (st.capNode.port.onmessage = null);
  st.capCtx?.close().catch(() => {});
  st.micStream = st.capCtx = st.capNode = st.capSrc = null;
  updateMeter(0);
}

function updateMeter(rms) {
  const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  el.meterFill.style.width = `${pct}%`;
  el.meterFill.classList.toggle('hot', db > -19.5);
  el.meterVal.textContent = Number.isFinite(db) ? `${db.toFixed(1)} dBFS` : '-∞ dBFS';
}

function toggleMute() {
  if (st.phase !== 'ready') return;
  st.muted = !st.muted;
  st.micStream?.getAudioTracks().forEach((t) => { t.enabled = !st.muted; });
  // 关麦后不再发送音频时必须发送静音事件保活，否则服务端超时
  send({ type: st.muted ? 'input_audio_mute.commit' : 'input_audio_unmute.commit' });
  setControls();
}

// ---------------- 播放下行音频 ----------------
async function initPlayback() {
  st.playCtx = new AudioContext({ sampleRate: 24000 });
  if (st.playCtx.state === 'suspended') await st.playCtx.resume();
  st.playTime = 0;
}

function playChunk(b64) {
  const ctx = st.playCtx;
  if (!ctx) return;
  const fmt = settings.audio.outputFormat;
  if (fmt === 'ogg_opus') {
    if (!playChunk.warned) { toast('当前页面不支持流式播放 ogg_opus，请在设置中改为 pcm_s16le', 'warn', 8000); playChunk.warned = true; }
    return;
  }
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const dv = new DataView(u8.buffer);
  let f32;
  if (fmt === 'pcm') { // 32 位小端浮点
    f32 = new Float32Array(Math.floor(u8.length / 4));
    for (let i = 0; i < f32.length; i++) f32[i] = dv.getFloat32(i * 4, true);
  } else { // pcm_s16le
    f32 = new Float32Array(Math.floor(u8.length / 2));
    for (let i = 0; i < f32.length; i++) f32[i] = dv.getInt16(i * 2, true) / 32768;
  }
  if (!f32.length) return;
  st.audioOut++;
  const buf = ctx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const now = ctx.currentTime;
  if (st.playTime < now + 0.02) st.playTime = now + 0.05; // 欠载时留少量缓冲
  src.start(st.playTime);
  st.playTime += buf.duration;
  st.sources.add(src);
  src.onended = () => st.sources.delete(src);
}

function stopPlayback() {
  for (const s of st.sources) { try { s.stop(); } catch { /* ignore */ } }
  st.sources.clear();
  if (st.playCtx) st.playTime = st.playCtx.currentTime;
}

// ---------------- 视频上行 ----------------
const SOURCE_NAME = { camera: '摄像头', screen: '屏幕共享', file: '本地文件' };

function startFrameTimer(label) {
  el.stageEmpty.hidden = true;
  el.videoBadge.textContent = `视频：${label} · ${settings.video.frame_format}`;
  const fps = Math.min(2, Math.max(0.2, Number(settings.video.frame_rate) || 2));
  el.fpsBadge.hidden = false;
  el.fpsBadge.textContent = `${fps} FPS 上行`;
  st.videoTimer = setInterval(sendFrame, 1000 / fps);
}

// 本地视频/图片作为画面源（适用于没有摄像头的虚拟机等环境）
function startFileVideo() {
  const f = st.mediaFile;
  if (!f) { el.videoBadge.textContent = '视频：未选择文件'; return; }
  st.fileUrl = URL.createObjectURL(f);
  if (f.type.startsWith('image/')) {
    el.previewImg.src = st.fileUrl;
    el.previewImg.classList.add('on');
  } else {
    el.preview.srcObject = null;
    el.preview.src = st.fileUrl;
    el.preview.loop = true;
    el.preview.classList.add('on');
    el.preview.play().catch(() => {});
  }
  startFrameTimer(`${SOURCE_NAME.file}（${f.name}）`);
}

async function startVideo(source) {
  stopVideo();
  if (source === 'none' || !settings.video.enabled) {
    el.videoBadge.textContent = settings.video.enabled ? '视频：关闭' : '视频：设置中已禁用';
    return;
  }
  if (source === 'file') { startFileVideo(); return; }
  try {
    const short = Number(settings.video.short_side) || 720;
    st.videoStream = source === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      : await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: short === 720 ? 1280 : short * 16 / 9 }, height: { ideal: short } } });
  } catch (e) {
    const why = e.name === 'NotFoundError' || e.name === 'OverconstrainedError' ? '未检测到设备' : e.message;
    toast(`无法获取${SOURCE_NAME[source]}：${why}。可在「画面」中改用屏幕共享或本地视频/图片`, 'warn', 7000);
    el.videoSource.value = 'none';
    el.videoBadge.textContent = '视频：关闭';
    return;
  }
  const track = st.videoStream.getVideoTracks()[0];
  track.onended = () => { if (st.videoStream) { el.videoSource.value = 'none'; stopVideo(); } };
  el.preview.srcObject = st.videoStream;
  el.preview.classList.add('on');
  el.preview.classList.toggle('mirror', source === 'camera');
  startFrameTimer(SOURCE_NAME[source]);
}

function sendFrame() {
  const img = el.previewImg.classList.contains('on');
  const v = img ? el.previewImg : el.preview;
  const vw = img ? v.naturalWidth : v.videoWidth;
  const vh = img ? v.naturalHeight : v.videoHeight;
  if (st.phase !== 'ready' || !vw) return;
  // 弱网时优先保音频：发送缓冲积压则跳过本帧
  if (st.ws && st.ws.bufferedAmount > 512 * 1024) return;
  const short = Number(settings.video.short_side) || 720;
  const scale = Math.min(1, short / Math.min(vw, vh));
  const w = Math.round(vw * scale), h = Math.round(vh * scale);
  const c = st.canvas;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  c.getContext('2d').drawImage(v, 0, 0, w, h); // 不做镜像/旋转（文档要求）
  const png = settings.video.frame_format === 'PNG';
  const url = c.toDataURL(png ? 'image/png' : 'image/jpeg', Number(settings.video.quality) || 0.75);
  send({ type: 'input_image_buffer.append', image: url.slice(url.indexOf(',') + 1), frame_id: `frame_${++st.frameNo}` });
}

function stopVideo() {
  clearInterval(st.videoTimer);
  st.videoTimer = null;
  st.videoStream?.getTracks().forEach((t) => t.stop());
  st.videoStream = null;
  el.preview.srcObject = null;
  el.preview.removeAttribute('src');
  el.preview.load();
  el.preview.classList.remove('on', 'mirror');
  el.previewImg.classList.remove('on');
  el.previewImg.removeAttribute('src');
  if (st.fileUrl) { URL.revokeObjectURL(st.fileUrl); st.fileUrl = null; }
  el.stageEmpty.hidden = false;
  el.fpsBadge.hidden = true;
  el.videoBadge.textContent = '视频：关闭';
}

// ---------------- 其他控制 ----------------
function sayHello() {
  const text = (settings.call.greeting || '').trim() || '你好，我是你的智能助手，有什么可以帮你？';
  send({ type: 'speech_text_buffer.commit', text });
}

el.btnCall.onclick = () => (st.phase === 'idle' ? startCall() : stopCall());
el.btnMute.onclick = toggleMute;
el.btnHello.onclick = sayHello;
el.btnCancel.onclick = () => { send({ type: 'response.cancel' }); stopPlayback(); };
el.btnCommit.onclick = () => send({ type: 'input_audio_buffer.commit' });
el.videoSource.onchange = () => {
  if (el.videoSource.value === 'file') { $('mediaFile').click(); return; } // 选择文件需在用户点击时触发
  if (st.phase === 'ready') startVideo(el.videoSource.value);
};
$('mediaFile').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) { el.videoSource.value = 'none'; return; }
  st.mediaFile = f;
  el.videoSource.querySelector('option[value="file"]').textContent = `本地：${f.name.length > 14 ? f.name.slice(0, 13) + '…' : f.name}`;
  if (st.phase === 'ready') startVideo('file');
};

// 检测是否有摄像头（虚拟机中通常没有），没有则禁用该选项
navigator.mediaDevices?.enumerateDevices?.().then((list) => {
  if (list.some((d) => d.kind === 'videoinput')) return;
  const opt = el.videoSource.querySelector('option[value="camera"]');
  opt.textContent = '摄像头（未检测到）';
  opt.disabled = true;
  if (el.videoSource.value === 'camera') el.videoSource.value = 'none';
}).catch(() => {});
$('btnClearLog').onclick = () => { el.log.innerHTML = ''; };
el.btnRaw.onclick = () => {
  let obj;
  try { obj = JSON.parse(el.rawEvent.value); } catch (e) { toast(`JSON 解析失败：${e.message}`, 'error'); return; }
  if (!obj.type) { toast('事件必须包含 type 字段', 'error'); return; }
  send(obj);
};

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('panel-chat').hidden = tab.dataset.tab !== 'chat';
    $('panel-log').hidden = tab.dataset.tab !== 'log';
  };
}

document.addEventListener('keydown', (e) => {
  if (e.target.matches('textarea, input')) return;
  if (e.code === 'KeyM') toggleMute();
});
window.addEventListener('beforeunload', () => { if (st.phase === 'ready') send({ type: 'session.close' }); });

setControls();
