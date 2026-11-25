import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const read = relative => fs.readFile(new URL('../' + relative, import.meta.url), 'utf8');
const [html, index, source, notes, pkg] = await Promise.all(['site/docs/watch.html', 'site/docs/index.html', 'src/watch.ts', 'docs/watch.md', 'package.json'].map(read));
const { name } = JSON.parse(pkg);

test('the Watch page has one title, the docs frame, and is reachable from the docs', () => {
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>Watch \| Retake Docs<\/title>/);
  assert.match(html, /name="viewport"/);
  assert.match(html, /<details class="docs-navigation" open>/);
  assert.match(html, /<noscript>[\s\S]*browser’s Find/);
  assert.ok(index.includes('href="/docs/watch"'), 'The docs index does not link to the Watch page');
  assert.ok(!html.includes('—'));
  assert.ok(!/\/Users\//.test(html + notes), 'A local home folder in public docs');
});

test('every anchor, ARIA target and local file on the Watch page exists', async () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of html.matchAll(/\bhref="#([^"]+)"/g)) assert.ok(ids.includes(match[1]), `Missing anchor ${match[1]}`);
  for (const match of html.matchAll(/\baria-(?:controls|describedby|labelledby)="([^"]+)"/g)) for (const id of match[1].split(' ')) assert.ok(ids.includes(id), `Missing ARIA target ${id}`);
  for (const match of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
    let file = match[1];
    if (file.endsWith('/')) file += 'index.html';
    else if (!/\.[a-z]+$/.test(file)) file += '.html';
    assert.ok((await fs.stat(new URL('../site' + file, import.meta.url))).isFile(), match[1]);
  }
  for (const img of html.match(/<img\b[^>]*>/g)) assert.match(img, /alt="[^"]*" width="\d+" height="\d+"/, img);
  assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)="https?:/i.test(html));
});

test('every call and option of the script side is documented on the page and in docs/watch.md', () => {
  const block = (label) => source.match(new RegExp(`export type ${label} = \\{([\\s\\S]*?)\\n\\};`))[1];
  const calls = [...block('Watch').matchAll(/^\s+(?:readonly )?(\w+)[(:]/gm)].map(match => match[1]);
  const options = [...block('WatchOptions').matchAll(/^\s+(\w+)\??:/gm)].map(match => match[1]);
  assert.ok(calls.includes('step') && calls.includes('end'));
  assert.ok(options.includes('fix'));
  for (const call of calls) {
    assert.ok(html.includes(`w.${call}`), `Not on the page: w.${call}`);
    assert.ok(notes.includes(`w.${call}`), `Not in docs/watch.md: w.${call}`);
  }
  for (const option of options) assert.ok(html.includes(`<code>${option}</code>`), `Option not on the page: ${option}`);
  const importLine = `import { startWatch } from '${name}/dist/watch.js';`;
  assert.ok(html.includes(importLine) && notes.includes(importLine), 'The page and docs/watch.md give different imports');
});

test('every retake watch command the CLI has is on the page, with the nightly wording', async () => {
  const cli = await read('src/cli.ts');
  const subs = [...cli.matchAll(/watchCmd\s*\.command\("([a-z]+)"\)/g)].map(match => match[1]);
  assert.deepEqual([...subs].sort(), ['accept', 'run', 'schedule']);
  for (const sub of subs) assert.ok(html.includes(`retake watch ${sub}`), `Not on the page: retake watch ${sub}`);
  for (const text of ['Accept as normal', 'Unchanged since', 'Changed last night', 'watch/']) assert.ok(html.includes(text), text);
});
