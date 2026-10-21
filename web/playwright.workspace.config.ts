import { defineConfig } from '@playwright/test';
import foundation from './playwright.ui-foundation.config';

// Same fixture-only setup as ui-foundation, on its own port so both groups can run at once.
export default defineConfig({
  ...foundation,
  testMatch: ['workspace.spec.ts', 'theme-menu.spec.ts'],
  // Every test mocks its own requests in its own page, so they can run side by side.
  fullyParallel: true,
  workers: 2,
  outputDir: 'test-results/workspace',
  use: { ...foundation.use, baseURL: 'http://127.0.0.1:5191' },
  webServer: {
    command: 'VITE_API_TARGET=http://127.0.0.1:1 volta run pnpm dev --port 5191 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:5191',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
