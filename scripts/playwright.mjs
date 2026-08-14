// scripts/playwright.mjs
//
// Portable Playwright bootstrap for the real-browser validation scripts.
//
// Install once from the repository root:
//   pnpm install
//   pnpm run test:browser:install
//
// A custom Chromium binary may be supplied for CI or hardened environments with
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH. Otherwise Playwright uses its managed
// browser, which keeps local development and CI on the same supported contract.

import { chromium } from 'playwright';

export async function launchChromium(options = {}) {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  try {
    return await chromium.launch({ ...options, executablePath });
  } catch (error) {
    const detail = String(error?.message || error);
    if (!executablePath && /executable doesn't exist|browserType\.launch/i.test(detail)) {
      throw new Error(
        'Chromium is not installed. Run `pnpm install` followed by `pnpm run test:browser:install` from the repository root.'
      );
    }
    throw error;
  }
}

export { chromium };
