import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  clean: true,
  target: 'node20',
  banner: ({ entryPoint }) =>
    entryPoint?.endsWith('cli/index.ts')
      ? { js: '#!/usr/bin/env node' }
      : undefined,
});
