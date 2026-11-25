import type { BrowserName, E2EDriver } from './types';
import { ChromiumDriver } from './chromium';
import { FirefoxDriver } from './firefox';

/** The driver for a browser, chosen by `E2E_BROWSER`. */
export function driverFor(name: string): E2EDriver {
  switch (name as BrowserName) {
    case 'chromium':
      return new ChromiumDriver();
    case 'firefox':
      return new FirefoxDriver();
    default:
      throw new Error(`No end-to-end driver for "${name}". Use chromium or firefox.`);
  }
}
