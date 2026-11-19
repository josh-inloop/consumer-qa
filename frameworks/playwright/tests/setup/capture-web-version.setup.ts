import dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';

const market = process.env.MARKET?.toLowerCase() || 'us';
dotenv.config({ path: path.resolve(__dirname, `../../../../.env.${market}`) });
import { chromium } from 'playwright';

async function main() {
  const repoRoot = process.cwd();
  const authPath = path.resolve(repoRoot, 'tests/.auth/auth.json');
  const baseURL = (process.env.BASE_URL ?? 'https://www.talos.app').replace(/\/$/, '');
  const isCI = /^(1|true|yes)$/i.test((process.env.CI ?? '').trim());

  const browser = await chromium.launch({ headless: isCI });
  const context = await browser.newContext({
    storageState: fs.existsSync(authPath) ? authPath : undefined,
  });
  const page = await context.newPage();

  // The version string only renders in the signed-in account nav, so this
  // depends on tests/.auth/auth.json already existing from generate-auth.setup.ts.
  await page.goto(`${baseURL}/account-settings`, { waitUntil: 'domcontentloaded' });

  // The element carries the version text even when Playwright's visibility
  // check marks it hidden (e.g. tucked in a collapsed section on desktop
  // width), so wait for it to exist in the DOM rather than to be visible.
  const versionLocator = page.getByTestId('appVersion').first();
  await versionLocator.waitFor({ state: 'attached', timeout: 15_000 });
  const raw = (await versionLocator.textContent())?.trim() ?? '';

  await browser.close();

  // Normalize to the same "v{semver} ({build})" shape the native apps report
  // (e.g. "v12.22.0 (196316)"), so it displays identically whether read raw
  // (the dashboard) or embedded directly (the Slack summary).
  const match = raw.match(/^(\d+\.\d+\.\d+)-(\d+)$/);
  const version = match ? `v${match[1]} (${match[2]})` : raw;

  fs.writeFileSync(path.resolve(repoRoot, 'web-version.txt'), version);
  // eslint-disable-next-line no-console
  console.log(`✅ Captured web version: ${version}`);
}

if (require.main === module) {
  main().catch((err) => {
    // Non-fatal: this is a nice-to-have for the daily summary, not a test.
    // eslint-disable-next-line no-console
    console.error('⚠️ Failed to capture web version (non-fatal):', err);
    process.exit(0);
  });
}
