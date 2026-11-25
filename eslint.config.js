import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'dist-electron', 'release']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      // Type-aware strict ruleset (catches unsafe casts, missing returns, etc.)
      ...tseslint.configs.strictTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Stale closures in useEffect are bugs, not warnings
      'react-hooks/exhaustive-deps': 'error',
      // Allow void operator for intentionally unhandled promises
      '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: true }],
      // Allow non-null assertions where the developer is certain
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Zustand store methods are closures — unbound-method is a false positive
      '@typescript-eslint/unbound-method': 'off',
      // Numbers/booleans in template literals are intended and safe
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Arrow-shorthand void returns are idiomatic React — only flag full function returns
      '@typescript-eslint/no-confusing-void-expression': [
        'error',
        { ignoreArrowShorthand: true },
      ],
      // TS already enforces nullability; ESLint's optional-chain check adds false positives
      '@typescript-eslint/no-unnecessary-condition': 'off',
      // Calling setState synchronously in effects is a valid cache-first pattern here
      'react-hooks/set-state-in-effect': 'off',
      // Hooks co-located with components in the same file are fine
      'react-refresh/only-export-components': 'warn',
    },
  },
  {
    // In tests, `value!` right after an assertion is the idiom, not a risk.
    files: ['**/__tests__/**/*.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    // Tests of the Electron main process import .cts sources, which no
    // tsconfig covers in ESM mode; lint them without type information.
    files: ['electron/**/__tests__/**/*.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
])
