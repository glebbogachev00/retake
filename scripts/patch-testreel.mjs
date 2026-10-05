#!/usr/bin/env node
/**
 * Lift testreel's cursor cap.
 *
 * testreel draws the cursor overlay with ffmpeg expressions it builds as one
 * nested `if(lt(t,…),…,if(lt(t,…),…,…))` per keyframe. ffmpeg's expression
 * parser stops at 98 nesting levels, so past ~45 cursor moves the overlay
 * silently drops out of the video. Upstream (0.2.0) has not changed this.
 *
 * The same piecewise functions can be written flat — a sum of windowed
 * segments, `gte(t,a)*lt(t,b)*value` — with no nesting. Retake also applies
 * smoothstep easing to x/y movement so the cursor accelerates and settles
 * instead of travelling at a robotic constant speed. This script rewrites
 * the four builders Retake relies on (x/y position, show/hide, fade, cursor
 * style) in testreel's dist files.
 *
 * It runs on `postinstall`, is idempotent, and refuses to touch anything if
 * the functions are not byte-identical to testreel 0.2.0 — a newer testreel
 * means re-checking, not guessing. (testreel is pinned to an exact version
 * in package.json for the same reason.)
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const MARK = "/*retake:flat-cursor-v2*/";
const OLD_MARK = "/*retake:flat-cursor*/";

// The originals, exactly as shipped in testreel 0.2.0 (dist/index.js).
const ORIGINALS = {
  Qe: 'function Qe(e,t){if(e.length===0)return"0";if(e.length===1)return String(e[0].value);let o=String(e[e.length-1].value);for(let r=e.length-1;r>=1;r--){let n=e[r-1],i=e[r],s=i.transitionMs/1e3,a=i.time,u=a+s,l=`${n.value}+(${i.value}-${n.value})*(t-${a.toFixed(4)})/${s.toFixed(4)}`;o=`if(lt(t,${a.toFixed(4)}),${n.value},if(lt(t,${u.toFixed(4)}),${l},${o}))`}return o}',
  _t: 'function _t(e){let t=e.filter(n=>n.type==="hide"||n.type==="show");if(t.length===0)return"1";let r=t[t.length-1].type==="hide"?"0":"1";for(let n=t.length-2;n>=0;n--){let i=t[n].type==="hide"?"0":"1";r=`if(lt(t,${t[n+1].time.toFixed(4)}),${i},${r})`}return r=`if(lt(t,${t[0].time.toFixed(4)}),1,${r})`,r}',
  zt: 'function zt(e,t,o="T"){let r=e.filter(a=>a.type==="hide"||a.type==="show").sort((a,u)=>a.time-u.time);if(r.length===0)return"1";let n=Math.max(.001,t/1e3),s=r[r.length-1].type==="hide"?"0":"1";for(let a=r.length-1;a>=0;a--){let u=r[a],l=a===0?1:r[a-1].type==="hide"?0:1,p=u.type==="hide"?0:1,w=u.time,d=u.time+n;if(l===p){s=`if(lt(${o},${w.toFixed(4)}),${l},${s})`;continue}let f=p-l,h=`${l}+(${f})*(${o}-${w.toFixed(4)})/${n.toFixed(4)}`;s=`if(lt(${o},${w.toFixed(4)}),${l},if(lt(${o},${d.toFixed(4)}),${h},${s}))`}return s}',
  Mt: 'function Mt(e,t,o){let r=e.filter(a=>a.type==="move"&&a.cursorStyle!==void 0);if(r.length===0)return o===t?"1":"0";let n=[];n.push({time:0,active:o===t});for(let a of r)n.push({time:a.time,active:(a.cursorStyle??o)===t});let i=[n[0]];for(let a=1;a<n.length;a++)n[a].active!==i[i.length-1].active&&i.push(n[a]);if(i.length===1)return i[0].active?"1":"0";let s=i[i.length-1].active?"1":"0";for(let a=i.length-2;a>=0;a--){let u=i[a].active?"1":"0";s=`if(lt(t,${i[a+1].time.toFixed(4)}),${u},${s})`}return s}',
};

// Flat replacements. `__flat(v, segs)` sums windowed segments; a segment is
// {f, t, e}: from time f (null = -∞) to time t (null = +∞), expression e.
// Segments are contiguous and non-overlapping, so the sum IS the function.
// Where the originals let a running transition finish before the next
// keyframe takes over (nested ifs, outermost wins), these do the same.
const FLAT = {
  helper: `${MARK}function __flat(v,a){a=a.filter(s=>s.f==null||s.t==null||s.t>s.f);if(a.length===0)return"0";if(a.length===1)return"("+a[0].e+")";return a.map(s=>{let g=s.f==null?"":"gte("+v+","+s.f.toFixed(4)+")*",l=s.t==null?"":"lt("+v+","+s.t.toFixed(4)+")*";return g+l+"("+s.e+")"}).join("+")}`,
  Qe: 'function Qe(e,t){if(e.length===0)return"0";if(e.length===1)return String(e[0].value);let a=[{f:null,t:e[1].time,e:String(e[0].value)}],cur=e[1].time;for(let r=1;r<e.length;r++){let n=e[r-1],i=e[r],s=i.transitionMs/1e3,st=Math.max(i.time,cur),u=i.time+s,nx=r+1<e.length?e[r+1].time:null,p=`((t-${i.time.toFixed(4)})/${s.toFixed(4)})`;if(u>st){a.push({f:st,t:u,e:`${n.value}+(${i.value}-${n.value})*${p}*${p}*(3-2*${p})`});cur=u}if(nx==null||nx>cur){a.push({f:cur,t:nx,e:String(i.value)});if(nx!=null)cur=nx}}return __flat("t",a)}',
  _t: 'function _t(e){let t=e.filter(n=>n.type==="hide"||n.type==="show");if(t.length===0)return"1";let a=[{f:null,t:t[0].time,e:"1"}];for(let n=0;n<t.length;n++)a.push({f:t[n].time,t:n+1<t.length?t[n+1].time:null,e:t[n].type==="hide"?"0":"1"});return __flat("t",a)}',
  zt: 'function zt(e,t,o="T"){let r=e.filter(a=>a.type==="hide"||a.type==="show").sort((a,u)=>a.time-u.time);if(r.length===0)return"1";let n=Math.max(.001,t/1e3),a=[{f:null,t:r[0].time,e:"1"}],cur=r[0].time;for(let i=0;i<r.length;i++){let u=r[i],l=i===0?1:r[i-1].type==="hide"?0:1,p=u.type==="hide"?0:1,w=u.time,nx=i+1<r.length?r[i+1].time:null;if(l!==p){let st=Math.max(w,cur),d=w+n;if(d>st){a.push({f:st,t:d,e:`${l}+(${p-l})*(${o}-${w.toFixed(4)})/${n.toFixed(4)}`});cur=d}}if(nx==null||nx>cur){a.push({f:cur,t:nx,e:String(p)});if(nx!=null)cur=nx}}return __flat(o,a)}',
  Mt: 'function Mt(e,t,o){let r=e.filter(a=>a.type==="move"&&a.cursorStyle!==void 0);if(r.length===0)return o===t?"1":"0";let n=[];n.push({time:0,active:o===t});for(let a of r)n.push({time:a.time,active:(a.cursorStyle??o)===t});let i=[n[0]];for(let a=1;a<n.length;a++)n[a].active!==i[i.length-1].active&&i.push(n[a]);if(i.length===1)return i[0].active?"1":"0";let s=[];for(let a=0;a<i.length;a++)s.push({f:a===0?null:i[a].time,t:a+1<i.length?i[a+1].time:null,e:i[a].active?"1":"0"});return __flat("t",s)}',
};

// Retake v1 flattened the expressions without changing testreel's linear
// cursor interpolation. Keep its exact position builder so postinstall can
// upgrade an already-installed dependency in place.
const LEGACY_QE = 'function Qe(e,t){if(e.length===0)return"0";if(e.length===1)return String(e[0].value);let a=[{f:null,t:e[1].time,e:String(e[0].value)}],cur=e[1].time;for(let r=1;r<e.length;r++){let n=e[r-1],i=e[r],s=i.transitionMs/1e3,st=Math.max(i.time,cur),u=i.time+s,nx=r+1<e.length?e[r+1].time:null;if(u>st){a.push({f:st,t:u,e:`${n.value}+(${i.value}-${n.value})*(t-${i.time.toFixed(4)})/${s.toFixed(4)}`});cur=u}if(nx==null||nx>cur){a.push({f:cur,t:nx,e:String(i.value)});if(nx!=null)cur=nx}}return __flat("t",a)}';

function patchFile(file) {
  let src = fs.readFileSync(file, "utf8");
  if (src.includes(MARK)) return "already patched";
  if (src.includes(OLD_MARK)) {
    const n = src.split(LEGACY_QE).length - 1;
    if (n !== 1) throw new Error(`${path.basename(file)}: expected exactly one Retake v1 Qe builder, found ${n}`);
    src = src.replace(OLD_MARK, MARK).replace(LEGACY_QE, FLAT.Qe);
    fs.writeFileSync(file, src);
    return "upgraded";
  }
  for (const [name, original] of Object.entries(ORIGINALS)) {
    const n = src.split(original).length - 1;
    if (n !== 1) throw new Error(`${path.basename(file)}: expected exactly one copy of ${name} as shipped in testreel 0.2.0, found ${n} — testreel changed; re-check scripts/patch-testreel.mjs before trusting the cursor past ~45 moves`);
  }
  // Prepend the helper to the first builder so it is defined once, in scope.
  src = src.replace(ORIGINALS.Qe, FLAT.helper + FLAT.Qe);
  for (const name of ["_t", "zt", "Mt"]) src = src.replace(ORIGINALS[name], FLAT[name]);
  fs.writeFileSync(file, src);
  return "patched";
}

let dir;
try {
  // testreel's exports map hides package.json; walk up from the resolved entry.
  let d = path.dirname(require.resolve("testreel"));
  while (!fs.existsSync(path.join(d, "package.json"))) d = path.dirname(d);
  dir = d;
} catch { console.log("patch-testreel: testreel not installed yet — nothing to do"); process.exit(0); }
const version = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
if (version !== "0.2.0") throw new Error(`patch-testreel: written for testreel 0.2.0, found ${version}`);

// Retake imports the ESM build; the CJS build has different minified names
// and is left alone.
console.log(`patch-testreel: dist/index.js — ${patchFile(path.join(dir, "dist", "index.js"))}`);

/* ───────────────────────────────────────────────────────────────────────────
 * Stale click point.
 *
 * testreel's PageRecorder computes the target's bounding-box centre, THEN
 * moves the cursor and waits 90ms, and only then clicks at those coordinates.
 * Anything that settles in that window — a scroll finishing, a layout shift,
 * the cursor move itself scrolling the element into view — moves the target
 * out from under the point. A large button absorbs the error; a 44×24 toggle
 * does not, and the click lands on the page beside it. Silently: Playwright
 * reports a successful click, the step passes, and the app never changed.
 *
 * Cost of finding this from the outside: six takes. The recording is correct
 * in every other respect, so nothing downstream can see it — `check` passes,
 * the frame looks right, and only the app's state says otherwise.
 *
 * Fix: re-read the point immediately before clicking, keeping the original as
 * the fallback so a target that vanished still behaves as it used to.
 */
{
  const CLICK_MARK = "/*retake:fresh-click-point*/";
  const require2 = createRequire(import.meta.url);
  const dist = path.join(path.dirname(require2.resolve("testreel")), "index.js");
  const STALE = "let M=await we(e,y);await R(),await e.waitForTimeout(90),M&&await e.mouse.click(M.x,M.y),";
  const FRESH = `let M=await we(e,y);await R(),await e.waitForTimeout(90),${CLICK_MARK}M=await we(e,y)??M,M&&await e.mouse.click(M.x,M.y),`;
  try {
    const src = fs.readFileSync(dist, "utf8");
    if (src.includes(CLICK_MARK)) {
      console.log("patch-testreel: click point already fresh");
    } else if (!src.includes(STALE)) {
      console.log("patch-testreel: click path is not testreel 0.2.0's — leaving it alone");
    } else {
      fs.writeFileSync(dist, src.replace(STALE, FRESH));
      console.log("patch-testreel: click point re-read immediately before the click");
    }
  } catch (e) {
    console.log(`patch-testreel: could not patch the click point — ${e.message}`);
  }
}

/* ───────────────────────────────────────────────────────────────────────────
 * Page coordinates → video coordinates for the drawn cursor.
 *
 * Retake renders the page at a real device pixel ratio instead of CSS zoom,
 * so the page lays out at canvas÷scale while the video is the full canvas.
 * The cursor tracker records positions where the page says the mouse is —
 * page coordinates — and the overlay is drawn onto the video. Without this
 * the cursor would be drawn at 1/scale of where it really clicked: up and to
 * the left, on nothing. `coordinateScale` (Retake passes its page scale)
 * multiplies every event's position into video space at the one place the
 * events leave the tracker. Sizes (cursor, ripple) are already video pixels.
 */
{
  const SCALE_MARK = "/*retake:coordinate-scale*/";
  const require3 = createRequire(import.meta.url);
  const dist = path.join(path.dirname(require3.resolve("testreel")), "index.js");
  const PLAIN = "let A=u.getEvents();";
  const SCALED = `${SCALE_MARK}let A=u.getEvents().map(ev=>{const k=t.coordinateScale??1;if(k===1||typeof ev.x!=="number")return ev;const o={...ev,x:ev.x*k,y:ev.y*k};if(typeof ev.zoomTx==="number"){o.zoomTx=ev.zoomTx*k;o.zoomTy=ev.zoomTy*k}return o});`;
  try {
    const src = fs.readFileSync(dist, "utf8");
    if (src.includes(SCALE_MARK)) console.log("patch-testreel: cursor already scaled to video space");
    else if (!src.includes(PLAIN)) console.log("patch-testreel: cursor export is not testreel 0.2.0's — leaving it alone");
    else { fs.writeFileSync(dist, src.replace(PLAIN, SCALED)); console.log("patch-testreel: cursor positions scaled from page to video coordinates"); }
  } catch (e) {
    console.log(`patch-testreel: could not scale cursor coordinates — ${e.message}`);
  }
}
