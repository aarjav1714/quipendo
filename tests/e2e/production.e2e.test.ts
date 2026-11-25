import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE, TOKEN } from '../mock/fixture';
import { startMockQuip, type MockQuip } from '../mock/quipMock';
import { driverFor } from './harness';

// The package people install is minified and has no test hooks, so the scenarios of browser.e2e.test.ts (which need them)
// cannot run on it. This loads it in each browser and checks the few things that can be seen without them.
// `npm run smoke`, `smoke:firefox` and `smoke:webkit` build the package and run this.
const production = process.env.E2E_PROD === '1';
const version = (JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as { version: string }).version;

describe.skipIf(!production)('the package people install', () => {
  const driver = driverFor(process.env.E2E_BROWSER ?? 'chromium');
  let mock: MockQuip;

  beforeAll(async () => {
    mock = await startMockQuip();
    await driver.start(mock);
  });
  afterAll(async () => {
    await driver.stop();
    await mock?.close();
  });

  it(`opens, says its version and tells the truth about the read-only guard in ${process.env.E2E_BROWSER ?? 'chromium'}`, async () => {
    const page = await driver.open();
    expect(await page.title()).toBe('Quipendo');
    await expect(page.textContent('#version')).resolves.toBe(version);
    await expect(page.textContent('#guard-status')).resolves.toContain(driver.can.guard ? 'read-only guard: on' : 'read-only guard: unavailable');
    await expect(page.isDisabled('#btn-run')).resolves.toBe(true);
    await page.click('#btn-connect');
    await expect.poll(() => page.textContent('#connect-status')).toContain('Paste your Quip access token first.');
    await page.close();
  });

  it('ignores the test settings in its address, so a link cannot point it at another server or hand it a token', async () => {
    const page = await driver.open({ base: mock.url, token: TOKEN, from: `${SITE}/AbCdEfGhIjKl/Plan` });
    await expect(page.inputValue('#token')).resolves.toBe('');
    // No test hooks, and nothing was sent to the server named in the address.
    await expect(page.evaluate(() => typeof (window as unknown as { __e2e?: unknown }).__e2e)).resolves.toBe('undefined');
    expect(mock.requests).toEqual([]);
    await page.close();
  });
});
