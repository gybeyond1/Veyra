import { build } from 'esbuild';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const pkg = require(path.join(root, 'package.json'));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: process.env.NODE_ENV === 'production',
  external: ['electron'],
  logLevel: 'info',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
};

fs.mkdirSync(path.join(root, 'dist/main'), { recursive: true });

await build({
  ...common,
  entryPoints: [path.join(root, 'src/main/index.ts')],
  outfile: path.join(root, 'dist/main/index.cjs'),
});

await build({
  ...common,
  entryPoints: [path.join(root, 'src/preload/index.ts')],
  outfile: path.join(root, 'dist/preload/index.cjs'),
});

console.log('main + preload built');
