// 豆包 Seed-Realtime 代理服务器
// 作用：1) 提供前端静态页面；2) 浏览器 WebSocket 无法自定义请求头，
// 由本服务携带 X-Api-Key 连接上游 wss://openspeech.bytedance.com/api/v3/realtime 并双向转发 JSON 文本帧。
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_UPSTREAM = 'wss://openspeech.bytedance.com/api/v3/realtime';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROXY_TOKEN = (process.env.PROXY_TOKEN || '').trim();

function tokenOk(t) {
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(PROXY_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// HTTPS：局域网其他机器访问时，浏览器只允许在 HTTPS 下使用麦克风/摄像头
const CERT_DIR = path.join(__dirname, 'certs');
const certFiles = { key: path.join(CERT_DIR, 'key.pem'), cert: path.join(CERT_DIR, 'cert.pem') };
const httpsEnv = (process.env.HTTPS || 'auto').toLowerCase();
const certReady = fs.existsSync(certFiles.key) && fs.existsSync(certFiles.cert);
const USE_HTTPS = httpsEnv === 'auto' ? certReady : ['1', 'true', 'yes', 'on'].includes(httpsEnv);
if (USE_HTTPS && !certReady) {
  console.error('已启用 HTTPS 但未找到 certs/key.pem、certs/cert.pem，请先运行：npm run cert');
  process.exit(1);
}

const handler = (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // 健康检查：Render 等平台用它判断实例是否可用；也可用来提前唤醒休眠的免费实例
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), sessions: wss.clients.size }));
    return;
  }
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] });
    res.end(JSON.stringify({ hasServerKey: !!process.env.SEED_API_KEY, defaultUpstream: DEFAULT_UPSTREAM }));
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
};

const server = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(certFiles.key), cert: fs.readFileSync(certFiles.cert) }, handler)
  : http.createServer(handler);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (client, req) => {
  const tag = `[${new Date().toLocaleTimeString()} ${req.socket.remoteAddress}]`;
  let upstream = null;
  const pending = [];

  const sendCtl = (obj) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj)); };

  client.on('message', (data, isBinary) => {
    // 第一条消息必须是代理控制消息 proxy.connect
    if (!upstream) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { msg = null; }
      if (!msg || msg.type !== 'proxy.connect') {
        sendCtl({ type: 'proxy.error', message: '首条消息必须为 proxy.connect' });
        client.close(4000, 'bad handshake');
        return;
      }
      const clientKey = (msg.apiKey || '').trim();
      // 设置了 PROXY_TOKEN 时，使用服务端 Key 必须带正确口令（眼镜等公网客户端用这种方式接入）
      if (!clientKey && PROXY_TOKEN && !tokenOk(msg.token)) {
        console.warn(`${tag} 口令错误，拒绝连接`);
        sendCtl({ type: 'proxy.error', status: 401, message: '代理口令错误：请检查客户端 PROXY_TOKEN 与服务端 .env 是否一致' });
        client.close(4004, 'bad token');
        return;
      }
      const apiKey = clientKey || process.env.SEED_API_KEY;
      // 使用服务端 Key 时固定连官方地址，防止客户端把 Key 转发到任意主机
      const target = clientKey ? ((msg.url || '').trim() || DEFAULT_UPSTREAM) : DEFAULT_UPSTREAM;
      if (!apiKey) {
        sendCtl({ type: 'proxy.error', message: '未配置 API Key：请在设置页填写，或在服务端 .env 中配置 SEED_API_KEY' });
        client.close(4001, 'no api key');
        return;
      }
      if (!/^wss?:\/\//i.test(target)) {
        sendCtl({ type: 'proxy.error', message: '上游地址必须以 wss:// 或 ws:// 开头' });
        client.close(4002, 'bad url');
        return;
      }
      console.log(`${tag} 连接上游 ${target}`);
      upstream = new WebSocket(target, { headers: { 'X-Api-Key': apiKey }, maxPayload: 64 * 1024 * 1024 });

      let logid = '';
      upstream.on('upgrade', (res) => {
        logid = res.headers['x-tt-logid'] || '';
        console.log(`${tag} 上游已连接，X-Tt-Logid=${logid}`);
      });
      upstream.on('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          const lid = res.headers['x-tt-logid'] || '';
          console.warn(`${tag} 上游握手失败 HTTP ${res.statusCode} logid=${lid} ${body}`);
          sendCtl({ type: 'proxy.error', status: res.statusCode, logid: lid, message: `上游握手失败 HTTP ${res.statusCode}`, body });
          client.close(4003, 'upstream handshake failed');
        });
      });
      upstream.on('open', () => {
        sendCtl({ type: 'proxy.connected', logid });
        for (const [d, b] of pending.splice(0)) upstream.send(d, { binary: b });
      });
      upstream.on('message', (d, b) => {
        if (client.readyState === WebSocket.OPEN) client.send(d, { binary: b });
      });
      upstream.on('close', (code, reason) => {
        console.log(`${tag} 上游关闭 code=${code} ${reason}`);
        sendCtl({ type: 'proxy.upstream_closed', code, reason: reason.toString() });
        if (client.readyState === WebSocket.OPEN) client.close(1000, 'upstream closed');
      });
      upstream.on('error', (e) => {
        console.warn(`${tag} 上游错误`, e.message);
        sendCtl({ type: 'proxy.error', message: `上游连接错误：${e.message}` });
      });
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, isBinary]);
  });

  client.on('close', () => {
    if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
      upstream.close(1000);
    }
  });
  client.on('error', () => {});
});

server.listen(PORT, HOST, () => {
  const scheme = USE_HTTPS ? 'https' : 'http';
  const wildcard = HOST === '0.0.0.0' || HOST === '::';
  console.log(`Seed-Realtime Web 已启动（${scheme.toUpperCase()}）`);
  console.log(`  本机访问：${scheme}://${wildcard ? 'localhost' : HOST}:${PORT}`);
  if (wildcard) {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if (a.family === 'IPv4' && !a.internal) console.log(`  局域网访问：${scheme}://${a.address}:${PORT}`);
      }
    }
    if (!USE_HTTPS) console.warn('  ⚠ 未启用 HTTPS：其他机器通过 http 访问时浏览器会禁止麦克风/摄像头，请运行 npm run cert 后重启');
    if (process.env.SEED_API_KEY) console.warn('  ⚠ 服务端已配置 SEED_API_KEY，局域网内任何人都可以使用这个 Key 通话');
  }
  console.log(`服务端 API Key：${process.env.SEED_API_KEY ? '已配置' : '未配置（需在设置页填写）'}`);
  console.log(`代理口令 PROXY_TOKEN：${PROXY_TOKEN ? '已启用（使用服务端 Key 需带口令）' : '未设置'}`);
  if (wildcard && process.env.SEED_API_KEY && !PROXY_TOKEN) console.warn('  ⚠ 建议设置 PROXY_TOKEN，否则任何能访问本服务的人都能用服务端 Key');
});
