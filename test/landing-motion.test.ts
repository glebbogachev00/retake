import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, extname } from 'node:path';
import { chromium, webkit, type Page } from 'playwright';

const root = resolve(import.meta.dirname, '../site');
const baseline = execFileSync('git', ['show', 'HEAD:site/index.html'], { cwd: root });
const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url!, 'http://local').pathname);
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
    const data = path === '/baseline.html' ? baseline : await readFile(file);
    const mime: Record<string, string> = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml' };
    res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
      res.end(data.subarray(start, end + 1));
    } else { res.setHeader('Content-Length', data.length); res.end(data); }
  } catch { res.writeHead(404).end(); }
});

async function scroll(page: Page, y: number) {
  await page.evaluate(y => window.scrollTo({ top: y, behavior: 'instant' }), y);
  await page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
}
async function sample(page: Page, selector = '.case') {
  return page.locator(selector).first().evaluate(el => {
    const style = getComputedStyle(el), rect = el.getBoundingClientRect();
    const matrix = new DOMMatrixReadOnly(style.transform);
    return { scale: matrix.a, translate: matrix.f, opacity: Number(style.opacity), top: rect.top + scrollY, center: rect.top + rect.height / 2 };
  });
}

type Entrance = { kind: string; opacity: number; scale: number; translate: number };
async function observeEntrances(page: Page) {
  await page.addInitScript(() => {
    const state = window as unknown as { motionStarts: { kind: string; opacity: number; scale: number; translate: number }[] };
    state.motionStarts = [];
    document.addEventListener('animationstart', event => {
      const target = event.target as Element;
      const kind = event.animationName === 'retake-word' ? 'hero' :
        event.animationName === 'retake-enter' && target === document.querySelector('.case') ? 'card' : '';
      if (!kind) return;
      // Sample in the browser's first animation frame, not after a host roundtrip
      // that may take longer than the whole entrance under concurrent test load.
      const style = getComputedStyle(target), matrix = new DOMMatrixReadOnly(style.transform);
      state.motionStarts.push({ kind, opacity: Number(style.opacity), scale: matrix.a, translate: matrix.f });
    });
  });
}
async function starts(page: Page, kind: string): Promise<Entrance[]> {
  return page.evaluate(kind => (window as unknown as { motionStarts: Entrance[] }).motionStarts.filter(s => s.kind === kind), kind);
}

async function documentState(page: Page) {
  return page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('.motion-word').forEach(el => el.replaceWith(...el.childNodes));
    body.querySelectorAll('[data-motion]').forEach(el => el.removeAttribute('data-motion'));
    body.querySelectorAll('.hero-arrive, .motion-enter').forEach(el => {
      el.classList.remove('hero-arrive', 'motion-enter');
      if (!el.className) el.removeAttribute('class');
    });
    body.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));
    const geometry = [...document.querySelectorAll('main, header, section, h1, h2, .case, .frame, .steps, .actions, .start, footer')].map(el => {
      const r = el.getBoundingClientRect();
      return [r.x, r.y + scrollY, r.width, r.height];
    });
    return { html: body.innerHTML, geometry };
  });
}
function sameGeometry(actual: number[][], expected: number[][]) {
  assert.equal(actual.length, expected.length);
  actual.forEach((rect, i) => rect.forEach((v, j) => assert.ok(Math.abs(v - expected[i][j]) < .5, `geometry ${i}/${j}: ${v} vs ${expected[i][j]}`)));
}

if (process.env.RETAKE_MOTION_PREVIEW) {
  server.listen(Number(process.env.RETAKE_MOTION_PREVIEW), '127.0.0.1', () => console.log(`Retake preview http://127.0.0.1:${process.env.RETAKE_MOTION_PREVIEW}`));
} else test('landing motion browser matrix', async t => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    for (const engine of [chromium, webkit]) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await t.test(`${engine.name()} ${viewport.width}x${viewport.height}`, async () => {
        const browser = await engine.launch();
        try {
          const page = await browser.newPage({ viewport });
          if (engine === chromium) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
          await observeEntrances(page);
          const errors: string[] = [];
          page.on('pageerror', e => errors.push(e.message));
          page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
          await page.goto(url);
          assert.equal(await page.locator('.case[data-motion]').count(), 3, 'existing cards receive motion');
          assert.equal(await page.locator('[data-motion] [data-motion], [data-motion] video, video[data-motion]').count(), 0, 'no nested motion or moving player');
          assert.equal(await page.locator('.motion-word').count(), 4);
          await page.waitForTimeout(1100);
          assert.equal((await sample(page, '.motion-word')).opacity, 1, 'hero settles');
          const initialStarts = await starts(page, 'hero');
          assert.equal(initialStarts.length, 4, 'all original words assemble on arrival');
          assert.ok(initialStarts.some(s => s.opacity < .95 && s.translate > 5), 'arrival is visibly animated');
          await scroll(page, 1100);
          await page.waitForFunction(() => !document.querySelector('h1')!.classList.contains('hero-arrive'));
          await scroll(page, 0);
          await page.waitForFunction(() => document.querySelector('h1')!.classList.contains('hero-arrive'));
          await page.waitForFunction(count => (window as unknown as { motionStarts: Entrance[] }).motionStarts.filter(s => s.kind === 'hero').length > count, initialStarts.length);
          assert.ok((await starts(page, 'hero')).slice(initialStarts.length).some(s => s.opacity < .95 && s.translate > 5), 'hero visibly reassembles on return');
          await page.waitForTimeout(1100);
          const native = await page.evaluate(() => CSS.supports('animation-timeline: view()'));
          if (native) {
            const center = await page.locator('.case').first().evaluate(el => (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight / 2);
            const states = [];
            for (const fraction of [.65, .5, .35, .5, .65]) {
              await scroll(page, center - viewport.height * fraction);
              states.push(await sample(page));
            }
            assert.ok(Math.abs(states[0].scale - states[1].scale) > .004, 'scale changes inside viewport');
            assert.ok(Math.abs(states[0].translate - states[1].translate) > 8, 'translation changes inside viewport');
            assert.ok(Math.abs(states[2].translate - states[1].translate) > 8, 'no static middle plateau');
            assert.ok(Math.abs(states[0].top - states[4].top) < .5, 'reverse scroll returns exactly');
            const stopped = await sample(page);
            await page.waitForTimeout(220);
            assert.ok(Math.abs(stopped.top - (await sample(page)).top) < .5, 'no timed catch-up');
            console.log(engine.name(), viewport.width, JSON.stringify(states));
          }
          // Reduced motion must match the published DOM and settled layout exactly.
          const control = await browser.newPage({ viewport, reducedMotion: 'reduce' });
          await control.goto(url + '/baseline.html');
          const original = await documentState(control);
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.waitForFunction(() => !document.documentElement.hasAttribute('data-motion-mode'));
          await scroll(page, 0);
          const reduced = await documentState(page);
          assert.equal(reduced.html, original.html, 'text, links, media, semantic markup and order unchanged');
          sameGeometry(reduced.geometry, original.geometry);
          assert.equal((await sample(page)).scale, 1);
          const initialReduced = await browser.newPage({ viewport, reducedMotion: 'reduce' });
          await initialReduced.goto(url);
          sameGeometry((await documentState(initialReduced)).geometry, original.geometry);
          assert.equal(await initialReduced.locator('.motion-word').count(), 0, 'initial reduced stays original');
          const noJS = await browser.newPage({ viewport, javaScriptEnabled: false });
          await noJS.goto(url);
          const staticState = await documentState(noJS);
          assert.equal(staticState.html, original.html, 'no-JS original readable document');
          sameGeometry(staticState.geometry, original.geometry);
          await Promise.all([control.close(), initialReduced.close(), noJS.close()]);
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          await page.waitForFunction(() => !!document.documentElement.dataset.motionMode);
          assert.equal(await page.locator('.motion-word').count(), 4, 'runtime enable does not double-wrap');
          await page.waitForTimeout(1100);
          // Inspect the entire page for overflow and missing images, not just the hero.
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          for (let y = 0; y < height; y += viewport.height / 2) {
            await scroll(page, y);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
          }
          assert.ok(await page.locator('img').evaluateAll(images => images.every(image => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0)), 'all proof images load');
          await scroll(page, 0);
          await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
          assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'GitHub');
          await page.keyboard.press(engine === webkit ? 'Alt+Tab' : 'Tab');
          assert.equal(await page.evaluate(() => document.activeElement?.id), 'heroCopy');
          // Paste the actual clipboard into a temporary probe, then remove it.
          for (const selector of ['#heroCopy', '.copybtn']) {
            await page.locator(selector).click();
            await page.waitForFunction(s => document.querySelector(s)?.textContent === 'Copied — paste it to your agent', selector);
            const expected = await page.locator('#pasteline').textContent();
            await page.evaluate(() => {
              const probe = document.createElement('textarea'); probe.id = 'clipboard-probe';
              document.body.append(probe);
            });
            await page.locator('#clipboard-probe').focus();
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
            assert.equal(await page.locator('#clipboard-probe').inputValue(), expected?.trim());
            await page.locator('#clipboard-probe').evaluate(el => el.remove());
          }
          await page.locator('.case a').first().focus();
          assert.equal((await sample(page)).scale, 1, 'focused card stable');
          assert.equal((await sample(page)).translate, 0);
          await page.locator('.copybtn').focus();
          const focused = await sample(page, '.start');
          await scroll(page, (await page.evaluate(() => scrollY)) - 60);
          await page.waitForTimeout(220);
          assert.ok(Math.abs((await sample(page, '.start')).top - focused.top) < .5, 'focused copy panel stable');
          await page.locator('video').scrollIntoViewIfNeeded();
          await page.locator('video').evaluate(async el => { const video = el as HTMLVideoElement; video.muted = true; await video.play(); });
          const time = await page.locator('video').evaluate(video => (video as HTMLVideoElement).currentTime);
          const player = await sample(page, 'video');
          await scroll(page, (await page.evaluate(() => scrollY)) + 80);
          await page.waitForTimeout(400);
          assert.ok(await page.locator('video').evaluate((el, time) => { const video = el as HTMLVideoElement; return video.currentTime > time && !video.paused && !video.error; }, time), 'real video playback advances');
          assert.ok(Math.abs((await sample(page, 'video')).top - player.top) < .5, 'playing video stable');
          assert.deepEqual(errors, [], 'no browser errors');
          await page.close(); // Do not leave a second page decoding video during fallback timing checks.
          // Exercise the real fallback path even when this engine supports view().
          const fallback = await browser.newPage({ viewport });
          await observeEntrances(fallback);
          await fallback.addInitScript(() => {
            const supports = CSS.supports.bind(CSS);
            CSS.supports = ((...args: string[]) => args[0].includes('animation-timeline') ? false : supports(...args as [string, string])) as typeof CSS.supports;
          });
          await fallback.goto(url);
          assert.equal(await fallback.locator('html').getAttribute('data-motion-mode'), 'fallback');
          for (let repeat = 0; repeat < 2; repeat++) {
            await scroll(fallback, 0);
            await fallback.waitForFunction(() => !document.querySelector('.case')!.classList.contains('motion-enter'));
            const previousStarts = (await starts(fallback, 'card')).length;
            const y = await fallback.locator('.case').first().evaluate(el => (el as HTMLElement).offsetTop - innerHeight * .6);
            await scroll(fallback, y);
            await fallback.waitForFunction(() => document.querySelector('.case')!.classList.contains('motion-enter'));
            await fallback.waitForFunction(count => (window as unknown as { motionStarts: Entrance[] }).motionStarts.filter(s => s.kind === 'card').length > count, previousStarts);
            const replay = (await starts(fallback, 'card')).slice(previousStarts);
            assert.ok(replay.some(s => s.scale < .999 && s.opacity < .95 && s.translate > 5), `fallback visibly replays: ${JSON.stringify(replay)}`);
            await fallback.waitForTimeout(650);
            assert.equal((await sample(fallback)).opacity, 1, 'fallback never stays hidden');
            const settled = await sample(fallback);
            await fallback.waitForTimeout(220);
            assert.ok(Math.abs((await sample(fallback)).top - settled.top) < .5);
          }
          await fallback.emulateMedia({ reducedMotion: 'reduce' });
          await fallback.waitForFunction(() => !document.documentElement.dataset.motionMode);
          assert.equal((await sample(fallback)).scale, 1);
        } finally { await browser.close(); }
      });
    }
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
