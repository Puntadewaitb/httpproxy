// Bundle main (ESM) + preload (CJS, wajib untuk sandbox). Dependency npm tetap external.
import { build } from 'esbuild';

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, packages: 'external', logLevel: 'info' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', format: 'esm' }),
  // Preload sandboxed tidak bisa require modul lokal, jadi shared/api ikut di-bundle; hanya electron yang external.
  build({ ...common, packages: undefined, external: ['electron'], entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.cjs', format: 'cjs' }),
]);
