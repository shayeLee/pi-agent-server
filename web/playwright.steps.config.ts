import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
 testDir:'./e2e', testMatch:['steps.spec.ts', 'inspector-app.spec.ts', 'header-nav.spec.ts', 'step-numbers.spec.ts'],
 // Every test mocks its own requests in its own page, so they can run side by side.
 fullyParallel:true, workers:3, outputDir:'test-results/steps',
 use:{baseURL:'http://127.0.0.1:60186',launchOptions:existsSync(chrome)?{executablePath:chrome}:{},trace:'retain-on-failure'},
 webServer:{command:'VITE_API_TARGET=http://127.0.0.1:1 volta run pnpm dev --port 60186 --strictPort --host 127.0.0.1',url:'http://127.0.0.1:60186',reuseExistingServer:false},
});
