import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../site',import.meta.url));
const html=await fs.readFile(path.join(root,'index.html'),'utf8');
const js=await fs.readFile(path.join(root,'landing.js'),'utf8');

test('page has one headline, descriptive metadata, and no duplicate IDs',()=>{
  assert.equal((html.match(/<h1\b/g)||[]).length,1);
  assert.match(html,/<title>Retake \| Video recording for your coding agent<\/title>/);
  assert.match(html,/<meta name="description" content="[^"]{80,}"/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(ids).size,ids.length);
  for(const id of [...html.matchAll(/\baria-(?:controls|labelledby|describedby)="([^"]+)"/g)].flatMap(m=>m[1].split(' '))) assert.ok(ids.includes(id),`Missing ARIA target: ${id}`);
});
test('every referenced local page and media file exists',async()=>{
  const refs=[...new Set([...`${html}\n${js}`.matchAll(/["'](\/[a-zA-Z0-9][^"'\s<>]*)["']/g)].map(m=>m[1]))];
  assert.ok(refs.length>10);
  for(const ref of refs){const pathname=new URL(ref,'http://localhost').pathname;let file=path.join(root,pathname);if(pathname.endsWith('/'))file=path.join(file,'index.html');else if(!path.extname(file))file+='.html';const stat=await fs.stat(file);assert.ok(stat.isFile()&&stat.size>0,`Missing asset ${ref}`);}
});
test('setup prompt and interactive enhancement use the same initial copy',()=>{
  const initial=html.match(/<pre id="setup-code">([^<]+)<\/pre>/)[1];
  assert.ok(js.includes(`code: '${initial}'`));
  assert.match(js,/navigator\.clipboard\.writeText\(setup\[currentSetup\]\.code\)/);
  assert.match(js,/video\.pause\(\)/);
  assert.match(js,/video\.load\(\)/);
  assert.match(js,/ArrowRight/);
  assert.match(js,/ArrowLeft/);
});
test('public copy keeps execution local and avoids unsupported capture claims',()=>{
  assert.match(html,/not a general desktop or native mobile screen recorder/);
  assert.match(html,/flow is reusable, not self-healing/);
  assert.match(html,/Optional visual checks send frames/);
});
test('styles support reduced motion and preserve comparison image proportions',async()=>{
  const css=await fs.readFile(path.join(root,'landing.css'),'utf8');
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css,/\.take-card img\{[^}]*height:auto/);
});

test('examples use the three explicitly selected published posts, not older local recordings',()=>{
  const source=html+'\n'+js;
  for(const url of ['https://x.com/trycapturez/status/2102280223316471854','https://www.facebook.com/reel/1670144871497010','https://x.com/Peaceful_HN/status/2099791282986258613']) assert.ok(source.includes(url),`Missing selected source ${url}`);
  for(const older of ['capture-workflow-15s-v1','scratch-mini-project.mp4','mark-done.mp4','retake-window-tour-v1']) assert.ok(!source.includes(older),`Outdated example remains: ${older}`);
  assert.equal((html.match(/data-example=/g)||[]).length,3);
});
test('original audio is enabled on explicit play and narration/captions are optional',()=>{
  const player=html.match(/<video\b[^>]*id="example-video"[^>]*>/)[0];
  assert.ok(!/\bmuted\b/.test(player));
  assert.ok(!/\bautoplay\b/.test(player));
  assert.match(js,/video\.muted = false/);
  assert.match(html,/57 sec · With voiceover/);
  assert.match(html,/Silent or with voiceover/);
  assert.match(html,/With or without captions/);
  assert.match(html,/Choose voiceover, captions, both, or neither/);
});
