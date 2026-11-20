// 设置的默认值、持久化以及 session.create 请求体构建
const STORAGE_KEY = 'seedrt.settings.v1';

export const VOICES = [
  ['zh_female_vv_jupiter_bigtts', 'Vivi 2.0 · 活泼灵动女声（默认）'],
  ['zh_female_xiaohe_jupiter_bigtts', '小何 2.0 · 甜美活泼女声'],
  ['zh_male_yunzhou_jupiter_bigtts', '云舟 2.0 · 清爽沉稳男声'],
  ['zh_male_xiaotian_jupiter_bigtts', '小天 2.0 · 清爽磁性男声'],
  ['en_male_tim_uranus_bigtts', 'Tim · 英文男声'],
  ['en_female_dacey_uranus_bigtts', 'Dacey · 英文女声'],
  ['en_female_stokie_uranus_bigtts', 'Stokie · 英文女声'],
];

export const DEFAULTS = {
  conn: {
    upstreamUrl: 'wss://openspeech.bytedance.com/api/v3/realtime',
    apiKey: '',
    sendEventId: true,
  },
  session: {
    model: '1.3.0.0',
    instructions: '你是音视频通话中的智能助手，可以结合摄像头或屏幕共享的画面回答用户的问题。回答口语化、简洁。',
    id: '',
    tools: '',
  },
  audio: {
    inputFormat: 'pcm',
    outputFormat: 'pcm_s16le',
    voice: 'zh_female_vv_jupiter_bigtts',
    speed: 0,
    loudness: 0,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
  asr: {
    end_smooth_window_ms: 1500,
    enable_custom_vad: false,
    enable_asr_twopass: false,
    hotwords: '',
    boosting_table_id: '',
    boosting_table_name: '',
    regex_correct_table_id: '',
    regex_correct_table_name: '',
  },
  tts: {
    max_length_to_filter_parenthesis: 0,
    explicit_dialect: '',
    aigc_enable: false,
    aigc_content_producer: '',
    aigc_produce_id: '',
    aigc_content_propagator: '',
    aigc_propagate_id: '',
  },
  dialog: {
    strict_audit: true,
    enable_volc_websearch: false,
    volc_websearch_type: 'web_global_api',
    volc_websearch_api_key: '',
    volc_websearch_result_count: 10,
    volc_websearch_no_result_message: '',
    enable_music: false,
    enable_loudness_norm: false,
    loc_enable: false,
    loc_country: '中国',
    loc_country_code: 'CN',
    loc_province: '',
    loc_city: '',
    loc_district: '',
    loc_town: '',
    loc_address: '',
    loc_longitude: '',
    loc_latitude: '',
    dialog_context: '',
  },
  visual: {
    enabled: false,
    search_type: 'web_global_api',
    search_api_key: '',
  },
  video: {
    enabled: true,
    source: 'camera',
    frame_format: 'JPEG',
    frame_rate: 2,
    short_side: 720,
    quality: 0.75,
  },
  call: {
    greeting: '',
    autoGreeting: false,
  },
  advanced: {
    overrideJson: '',
  },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

export function deepMerge(base, extra) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// 去掉 undefined / null / 空字符串 / 空对象 / 空数组，保留 false 与 0
export function clean(v) {
  if (Array.isArray(v)) {
    const a = v.map(clean).filter((x) => x !== undefined);
    return a.length ? a : undefined;
  }
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const c = clean(x);
      if (c !== undefined) o[k] = c;
    }
    return Object.keys(o).length ? o : undefined;
  }
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v))) return undefined;
  return v;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return deepMerge(DEFAULTS, JSON.parse(raw));
  } catch { /* 存储不可用时使用默认值 */ }
  return structuredClone(DEFAULTS);
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  return structuredClone(DEFAULTS);
}

function parseJsonField(text, name, errors) {
  if (!text || !String(text).trim()) return undefined;
  try { return JSON.parse(text); } catch (e) { errors.push(`${name} 不是合法 JSON：${e.message}`); return undefined; }
}

const num = (v) => (v === '' || v === null || v === undefined ? undefined : Number(v));

/** 根据设置构建 session.create 请求体，返回 { payload, errors } */
export function buildSessionCreate(s) {
  const errors = [];
  const hotwords = String(s.asr.hotwords || '')
    .split(/[\n,，]/).map((w) => w.trim()).filter(Boolean).map((word) => ({ word }));

  const location = s.dialog.loc_enable ? {
    country: s.dialog.loc_country,
    country_code: s.dialog.loc_country_code,
    province: s.dialog.loc_province,
    city: s.dialog.loc_city,
    district: s.dialog.loc_district,
    town: s.dialog.loc_town,
    address: s.dialog.loc_address,
    longitude: num(s.dialog.loc_longitude),
    latitude: num(s.dialog.loc_latitude),
  } : undefined;

  const ws = s.dialog.enable_volc_websearch;
  const payload = {
    type: 'session.create',
    session: {
      id: s.session.id,
      model: s.session.model,
      instructions: s.session.instructions,
      audio: {
        input: { format: { type: s.audio.inputFormat, rate: 16000 } },
        output: {
          format: { type: s.audio.outputFormat, rate: 24000 },
          voice: s.audio.voice,
          speed: num(s.audio.speed),
          loudness: num(s.audio.loudness),
        },
      },
      tools: parseJsonField(s.session.tools, 'tools', errors),
    },
    extension: {
      asr: {
        extra: {
          end_smooth_window_ms: num(s.asr.end_smooth_window_ms),
          enable_custom_vad: s.asr.enable_custom_vad,
          enable_asr_twopass: s.asr.enable_asr_twopass,
          boosting_table_id: s.asr.boosting_table_id,
          boosting_table_name: s.asr.boosting_table_name,
          regex_correct_table_id: s.asr.regex_correct_table_id,
          regex_correct_table_name: s.asr.regex_correct_table_name,
          context: hotwords.length ? { hotwords } : undefined,
        },
      },
      tts: {
        extra: {
          max_length_to_filter_parenthesis: num(s.tts.max_length_to_filter_parenthesis),
          explicit_dialect: s.tts.explicit_dialect,
          aigc_metadata: s.tts.aigc_enable ? {
            enable: true,
            content_producer: s.tts.aigc_content_producer,
            produce_id: s.tts.aigc_produce_id,
            content_propagator: s.tts.aigc_content_propagator,
            propagate_id: s.tts.aigc_propagate_id,
          } : undefined,
        },
      },
      dialog: {
        location,
        dialog_context: parseJsonField(s.dialog.dialog_context, 'dialog_context', errors),
        extra: {
          strict_audit: s.dialog.strict_audit,
          enable_volc_websearch: ws,
          volc_websearch_type: ws ? s.dialog.volc_websearch_type : undefined,
          volc_websearch_api_key: ws ? s.dialog.volc_websearch_api_key : undefined,
          // 新版文档未列出该字段（来自旧版协议），仅在用户改动默认值时下发
          volc_websearch_result_count: ws && num(s.dialog.volc_websearch_result_count) !== 10 ? num(s.dialog.volc_websearch_result_count) : undefined,
          volc_websearch_no_result_message: ws ? s.dialog.volc_websearch_no_result_message : undefined,
          enable_music: s.dialog.enable_music,
          enable_loudness_norm: s.dialog.enable_loudness_norm,
        },
        visual_search_config: s.visual.enabled ? {
          search_type: s.visual.search_type,
          search_api_key: s.visual.search_api_key,
        } : undefined,
      },
      video: s.video.enabled ? {
        frame_format: s.video.frame_format,
        frame_rate: num(s.video.frame_rate),
      } : undefined,
    },
  };

  let out = clean(payload);
  const override = parseJsonField(s.advanced.overrideJson, '高级覆盖 JSON', errors);
  if (isObj(override)) out = deepMerge(out, override);

  if (s.dialog.dialog_context && out.extension?.dialog?.dialog_context) {
    const dc = out.extension.dialog.dialog_context;
    if (!Array.isArray(dc)) errors.push('dialog_context 必须是数组');
    else if (dc.length % 2) errors.push('dialog_context 条数必须为偶数（user/assistant 成对）');
  }
  if (!out.session?.audio?.output?.voice) errors.push('音色 voice 为必填');
  if (s.dialog.enable_volc_websearch && !String(s.dialog.volc_websearch_api_key || '').trim()) {
    errors.push('已开启联网搜索但未填写搜索 API Key（会报错 42000020）');
  }
  if (s.visual.enabled && !String(s.visual.search_api_key || '').trim()) errors.push('已开启图搜但未填写图搜 API Key');
  if (num(s.video.frame_rate) > 2) errors.push('视频帧率上限为 2 FPS，超出的帧会被网关丢弃');
  return { payload: out, errors };
}

/** 读取对象路径 a.b.c */
export function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj); }
export function setPath(obj, p, v) {
  const ks = p.split('.'); let o = obj;
  for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
  o[ks.at(-1)] = v;
}
