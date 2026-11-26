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

  it('opens the demo account, which needs no token and no network, and previews a document', async () => {
    const page = await driver.open();
    await page.click('#btn-demo');
    await page.waitForSelector('body[data-state="connected"]', { timeout: 60_000 });
    await expect(page.isVisible('#demo-banner')).resolves.toBe(true);
    await page.click('#btn-preview');
    await page.waitForSelector('#preview-result:not([hidden])', { timeout: 60_000 });
    const markdown = await page.inputValue('#preview-text');
    for (const label of ['**Process bar**', '**Calendar**', '**Kanban board**', '**Project tracker**']) expect(markdown, label).toContain(label);
    // The built (minified) page draws the same document, with its tables, checklist and comments.
    await expect(page.textContent('#preview-rendered h1')).resolves.toBe('Website Relaunch: Project Plan');
    await expect(page.$$eval('#preview-rendered table', (found) => found.length)).resolves.toBe(2);
    await expect(page.$$eval('#preview-rendered input[type="checkbox"]', (found) => found.length)).resolves.toBe(5);
    await expect(page.$$eval('#preview-rendered .md-comment', (found) => found.length)).resolves.toBeGreaterThanOrEqual(3);
    expect(mock.requests).toEqual([]);
    await page.close();
  });
});
