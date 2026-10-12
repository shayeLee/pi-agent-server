import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './e2e', testMatch: 'control-queue.spec.ts', workers: 1,
  outputDir: 'test-results/control-queue',
  use: { baseURL: 'http://127.0.0.1:60174', launchOptions: existsSync(chrome) ? { executablePath: chrome } : {}, trace: 'retain-on-failure' },
  webServer: { command: 'VITE_API_TARGET=http://127.0.0.1:1 volta run pnpm dev --port 60174 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:60174', reuseExistingServer: false },
});
