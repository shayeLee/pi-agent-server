import { defineConfig } from '@playwright/test';
import foundation from './playwright.ui-foundation.config';
export default defineConfig({ ...foundation, testMatch: ['workspace.spec.ts', 'session-search-align.spec.ts', 'theme-menu.spec.ts', 'composer-geometry.spec.ts', 'focus-appearance.spec.ts', 'typography.spec.ts'], outputDir: 'test-results/workspace' });
