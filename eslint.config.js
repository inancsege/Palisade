import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import pluginSecurity from 'eslint-plugin-security';
import redosPlugin from 'eslint-plugin-redos';

export default [
  // Global ignores
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },

  // Base recommended rules
  eslint.configs.recommended,

  // TypeScript recommended
  ...tseslint.configs.recommended,

  // Security plugin recommended
  pluginSecurity.configs.recommended,

  // ReDoS plugin (manual flat config -- legacy config not compatible with flat config)
  {
    plugins: {
      redos: redosPlugin,
    },
    rules: {
      'redos/no-vulnerable': 'error',
    },
  },

  // Source code: strict security and ReDoS rules
  {
    files: ['src/**/*.ts'],
    rules: {
      // Security rules as errors (block CI)
      'security/detect-unsafe-regex': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'warn', // Used intentionally in claude.ts
      'security/detect-non-literal-fs-filename': 'warn', // Used intentionally in loader.ts and other files

      // ReDoS as error
      'redos/no-vulnerable': ['error', { permittableComplexities: [] }],
    },
  },

  // Test files: relaxed security rules
  {
    files: ['test/**/*.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
      'security/detect-object-injection': 'off',
    },
  },

  // JS config files: no TypeScript type-checking
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
];
