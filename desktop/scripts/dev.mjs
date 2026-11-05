import { context } from 'esbuild';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electron = require('electron');

const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port: 5273, strictPort: true } });
await server.listen();
const url = server.resolvedUrls?.local?.[0] || 'http://localhost:5273';
console.log('[dev] renderer', url);

const ctx = await context({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(root, 'dist/preload/index.cjs'),
  define: { __APP_VERSION__: JSON.stringify(require(path.join(root, 'package.json')).version) },
  logLevel: 'info',
});
await ctx.watch();

const mainCtx = await context({
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main/index.cjs'),
  define: { __APP_VERSION__: JSON.stringify(require(path.join(root, 'package.json')).version) },
  logLevel: 'info',
});
await mainCtx.watch();
await mainCtx.rebuild();

const child = spawn(electron, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VEYRA_DEV_SERVER: url, NODE_ENV: 'development' },
});
child.on('close', async () => {
  await mainCtx.dispose();
  await ctx.dispose();
  await server.close();
  process.exit(0);
});
