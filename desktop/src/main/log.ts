import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, userDataDir } from './paths';

const logDir = path.join(userDataDir, 'logs');
const logFile = path.join(logDir, 'desktop.log');
const MAX_BYTES = 2 * 1024 * 1024;

let ready = false;

function rotate(): void {
  try {
    const stat = fs.statSync(logFile);
    if (stat.size > MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    /* 文件还不存在 */
  }
}

/** 把主进程日志落到 userData/logs/desktop.log，出问题让用户直接发这个文件。 */
export function installFileLogger(): void {
  if (ready) return;
  ready = true;
  ensureDir(logDir);
  rotate();
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const write = (level: string, args: unknown[]) => {
    const line = `${new Date().toISOString()} [${level}] ${args
      .map((item) => (item instanceof Error ? `${item.message}\n${item.stack || ''}` : typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ')}\n`;
    stream.write(line);
  };
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args: unknown[]) => {
    original.log(...args);
    write('info', args);
  };
  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    write('warn', args);
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    write('error', args);
  };
}
