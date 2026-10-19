import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      'data/**',
      'pnpm-lock.yaml',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // @paysim/core stays runtime-agnostic (API + web + tests): no node:* imports.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: ['node:*'] }],
    },
  },
  prettier,
);
