import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

let browser: Browser, server: Server, url: string;
before(async () => {
  server = createServer(async (req, res) => {
    try {
      const file = path.resolve('site', '.' + (req.url === '/' ? '/index.html' : req.url!));
      if (!file.startsWith(path.resolve('site') + path.sep)) { res.writeHead(403).end(); return; }
      const types: Record<string, string> = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise<void>(resolve => server?.close(() => resolve())); });

test('copy gives real clipboard success and an actionable failure, with responsive CTAs', async () => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  await page.goto(url);
  const hero = page.locator('#heroCopy');
  await hero.hover();
  await page.waitForTimeout(200);
  assert.notEqual(await hero.evaluate(el => getComputedStyle(el).transform), 'none');
  await hero.click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), (await page.locator('#pasteline').innerText()).trim());
  assert.match(await page.locator('#copy-status').innerText(), /Copied/);
  await page.waitForTimeout(2300);
  await page.evaluate("Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true })");
  await page.locator('.copybtn').click();
  assert.match(await page.locator('#copy-status').innerText(), /Select the prompt/);
  assert.doesNotMatch(await page.locator('.copybtn').innerText(), /Copied/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'pasteline');
  await context.close();
});

test('all three case details work with keyboard and without JavaScript', async () => {
  for (const javaScriptEnabled of [true, false]) {
    const page = await browser.newPage({ javaScriptEnabled });
    await page.goto(url);
    assert.equal(await page.locator('.case details').count(), 3);
    for (const details of await page.locator('.case details').all()) {
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await details.getAttribute('open'), '');
      assert.ok((await details.locator('p').innerText()).length > 20);
      await page.keyboard.press('Space');
      assert.equal(await details.getAttribute('open'), null);
    }
    assert.equal(await page.locator('.case .result:visible').count(), 3);
    await page.close();
  }
});

test('logo replays a finite animation by keyboard without navigation', async () => {
  const page = await browser.newPage();
  await page.goto(url);
  const logo = page.getByRole('button', { name: 'Replay the Retake mark' });
  assert.equal(await logo.count(), 1);
  await page.evaluate("window.markStarts = 0; document.querySelector('.mark').addEventListener('animationstart', () => window.markStarts++)");
  await logo.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction('window.markStarts === 4');
  await page.waitForTimeout(850);
  assert.equal(await page.locator('.mark').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
  await page.keyboard.press('Space');
  await page.waitForFunction('window.markStarts === 8');
  assert.equal(page.url(), url);
  await page.close();
});

test('sections reveal once, with reduced-motion and no-JS fallbacks', async () => {
  for (const mode of ['normal', 'reduced', 'no-js']) {
    const page = await browser.newPage({ javaScriptEnabled: mode !== 'no-js', reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    await page.goto(url);
    const section = page.locator('#start');
    if (mode === 'normal') {
      assert.ok((await section.getAttribute('class'))?.includes('reveal-pending'));
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      assert.ok(!(await section.getAttribute('class'))?.includes('reveal-pending'));
      await page.locator('.hero').scrollIntoViewIfNeeded();
      assert.ok(!(await section.getAttribute('class'))?.includes('reveal-pending'));
    } else {
      assert.equal(await page.locator('.reveal-pending').count(), 0);
      if (mode === 'reduced') {
        await page.locator('.mark-button').click();
        assert.equal(await page.locator('.mark').evaluate(el => el.getAnimations({ subtree: true }).length), 0);
        assert.equal(await page.locator('html').evaluate(el => getComputedStyle(el).scrollBehavior), 'auto');
      }
    }
    assert.equal(await section.evaluate(el => getComputedStyle(el).opacity), '1');
    await page.close();
  }
});

test('no-JS offers manual copy instead of a dead button', async () => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto(url);
  assert.equal(await page.locator('.copybtn').isVisible(), false);
  await page.locator('#heroCopy').click();
  assert.match(page.url(), /#start$/);
  assert.ok(await page.locator('#pasteline').isVisible());
  await page.close();
});

test('desktop/mobile visual evidence, media, touch details, and console are clean', async () => {
  for (const mobile of [false, true]) {
    const name = mobile ? 'mobile' : 'desktop';
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(process.env.LANDING_REVIEW_URL || url);
    const evidence = process.env.LANDING_EVIDENCE;
    const selectors = ['.hero', 'section[aria-labelledby="library-title"]', '#demo', 'section[aria-labelledby="cases-title"]', '.maker', '#start'];
    for (const [index, selector] of selectors.entries()) {
      await page.locator(selector).evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'start' }));
      await page.waitForTimeout(450);
      if (evidence) await page.screenshot({ path: `${evidence}/${name}-${index}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    for (const summary of await page.locator('.case summary').all()) {
      if (mobile) await summary.tap(); else await summary.click();
    }
    assert.equal(await page.locator('.case details[open]').count(), 3);
    await page.locator('section[aria-labelledby="cases-title"]').evaluate(el => el.scrollIntoView({ behavior: 'instant' }));
    if (evidence) await page.screenshot({ path: `${evidence}/${name}-cases-open.png` });
    await page.waitForFunction("Array.from(document.images).every(img => img.complete && img.naturalWidth > 0)");
    await page.waitForFunction("document.querySelector('video').readyState >= 2");
    await page.locator('video').evaluate(video => (video as HTMLVideoElement).play());
    await page.waitForFunction("document.querySelector('video').currentTime > 0.1");
    await page.locator('video').evaluate(video => (video as HTMLVideoElement).pause());
    if (mobile) {
      await page.evaluate("window.markStarts = 0; document.querySelector('.mark').addEventListener('animationstart', () => window.markStarts++)");
      await page.locator('.mark-button').tap();
      await page.waitForFunction('window.markStarts === 4');
    }
    console.log(`${name}: viewport=${JSON.stringify(page.viewportSize())}, documentWidth=${await page.evaluate(() => document.documentElement.scrollWidth)}, pageHeight=${await page.evaluate(() => document.documentElement.scrollHeight)}, all images loaded, video played, errors=${JSON.stringify(errors)}`);
    assert.deepEqual(errors, []);
    if (evidence) await page.screenshot({ path: `${evidence}/${name}-full.png`, fullPage: true });
    await page.close();
  }
});

test('process examples respond to pointer, keyboard, and touch', async () => {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    await page.goto(url);
    const steps = page.locator('.step-trigger');
    assert.equal(await steps.count(), 4);
    if (mobile) await steps.nth(1).tap(); else await steps.nth(1).hover();
    assert.equal(await steps.nth(1).getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#step-example').innerText(), /MP4/);
    await steps.nth(2).focus();
    await page.keyboard.press('Enter');
    assert.equal(await steps.nth(2).getAttribute('aria-pressed'), 'true');
    await steps.nth(3).click();
    assert.match(await page.locator('#step-example').innerText(), /rerun/);
    assert.equal(await page.locator('.step-trigger[aria-pressed="true"]').count(), 1);
    await context.close();
  }
});
