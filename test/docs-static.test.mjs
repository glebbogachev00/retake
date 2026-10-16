import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const read = relative => fs.readFile(new URL('../' + relative, import.meta.url), 'utf8');
const [html, js, css] = await Promise.all(['site/docs/index.html', 'site/docs/docs.js', 'site/docs/docs.css'].map(read));
// A compact checked-in release snapshot keeps compatibility checks independent
// of git history, network access and the newer local implementation.
const published = JSON.parse(await read('test/fixtures/retake-published-0.14.1.json'));
const release = published.gitHead;
const decode = text => text.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>');

test('docs have a single title and beginner-to-review section coverage', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Retake Docs/);
  assert.match(html, /name="viewport"/);
  for (const id of ['overview', 'quickstart', 'agents', 'first-demo', 'record-review-rerun', 'voice-captions', 'outputs', 'privacy-costs', 'troubleshooting', 'reference']) {
    assert.match(html, new RegExp(`<section id="${id}" data-doc-section>`));
  }
  for (const client of ['Claude Code', 'Codex', 'Cursor']) assert.ok(html.includes(`<h3 id="${client.toLowerCase().replace(' ', '-')}">${client}</h3>`));
  assert.ok(!html.includes('—'));
});

test('all local anchors and ARIA targets exist, with no duplicate IDs', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/\bhref="#([^"]+)"/g)) assert.ok(ids.includes(match[1]), `Missing anchor ${match[1]}`);
  for (const match of html.matchAll(/\baria-(?:controls|describedby|labelledby)="([^"]+)"/g)) for (const id of match[1].split(' ')) assert.ok(ids.includes(id), `Missing ARIA target ${id}`);
});

test('stylesheet and script assets exist and page needs no external assets', async () => {
  const local = [...html.matchAll(/(?:src|href)="(\/(?:docs\/)?[^"#]+\.(?:js|css|svg))"/g)].map(match => match[1]);
  assert.ok(local.includes('/landing.css'));
  for (const asset of local) assert.ok((await fs.stat(new URL('../site' + asset, import.meta.url))).isFile(), asset);
  assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)="https?:/i.test(html));
});

test('every copyable CLI command and flag matches the published 0.14.1 fixture', () => {
  assert.equal(published.package, 'retake-demos');
  assert.equal(published.version, '0.14.1');
  assert.equal(release, '0a74668c8f2a15a03951621c1a8bbd9232a4aa59');
  for (const url of Object.values(published.sources)) assert.ok(url.includes('/blob/' + release + '/'));
  assert.ok(html.includes(published.sources.cli));
  const blocks = [...html.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map(match => decode(match[1]));
  const commands = blocks.flatMap(block => block.split('\n')).filter(line => line.startsWith('retake '));
  assert.ok(commands.length >= 10);
  for (const line of commands) {
    const command = line.split(' ')[1];
    const definition = published.commands[command];
    assert.ok(definition, 'Unsupported published command: ' + command);
    for (const flag of line.match(/--[a-z-]+/g) || []) assert.ok(definition.flags.includes(flag), 'Unsupported published ' + command + ' flag: ' + flag);
  }
  // Non-Retake shell setup commands are exact released examples, not arbitrary scripts.
  const shellLines = blocks.flatMap(block => block.split('\n')).filter(line => /^(?:npm |npx |mkdir |cd )/.test(line));
  assert.equal(shellLines.length, 2);
  for (const line of shellLines) assert.ok(published.shellSetup.includes(line), 'Unsupported setup command: ' + line);
  assert.ok(html.includes(published.agentConfiguration.codexTable));
  assert.ok(html.includes(published.agentConfiguration.cursorPath));
  assert.match(html, /retake agent/);
  assert.match(html, /illustrative request, not a tested workflow/);
});

test('no-JS fallback keeps full code, open navigation and guides in HTML', () => {
  assert.match(html, /<noscript>[\s\S]*browser’s Find/);
  assert.match(html, /<details class="docs-navigation" open>/);
  assert.match(html, /<a class="docs-skip" href="#main">/);
  assert.match(html, /<pre><code>npm install/);
  assert.ok(!/<main[^>]*hidden/.test(html));
  assert.ok(!/<section[^>]*hidden/.test(html));
  assert.ok(!/<button/.test(html), 'Unavailable copy buttons must not appear without JS');
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /@media\(max-width:880px\)/);
  assert.match(css, /:focus-visible/);
});

test('docs JS is local, text-only and clipboard actions never execute commands', () => {
  new vm.Script(js);
  assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function)\s*\(/.test(js));
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|localStorage|sessionStorage/.test(js));
  assert.match(js, /link\.textContent = match\.title/);
  assert.match(js, /navigator\.clipboard\.writeText\(code\.textContent\)/);
  assert.match(js, /catch\s*\{[\s\S]*range\.selectNodeContents\(code\)/);
  assert.match(js, /event\.key === 'Escape'/);
  assert.match(js, /event\.key === 'ArrowDown'/);
  assert.match(js, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(html, /id="copy-feedback"[^>]+role="status"/);
});

test('content separates optional presentation, approval, local privacy and costs', () => {
  for (const text of ['Choose voiceover, captions, both, or neither.', 'first preview silent', 'approve a continuous narration script before speech is generated', 'secret: true', 'not pixels in the video', 'Visual checks can send frames to a model', 'not permission to use a paid model key', 'Dry-run', 'It can still change app state', 'Reviewed is not approved']) assert.ok(html.includes(text), text);
  assert.equal(published.manifest.voiceover.allowsBoolean, true);
  assert.equal(published.manifest.voiceover.default, false);
  assert.equal(published.manifest.music.optional, true);
  assert.deepEqual(published.manifest.music.types, ['string', 'object']);
  assert.equal(published.manifest.captions.disableValue, false);
  assert.match(html, /captions: false/);
});


test('beginner docs leave out the preview lifecycle flags and their guarantees', () => {
  assert.ok(Array.isArray(published.unsupportedPublicFlags));
  // Published since 0.14, but the agent drives them; a first reader does not need them.
  assert.ok(!/--(?:preview|final|fresh)\b/.test(html), 'Lifecycle flag in the beginner docs');
  for (const flag of published.unsupportedPublicFlags) assert.ok(!html.includes(flag), 'Unpublished flag in public HTML: ' + flag);
  assert.ok(!/one[- ]capture|correction budget|already finalized|capture[- ]hash|capture-relevant.*rejects/i.test(html));
  assert.match(html, /published <strong>Retake 0\.14\.1<\/strong>/);
  assert.ok(html.includes('/blob/' + release + '/src/cli.ts'));
  assert.match(html, /retake run demos\/my-demo\.yaml --no-master/);
  assert.match(html, /retake render outputs\/my-demo demos\/my-demo\.yaml --preset post-landscape --no-master/);
  assert.match(html, /set <code>voiceover: false<\/code> in the existing manifest and omit <code>music<\/code>/);
  assert.ok(!/music:\s*false/.test(html), 'Music must be omitted, not false');
  assert.match(html, /does not automatically force silence/);
});
