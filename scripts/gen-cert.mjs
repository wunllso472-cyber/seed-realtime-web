// 生成自签名 HTTPS 证书（certs/key.pem、certs/cert.pem），SAN 包含 localhost 与本机所有局域网 IPv4
// 用法：npm run cert [额外IP或域名...]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'certs');
fs.mkdirSync(dir, { recursive: true });

const ips = new Set(['127.0.0.1']);
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
}
const extra = process.argv.slice(2);
const dns = new Set(['localhost', os.hostname()]);
for (const x of extra) (/^\d+\.\d+\.\d+\.\d+$/.test(x) ? ips : dns).add(x);

const san = [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((i) => `IP:${i}`)].join(',');
const cfg = path.join(dir, 'openssl.cnf');
fs.writeFileSync(cfg, `[req]
distinguished_name=dn
x509_extensions=v3
prompt=no
[dn]
CN=Seed Realtime Local
[v3]
subjectAltName=${san}
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
`);

try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-config', cfg], { stdio: 'inherit' });
} catch (e) {
  console.error('生成失败：需要 openssl（Git for Windows 自带，可在 Git Bash 中运行 npm run cert）');
  process.exit(1);
}
fs.unlinkSync(cfg);
console.log(`证书已生成：${dir}`);
console.log(`包含地址：${san}`);
