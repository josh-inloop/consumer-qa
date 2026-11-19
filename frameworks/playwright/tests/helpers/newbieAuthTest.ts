import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { setLocationCookie } from './setLocationCookie';
import { setWhitelistedAnonId } from './setWhitelistedAnonId';

const runAuthInCI = /^(1|true|yes)$/i.test((process.env.PW_RUN_AUTH_IN_CI ?? '').trim());
const requireAuthState = process.env.REQUIRE_AUTH_STATE === '1' || runAuthInCI;

export const test = base.extend({
  context: async ({ context, baseURL }, use) => {
    if (runAuthInCI) {
      await setWhitelistedAnonId(context, baseURL);
      await setLocationCookie(context);
    }
    await use(context);
  },

  storageState: async ({}, use) => {
    const authPath = path.resolve(process.cwd(), 'tests', '.auth', 'newbie-auth.json');

    if (!fs.existsSync(authPath)) {
      const message =
        `Missing ${authPath}.\n` +
        `Run newbie-auth.setup.ts to generate newbie storageState before running newbie tests.\n`;

      if (requireAuthState) {
        throw new Error(message);
      } else {
        await use(undefined);
        return;
      }
    }

    await use(authPath);
  },
});

export { expect };
