// @ts-check
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/out/**',
      '**/coverage/**',
      '**/.publish-staging/**',
      '**/.yarn/**',
      '**/storybook-static/**',
      '**/generated/**',
      '**/*.min.js',
      'shared/prisma/migrations/**',
      'apps/landing/.astro/**',
      '.dokkimi/**',
      '**/.next/**',
    ],
  },

  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettierRecommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },

  {
    files: ['apps/vscode/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
    },
  },

  {
    files: [
      '**/*.stories.{ts,tsx}',
      '**/*.spec.{ts,tsx}',
      '**/*.test.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
      'react-hooks/rules-of-hooks': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  {
    files: [
      'scripts/**/*.{js,cjs,mjs}',
      'tools/**/*.{js,cjs}',
      '**/.storybook/**/*.{js,cjs,mjs,ts}',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      sourceType: 'commonjs',
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    files: [
      '**/*.d.ts',
      'services/test-validation-service/src/test-validation/assertion-validator.service.ts',
    ],
    rules: {
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  {
    files: [
      'apps/cli/src/lib/formatting.ts',
      'apps/cli/src/lib/run-display.ts',
      'apps/cli/src/lib/terminal.ts',
      'shared/nestjs/logging/colored-logger.service.ts',
    ],
    rules: {
      'no-control-regex': 'off',
    },
  },

  eslintConfigPrettier,

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      curly: ['error', 'all'],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);
