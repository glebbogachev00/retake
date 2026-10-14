import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const read = file => fs.readFile(new URL('../site/' + file, import.meta.url), 'utf8');
const [b, a, css, compare, js] = await Promise.all(['layout-b/index.html', 'index.html', 'centered.css', 'compare/index.html', 'compare/compare.js'].map(read));

test('split A is the homepage; centered B is kept separately for comparison', () => {
  assert.match(b, /<body class="centered-layout">/);
  assert.match(b, /href="\/centered.css"/);
  assert.doesNotMatch(a, /centered-layout|centered\.css/);
  assert.match(b, /name="robots" content="noindex,follow"/);
  assert.doesNotMatch(a, /noindex/);
  assert.match(a, /<body class="split-layout">/);
  for (const html of [a,b]) {
    assert.equal((html.match(/<h1\b/g)||[]).length,1);
    assert.equal((html.match(/data-example=/g)||[]).length,3);
    assert.match(html,/57 sec · With voiceover/);
    assert.doesNotMatch(html,/brief-section|recording-brief|brief-builder|What do you want<br>to show/);
    assert.match(html,/href="\/docs\/"/);
  }
  assert.equal(a.match(/<source src="([^"]+)"/)[1],b.match(/<source src="([^"]+)"/)[1]);
  assert.match(a,/aria-orientation="vertical"/);
  assert.match(b,/aria-orientation="vertical"/);
});

test('B centers primary sections while retaining a balanced workflow grid', () => {
  assert.match(css,/\.centered-layout \.example-body\s*\{\s*display: block/);
  assert.match(css,/\.centered-layout \.brief-column\s*\{\s*display: none/);
  assert.match(css,/\.centered-layout \.workflow-grid\s*\{[^}]*grid-template-columns: minmax/);
  assert.match(css,/\.centered-layout \.connect-layout\s*\{[^}]*flex-direction: column/);
  assert.match(css,/\.centered-layout \.faq-layout\s*\{\s*display: block/);
  assert.match(css,/@media \(prefers-reduced-motion: reduce\)/);
});

test('comparison controls are keyboard-accessible and do not pretend to run a traffic experiment', () => {
  new vm.Script(js);
  assert.match(compare,/A: Split/);
  assert.match(compare,/B: Centered/);
  assert.match(compare,/Manual comparison only/);
  assert.match(compare,/no visitor assignment or conversion tracking/);
  assert.match(compare,/role="tablist"/);
  assert.match(js,/ArrowRight/);
  assert.match(js,/ArrowLeft/);
  assert.match(js,/path: '\/layout-b\/'/);
  assert.doesNotMatch(js,/Math\.random|document\.cookie|localStorage|sessionStorage|\bfetch\s*\(|sendBeacon|innerHTML/);
});

test('comparison and variant pages reference real local assets', async () => {
  for (const file of ['layout-b/index.html','split.css','split.js','compare/index.html','compare/compare.css','compare/compare.js','landing.css','landing.js','centered.css','docs/index.html']) assert.ok((await fs.stat(new URL('../site/'+file,import.meta.url))).size>0,file);
});


test('B setup card overrides split-layout alignment and artificial minimum heights', () => {
  assert.match(css,/\.centered-layout \.setup-shell\s*\{[^}]*align-self: center/);
  assert.match(css,/\.centered-layout \.setup-shell\s*\{[^}]*margin-inline: auto/);
  assert.match(css,/\.centered-layout #setup-panel\s*\{[^}]*min-height: 0/);
  assert.match(css,/\.centered-layout #setup-code\s*\{[^}]*min-height: 0/);
});
