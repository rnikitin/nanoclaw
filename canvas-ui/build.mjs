import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [path.join(__dirname, 'src/canvas-runtime.tsx')],
  bundle: true,
  outfile: path.join(__dirname, 'dist/canvas-runtime.js'),
  format: 'iife',
  target: 'es2020',
  minify: true,
  sourcemap: false,
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  external: [],
});

console.log('Built canvas-runtime.js');
