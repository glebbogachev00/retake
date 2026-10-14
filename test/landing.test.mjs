import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
const base = process.env.RETAKE_LANDING_URL || 'http://127.0.0.1:4387';
const proof = process.env.RETAKE_LANDING_PROOF_DIR;

test('landing examples, setup, keyboard, FAQ, media, and responsive layouts', { timeout: 120000 }, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    await context.grantPermissions(['clipboard-read','clipboard-write'], { origin: base });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(base)) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    assert.match(await page.title(), /Video recording for your coding agent/);
    assert.equal(await page.locator('h1').count(), 1);
    await page.locator('#example-video').evaluate(video => video.readyState >= 1 || new Promise(resolve => video.addEventListener('loadedmetadata', resolve, { once: true })));
    assert.equal(await page.locator('#example-video').evaluate(video => video.videoWidth), 1280);
    assert.ok(Math.abs(await page.locator('#example-video').evaluate(video => video.duration) - 57) < 0.3);
    assert.equal(await page.locator('#example-video').evaluate(video => video.paused), true);
    for (const [name, src, text] of [
      ['Education', 'techtutor-cheesy-puffs-fb-v1.mp4', 'Scratch'],
      ['Content for X', 'capture-personal-x-2099791282986258613-v1.mp4', 'Capture'],
      ['Product videos', 'capture-x-2102280223316471854-v1.mp4', 'Capture']
    ]) {
      const tab = page.getByRole('tab', { name, exact: false });
      await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.match(await page.locator('#example-video').getAttribute('src'), new RegExp(src));
      assert.match(await page.locator('#example-request').innerText(), new RegExp(text));
      assert.equal(await page.locator('#example-video').evaluate(video => video.paused), true);
      await page.locator('#example-video').evaluate(video => video.readyState >= 1 || new Promise((resolve,reject) => { video.addEventListener('loadedmetadata', resolve, { once:true }); video.addEventListener('error', reject, { once:true }); }));
      assert.ok(await page.locator('#example-video').evaluate(video => video.duration > 0));
    }
    await page.locator('#tab-product').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-teaching').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tab-teaching').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('End');
    assert.equal(await page.locator('#tab-content').getAttribute('aria-selected'), 'true');
    await page.locator('#tab-product').click();
    await page.locator('#watch-demo').click();
    await page.waitForFunction(() => !document.querySelector('#example-video').paused);
    await page.locator('#example-video').evaluate(video => video.pause());
    for (const name of ['review','rerun','record']) {
      await page.locator(`#step-${name}`).click();
      assert.equal(await page.locator(`#step-${name}`).getAttribute('aria-selected'), 'true');
    }
    await page.locator('#step-rerun').click();
    assert.match(await page.locator('#workflow-detail-copy').innerText(), /revises the captions/);
    const proofResponse = await page.request.get(base + '/rerun-proof');
    assert.equal(proofResponse.status(), 200);
    await page.locator('#step-record').click();
    for (const method of ['cli','mcp','prompt']) {
      await page.locator(`#setup-${method}`).click();
      const code = await page.locator('#setup-code').innerText();
      await page.locator('#copy-setup').click();
      await page.waitForFunction(() => document.querySelector('#copy-status').textContent.startsWith('Copied'));
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), code);
    }
    await page.getByText('Does anything leave my machine?', { exact: true }).click();
    assert.equal(await page.locator('details').filter({ hasText: 'Does anything leave my machine?' }).getAttribute('open'), '');
    await page.getByText('Does anything leave my machine?', { exact: true }).click();
    await page.locator('#tab-product').click();
    for (const width of [1440, 1024, 768, 760, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => scrollTo(0,0));
      const sizes = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
      assert.ok(sizes.document <= width && sizes.body <= width, `Horizontal overflow at ${width}: ${JSON.stringify(sizes)}`);
      assert.ok(await page.locator('#example-video').isVisible());
      if (proof && [1440,390].includes(width)) {
        await fs.mkdir(proof,{ recursive:true });
        await page.screenshot({ path: `${proof}/retake-landing-${width}.png`, fullPage:true });
        if(width===1440) await page.screenshot({path:`${proof}/retake-landing-hero.png`});
      }
    }
    const links = await page.locator('[src],link[href]').evaluateAll(elements => [...new Set(elements.map(el=>el.getAttribute('src')||el.getAttribute('href')).filter(value => value?.startsWith('/') && !value.startsWith('//')))]);
    for(const url of links) assert.ok((await page.request.get(base+url)).ok(), `Missing local asset ${url}`);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); }
});
