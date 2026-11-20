import { loadSettings, saveSettings, resetSettings, buildSessionCreate, getPath, setPath, deepMerge, DEFAULTS, VOICES } from './config.js';

const $ = (id) => document.getElementById(id);
let s = loadSettings();
let dirty = false;

$('voiceList').innerHTML = VOICES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

const fields = [...document.querySelectorAll('[data-k]')];

function readField(f) {
  if (f.type === 'checkbox') return f.checked;
  if (f.type === 'number' || f.type === 'range') return f.value === '' ? '' : Number(f.value);
  if (f.tagName === 'SELECT' && typeof getPath(DEFAULTS, f.dataset.k) === 'number') return Number(f.value);
  return f.value;
}

function fill() {
  for (const f of fields) {
    const v = getPath(s, f.dataset.k);
    if (f.type === 'checkbox') f.checked = !!v;
    else f.value = v ?? '';
  }
  showValues();
  render();
}

function showValues() {
  for (const b of document.querySelectorAll('[data-show]')) b.textContent = getPath(s, b.dataset.show);
}

function render() {
  const { payload, errors } = buildSessionCreate(s);
  const shown = structuredClone(payload);
  // 预览中遮盖密钥
  const mask = (o) => { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === 'object') mask(v); else if (/api_key/i.test(k) && v) o[k] = '••••••'; } };
  mask(shown);
  $('preview').textContent = JSON.stringify(shown, null, 2);
  $('errors').hidden = !errors.length;
  $('errors').innerHTML = errors.map((e) => `<div>⚠ ${e}</div>`).join('');
  // 联动禁用
  const toggle = (on, keys) => keys.forEach((k) => { const f = document.querySelector(`[data-k="${k}"]`); if (f) f.disabled = !on; });
  toggle(s.dialog.enable_volc_websearch, ['dialog.volc_websearch_type', 'dialog.volc_websearch_api_key', 'dialog.volc_websearch_result_count', 'dialog.volc_websearch_no_result_message']);
  toggle(s.visual.enabled, ['visual.search_type', 'visual.search_api_key']);
  toggle(s.video.enabled, ['video.source', 'video.frame_format', 'video.frame_rate', 'video.short_side', 'video.quality']);
  toggle(s.tts.aigc_enable, ['tts.aigc_content_producer', 'tts.aigc_produce_id', 'tts.aigc_content_propagator', 'tts.aigc_propagate_id']);
  toggle(s.dialog.loc_enable, ['dialog.loc_country', 'dialog.loc_country_code', 'dialog.loc_province', 'dialog.loc_city', 'dialog.loc_district', 'dialog.loc_town', 'dialog.loc_longitude', 'dialog.loc_latitude', 'dialog.loc_address']);
  toggle(s.video.frame_format === 'JPEG' && s.video.enabled, ['video.quality']);
}

function markDirty(v) {
  dirty = v;
  $('saveState').textContent = v ? '● 有未保存的修改' : '';
}

function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg; t.className = `toast toast-${type}`; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3000);
}

function save() {
  const { errors } = buildSessionCreate(s);
  if (saveSettings(s)) { markDirty(false); toast(errors.length ? `已保存（有 ${errors.length} 条提示，请检查预览）` : '已保存', errors.length ? 'warn' : 'ok'); }
  else toast('保存失败：浏览器存储不可用', 'error');
}

for (const f of fields) {
  const ev = f.type === 'checkbox' || f.tagName === 'SELECT' ? 'change' : 'input';
  f.addEventListener(ev, () => { setPath(s, f.dataset.k, readField(f)); showValues(); render(); markDirty(true); });
}

$('btnSave').onclick = save;
$('btnReset').onclick = () => {
  if (!confirm('确定恢复全部默认设置？（API Key 也会被清空）')) return;
  s = resetSettings(); fill(); markDirty(false); toast('已恢复默认');
};
$('btnExport').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...s, conn: { ...s.conn, apiKey: '' } }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'seed-realtime-settings.json'; a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出（不含 API Key）');
};
$('btnImport').onclick = () => $('importFile').click();
$('importFile').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    s = deepMerge(structuredClone(DEFAULTS), data);
    if (!data.conn?.apiKey) s.conn.apiKey = loadSettings().conn.apiKey;
    fill(); markDirty(true); toast('已导入，确认后点击保存');
  } catch (err) { toast(`导入失败：${err.message}`, 'error'); }
  e.target.value = '';
};
$('btnCopy').onclick = async () => {
  const { payload } = buildSessionCreate(s);
  try { await navigator.clipboard.writeText(JSON.stringify(payload, null, 2)); toast('已复制（含明文密钥）'); } catch { toast('复制失败', 'error'); }
};
$('toggleKey').onclick = () => {
  const f = document.querySelector('[data-k="conn.apiKey"]');
  f.type = f.type === 'password' ? 'text' : 'password';
  $('toggleKey').textContent = f.type === 'password' ? '显示' : '隐藏';
};
$('btnGeo').onclick = () => {
  if (!navigator.geolocation) { toast('浏览器不支持定位', 'error'); return; }
  navigator.geolocation.getCurrentPosition((p) => {
    s.dialog.loc_enable = true;
    s.dialog.loc_longitude = Number(p.coords.longitude.toFixed(6));
    s.dialog.loc_latitude = Number(p.coords.latitude.toFixed(6));
    fill(); markDirty(true); toast('已填入经纬度，城市等信息请手动补充');
  }, (err) => toast(`定位失败：${err.message}`, 'error'), { timeout: 10000 });
};

document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

fetch('/api/config').then((r) => r.json()).then((c) => {
  $('serverKeyHint').textContent = c.hasServerKey
    ? '服务端已配置 SEED_API_KEY，此处可留空；填写则优先使用此处的 Key'
    : '服务端未配置 SEED_API_KEY，需在此填写。Key 仅保存在本机浏览器中';
}).catch(() => {});

fill();
