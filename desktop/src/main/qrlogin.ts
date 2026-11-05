import http from 'node:http';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import type { QrLoginState, SessionState } from '../shared/types';
import { adoptScannedSession } from './auth';
import { lanAddress, deviceName } from './paths';

const TTL_MS = 5 * 60 * 1000;
const MAX_BODY = 64 * 1024;

interface Live {
  server: http.Server;
  port: number;
  token: string;
  code: string;
  createdAt: number;
  timer: NodeJS.Timeout;
}

let live: Live | null = null;
let onLogin: ((state: SessionState) => void) | null = null;

export function setQrLoginListener(fn: (state: SessionState) => void): void {
  onLogin = fn;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export async function start(): Promise<QrLoginState> {
  await stop();
  const token = crypto.randomBytes(8).toString('hex');
  const code = String(crypto.randomInt(100000, 1000000));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${(server.address() as { port: number })?.port || 0}`);
    if (req.method !== 'POST' || url.pathname !== '/login') {
      reply(res, 404, { ok: false, error: 'not found' });
      return;
    }
    if (url.searchParams.get('t') !== token) {
      reply(res, 403, { ok: false, error: 'token' });
      return;
    }
    if (Date.now() - (live?.createdAt || 0) > TTL_MS) {
      reply(res, 410, { ok: false, error: 'expired' });
      return;
    }
    let payload: any;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      reply(res, 400, { ok: false, error: 'json' });
      return;
    }
    if (String(payload?.code || '') !== code) {
      reply(res, 403, { ok: false, error: 'code' });
      return;
    }
    if (!payload?.token || !payload?.user?.id || !payload?.server) {
      reply(res, 400, { ok: false, error: 'payload' });
      return;
    }
    reply(res, 200, { ok: true });
    let state: SessionState;
    try {
      state = adoptScannedSession({ server: String(payload.server), token: String(payload.token), user: payload.user });
    } catch (error) {
      console.warn('[qrlogin] 会话写入失败', error);
      return;
    }
    // 收尾放到下一个 tick：先把 200 发出去，手机那边才不会因为连接被掐而报错
    setTimeout(() => {
      const handler = onLogin;
      void stop();
      handler?.(state);
    }, 150);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });

  const port = (server.address() as { port: number }).port;
  const host = lanAddress();
  const name = `${deviceName()}（电脑）`;
  const url =
    `veyra://tv-login?h=${encodeURIComponent(host)}&p=${port}` +
    `&t=${token}&c=${code}&n=${encodeURIComponent(name)}`;

  const timer = setTimeout(() => void stop(), TTL_MS);
  live = { server, port, token, code, createdAt: Date.now(), timer };

  return { url, code, expiresIn: Math.floor(TTL_MS / 1000) };
}

export async function stop(): Promise<void> {
  const current = live;
  live = null;
  if (!current) return;
  clearTimeout(current.timer);
  await new Promise<void>((resolve) => current.server.close(() => resolve()));
}

export async function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' });
}
