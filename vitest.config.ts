import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Also transform the Electron main-process sources (.cts) for their tests.
  oxc: { include: /\.(m|c)?tsx?$/ },
  test: {
    environment: 'jsdom',
    include: ['src/**/__tests__/**/*.test.ts', 'electron/**/__tests__/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
