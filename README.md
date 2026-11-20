# Seed 实时音视频 Web 应用

这是一个实时音视频通话 Web 应用，对接火山引擎豆包端到端实时音视频模型（Doubao-Seed-Realtime-1.0，[接口文档](https://docs.volcengine.com/docs/doubao-voice/seedrealtime?lang=zh)）。

## 启动

```bash
npm install
npm start            # 默认监听 http://127.0.0.1:3000
```

1. 打开 http://127.0.0.1:3000 ，点右上角「⚙ 模型设置」。
2. 填写 API Key（控制台 › API Key 管理）。不想在浏览器里保存 Key 的话，可以把 `.env.example` 复制为 `.env`，在里面填 `SEED_API_KEY`。
3. 保存设置，回到通话页点「开始通话」。

> 必须用 `localhost` / `127.0.0.1` 或 HTTPS 访问，否则浏览器不允许调用麦克风和摄像头。

## 部署到 Render（供 Rokid 眼镜等公网客户端使用）

1. 把本目录推到 GitHub/GitLab 仓库（`.env`、`certs/` 已在 `.gitignore` 中，不会上传）。
2. Render 控制台 → **New → Blueprint** → 选择仓库，会按 `render.yaml` 创建服务（新加坡区、健康检查 `/healthz`）。
3. 按提示填写 `SEED_API_KEY`；`PROXY_TOKEN` 自动生成，到服务的 **Environment** 页复制出来。
4. 眼镜端 `lib/config.js` 填 `PROXY_URL: 'wss://<服务名>.onrender.com/ws'` 和同一个 `PROXY_TOKEN`。

- 健康检查：`GET /healthz` 返回 `{"ok":true,"uptime":秒,"sessions":当前连接数}`。
- 免费档会休眠，冷启动约 30–60 秒：通话前可先在手机浏览器打开一次 `/healthz` 唤醒。
- 设置了 `PROXY_TOKEN` 后，不带自己 API Key 的客户端必须带正确口令，且只能连接官方上游地址。

## 架构

```
浏览器 ──ws://本机/ws──▶ server.js（携带 X-Api-Key）──wss──▶ openspeech.bytedance.com/api/v3/realtime
```

浏览器原生 WebSocket 不能设置自定义请求头，所以由 `server.js` 代理：它加上 `X-Api-Key` 请求头，双向转发 JSON 文本帧，并把响应头里的 `X-Tt-Logid` 回传给页面，方便排障。

## 功能

- **语音**：麦克风采集后重采样为 16kHz、int16、单声道，每 20ms 一包（640 字节）实时上行（`input_audio_buffer.append`）。下行支持播放 `pcm_s16le` 和 `pcm`（32 位浮点），采样率 24kHz。
- **视频**：画面可选摄像头或屏幕共享。按设置的帧率（不超过 2 FPS）、短边分辨率和 JPEG 质量抽帧上行（`input_image_buffer.append`）。发送缓冲积压时自动丢帧，优先保证音频。
- **状态机**：LISTENING / SPEAKING。收到 `response.canceled` 时立即清空播放缓冲。
- **控制按钮**：静音（发送 `input_audio_mute.commit` / `unmute` 保活，快捷键 M）、打招呼、打断（`response.cancel`）、强制判停（`input_audio_buffer.commit`）。结束通话时先发 `session.close`，等服务端回复后再断开。
- **对话字幕**：显示用户语音识别结果和模型回复文本，以及每轮的用量统计。
- **事件日志**：查看所有上下行事件，并可以手动发送原始 JSON 事件，用于调试或回传函数调用结果。
- **设置页**：可配置模型版本、系统提示词、tools、音色、语速和音量、输出格式、视频参数、ASR（判停窗口、二遍识别、热词与词表）、TTS（方言、括号过滤、AIGC 标识）、对话选项（审核、联网搜索、唱歌、响度均衡、图搜）、位置信息、历史上下文。另有「覆盖 JSON」可深度合并任意字段，并实时预览 `session.create` 请求体。设置支持导入和导出（导出文件不含 Key）。

## 说明

- 文档没有给出部分服务端事件的完整 JSON，例如 ASR 和文本增量的字段名到底是 `delta`、`transcript` 还是 `text`。前端对这几种写法做了兼容。如果实测字段不同，请在「事件日志」里查看原始事件，再调整 `public/js/app.js` 里的 `handleEvent`。
- 本页面不支持流式播放 `ogg_opus`，输出格式请使用 `pcm_s16le`。
- 外放时请开启回声消除，或者戴耳机，否则模型会听到自己的声音并打断自己。
