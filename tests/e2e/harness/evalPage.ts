import type { E2EPage } from './types';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_TIMEOUT = 30_000;

/** The JavaScript that tells whether an element can be seen: it takes room on the page and is not hidden. */
const VISIBLE = `(el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'`;

let jobCounter = 0;

/**
 * A page that can only run a piece of JavaScript and hand back a string (Selenium, AppleScript). Everything the
 * scenarios do is built on that one thing, with the same waiting rules as Playwright: an element is clicked only once
 * it can be seen and is enabled. Scripts are handed to the browser as text, never run with `eval`, which the
 * extension's content security policy forbids.
 */
export abstract class EvalPage implements E2EPage {
  /** Runs a JavaScript expression in the page and returns its value, which must be a string. */
  protected abstract exec(expression: string): Promise<string>;
  abstract goto(url: string): Promise<unknown>;
  abstract url(): Promise<string>;
  abstract close(): Promise<void>;

  /** Evaluates `fn(arg)` in the page, waiting for a promise it returns; both ways cross as JSON. */
  async evaluate<R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> {
    const id = (jobCounter += 1);
    let started: string | null | undefined;
    for (let attempt = 0; attempt < 5 && started !== 'started'; attempt += 1) {
      if (attempt > 0) await sleep(100);
      started = await this.exec(`(() => {
      const jobs = (window.__e2eJobs = window.__e2eJobs || {});
      jobs[${id}] = { done: false };
      Promise.resolve()
        .then(() => (${fn.toString()})(${JSON.stringify(arg ?? null)}))
        .then((v) => { jobs[${id}] = { done: true, value: JSON.stringify(v === undefined ? null : v) }; },
              (e) => { jobs[${id}] = { done: true, error: String((e && e.stack) || e) }; });
      return 'started';
    })()`);
    }
    if (started !== 'started') throw new Error(`The page did not start the script: ${started}`);
    const deadline = Date.now() + 120_000;
    for (;;) {
      const answer = await this.exec(`(() => {
        const job = window.__e2eJobs && window.__e2eJobs[${id}];
        if (!job || !job.done) return 'PENDING';
        delete window.__e2eJobs[${id}];
        return JSON.stringify(job);
      })()`);
      if (answer !== null && answer !== undefined && answer !== 'PENDING') {
        const job = JSON.parse(answer) as { value?: string; error?: string };
        if (job.error !== undefined) throw new Error(job.error);
        return JSON.parse(job.value as string) as R;
      }
      if (Date.now() > deadline) throw new Error('The script did not finish in two minutes.');
      await sleep(20);
    }
  }

  /** Runs a synchronous function in the page now, and returns its value. */
  private async now<R>(fn: string, ...args: unknown[]): Promise<R | null> {
    const out = await this.exec(`JSON.stringify(((${fn})(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})) ?? null)`);
    // A page that is still being replaced (a tab that has only just opened) answers nothing at all.
    return out === null || out === undefined ? null : (JSON.parse(out) as R);
  }

  /** Looks for the element until `fn(element, ...args)` says `{ ok: true }`, then returns its `value`. */
  private async untilAvailable<R>(selector: string, fn: string, what: string, timeout = DEFAULT_TIMEOUT, ...args: unknown[]): Promise<R> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const result = await this.now<{ ok: boolean; value?: R }>(`(sel, ...rest) => (${fn})(document.querySelector(sel), ...rest)`, selector, ...args);
      if (result?.ok) return result.value as R;
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${selector} ${what}`);
      await sleep(40);
    }
  }

  async title(): Promise<string> {
    return (await this.now<string>('() => document.title')) ?? '';
  }

  async click(selector: string): Promise<void> {
    await this.untilAvailable(selector, `(el) => { if (!(${VISIBLE})(el) || el.disabled) return { ok: false }; el.click(); return { ok: true }; }`, 'to be visible and enabled');
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.untilAvailable(
      selector,
      `(el, v) => {
        if (!(${VISIBLE})(el) || el.disabled) return { ok: false };
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true };
      }`,
      'to be fillable',
      DEFAULT_TIMEOUT,
      value,
    );
  }

  async press(selector: string, key: 'Enter'): Promise<void> {
    await this.untilAvailable(
      selector,
      `(el, key) => {
        if (!(${VISIBLE})(el) || el.disabled) return { ok: false };
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
        return { ok: true };
      }`,
      'to take a key',
      DEFAULT_TIMEOUT,
      key,
    );
  }

  private async setChecked(selector: string, wanted: boolean): Promise<void> {
    await this.untilAvailable(
      selector,
      `(el, wanted) => { if (!(${VISIBLE})(el) || el.disabled) return { ok: false }; if (el.checked !== wanted) el.click(); return { ok: el.checked === wanted }; }`,
      `to be ${wanted ? 'ticked' : 'unticked'}`,
      DEFAULT_TIMEOUT,
      wanted,
    );
  }

  check(selector: string): Promise<void> {
    return this.setChecked(selector, true);
  }

  uncheck(selector: string): Promise<void> {
    return this.setChecked(selector, false);
  }

  /** Reads something off an element, waiting for the element to exist. */
  private async existing<R>(selector: string, fn: string): Promise<R> {
    return this.untilAvailable<R>(selector, `(el) => (el ? { ok: true, value: (${fn})(el) } : { ok: false })`, 'to exist');
  }

  async isVisible(selector: string): Promise<boolean> {
    return (await this.now<boolean>(`(sel) => (${VISIBLE})(document.querySelector(sel))`, selector)) === true;
  }

  isDisabled(selector: string): Promise<boolean> {
    return this.existing<boolean>(selector, '(el) => !!el.disabled');
  }

  isChecked(selector: string): Promise<boolean> {
    return this.existing<boolean>(selector, '(el) => !!el.checked');
  }

  textContent(selector: string): Promise<string | null> {
    return this.existing<string | null>(selector, '(el) => el.textContent');
  }

  inputValue(selector: string): Promise<string> {
    return this.existing<string>(selector, '(el) => el.value');
  }

  getAttribute(selector: string, name: string): Promise<string | null> {
    return this.existing<string | null>(selector, `(el) => el.getAttribute(${JSON.stringify(name)})`);
  }

  async waitForSelector(selector: string, options: { timeout?: number } = {}): Promise<unknown> {
    await this.untilAvailable(selector, `(el) => ((${VISIBLE})(el) ? { ok: true } : { ok: false })`, 'to appear', options.timeout ?? DEFAULT_TIMEOUT);
    return true;
  }

  async waitForFunction(fn: () => unknown, _arg?: undefined, options: { timeout?: number } = {}): Promise<unknown> {
    const deadline = Date.now() + (options.timeout ?? DEFAULT_TIMEOUT);
    for (;;) {
      if (await this.evaluate(fn)) return true;
      if (Date.now() > deadline) throw new Error('Timed out waiting for the page to satisfy a condition.');
      await sleep(40);
    }
  }

  waitForTimeout(ms: number): Promise<void> {
    return sleep(ms);
  }

  async $$(selector: string): Promise<unknown[]> {
    const count = (await this.now<number>('(sel) => document.querySelectorAll(sel).length', selector)) ?? 0;
    return Array.from({ length: count }, () => ({}));
  }

  async $$eval<R>(selector: string, fn: (elements: Element[]) => R): Promise<R> {
    return (await this.now<R>(`(sel) => (${fn.toString()})(Array.from(document.querySelectorAll(sel)))`, selector)) as R;
  }
}
