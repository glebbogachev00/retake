/** The share page: one take playing, what it shows under it, one obvious next
    move (Next), and the rest of the takes in order beside it. Retake's own look
    (site/landing.css): warm paper, ink, one amber accent, mono labels. The
    Retake mark is on the page frame, never on a client's video.

    Every word on it comes from someone's manifest, so it is data: it goes in
    as JSON and onto the page through textContent, never as markup. */
import type { ShareTake } from "./share.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const MARK = `<rect width="64" height="64" rx="14" fill="#1a1c1e"/><g fill="#eceee9"><rect x="16" y="12" width="12" height="6" rx="3" opacity=".55"/><rect x="16" y="21" width="20" height="6" rx="3" opacity=".8"/><rect x="16" y="39" width="20" height="6" rx="3" opacity=".8"/><rect x="16" y="48" width="12" height="6" rx="3" opacity=".55"/></g><rect x="16" y="30" width="36" height="6" rx="3" fill="#e8b04b"/>`;

export function sharePage(o: { title: string; by?: string; recorded?: Date; takes: ShareTake[] }): string {
  const data = JSON.stringify(o.takes).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
  const one = o.takes.length === 1;
  const when = o.recorded && !Number.isNaN(o.recorded.getTime())
    ? `Recorded ${o.recorded.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}` : "Recorded with Retake";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(o.title)} · Retake</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${MARK}</svg>`)}">
<style>
  :root { --paper:#fbfaf7; --panel:#fffefa; --ink:#252720; --muted:#72736b; --line:#e6e5dd; --line-dark:#d4d3c9; --accent:#dda547; --accent-ink:#8a601e; --tint:#f4eedf; --red:#a3462f;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; color-scheme:light; }
  * { box-sizing:border-box; } html,body { margin:0; }
  body { background:var(--paper); color:var(--ink); font:15px/1.55 var(--sans); -webkit-font-smoothing:antialiased; }
  a { color:inherit; text-decoration:none; } button { font:inherit; cursor:pointer; }
  button:focus-visible, a:focus-visible { outline:2px solid var(--accent-ink); outline-offset:4px; }
  .wrap { width:min(1120px, calc(100% - 32px)); margin-inline:auto; }
  .bar { display:flex; align-items:center; justify-content:space-between; gap:16px; height:72px; border-bottom:1px solid var(--line); }
  .brand { display:inline-flex; align-items:center; gap:10px; font-size:19px; font-weight:650; letter-spacing:-.6px; }
  .brand svg { width:26px; height:26px; display:block; }
  .bar-note { font:11px/1.4 var(--mono); color:var(--muted); text-align:right; }
  .intro { padding:44px 0 28px; display:grid; gap:14px; }
  .eyebrow { font:11px/1.6 var(--mono); color:var(--muted); margin:0; }
  h1 { margin:0; font-size:clamp(30px,4vw,46px); font-weight:500; line-height:1.1; letter-spacing:-1.8px; text-wrap:balance; overflow-wrap:anywhere; }
  .lede { margin:0; color:var(--muted); font-size:16px; max-width:64ch; }
  .tag { display:inline-flex; align-items:center; font:10px/1 var(--mono); padding:5px 7px; border-radius:3px; border:1px solid; white-space:nowrap; color:var(--red); border-color:#e3c4b8; background:#f7ebe5; }
  .tag[hidden] { display:none; }
  .layout { display:grid; grid-template-columns:minmax(0,1fr) 330px; gap:28px; align-items:start; padding-bottom:56px; }
  .layout.one { grid-template-columns:minmax(0,1fr); max-width:860px; }
  .shell { border:1px solid var(--line-dark); background:var(--panel); border-radius:8px; overflow:hidden; box-shadow:0 10px 32px -22px #30281940; }
  .player-top { height:36px; display:flex; align-items:center; gap:14px; padding:0 15px; font:10px var(--mono); color:#808176; border-bottom:1px solid var(--line); }
  .player-dots { display:flex; gap:4px; } .player-dots i { width:6px; height:6px; border:1px solid #d9d8ce; border-radius:50%; background:#eeede6; }
  .player-top .right { margin-left:auto; color:var(--muted); }
  video { display:block; width:100%; aspect-ratio:16/9; background:#eeeade; }
  .caption { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:12px 20px; padding:16px 18px; border-top:1px solid var(--line); }
  .caption h2 { margin:0; font-size:19px; font-weight:550; letter-spacing:-.4px; line-height:1.3; text-wrap:balance; overflow-wrap:anywhere; }
  .caption .who { margin:4px 0 0; font-size:12px; color:var(--muted); display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .next { display:inline-flex; align-items:center; gap:14px; padding:12px 16px; min-height:44px; border:0; border-radius:6px; background:var(--ink); color:var(--panel); font-size:13px; font-weight:600; text-align:left; }
  .next:hover { background:#45463d; } .next[hidden] { display:none; } .next .arrow { font-family:var(--mono); }
  .notes { border-top:1px solid var(--line); padding:18px; display:grid; gap:14px; background:#f8f8f2; }
  .label { font:10px var(--mono); color:var(--accent-ink); margin:0; letter-spacing:.02em; }
  .note { margin:0; font-size:14px; line-height:1.7; max-width:68ch; white-space:pre-line; } .note:empty { display:none; }
  .scenes { list-style:none; margin:0; padding:0; display:grid; gap:2px; counter-reset:s; }
  .scenes li { counter-increment:s; display:grid; grid-template-columns:26px 1fr; font-size:13px; color:#53574b; line-height:1.6; }
  .scenes li::before { content:counter(s, decimal-leading-zero); font:10px/2.1 var(--mono); color:var(--muted); }
  .scenes li.fail { color:var(--red); } .scenes small { grid-column:2; color:var(--muted); font-size:12px; }
  .takes { border:1px solid var(--line-dark); background:var(--panel); border-radius:8px; overflow:hidden; }
  .takes-head { display:flex; justify-content:space-between; padding:12px 16px; border-bottom:1px solid var(--line); background:#f6f5ef; font:10px var(--mono); color:var(--muted); }
  .takes ol { list-style:none; margin:0; padding:0; } .takes li + li { border-top:1px solid var(--line); }
  .takes a { display:grid; grid-template-columns:26px 1fr; gap:4px 6px; padding:12px 16px; position:relative; color:var(--muted); }
  .takes a:hover { background:#f7f5ee; }
  .takes a[aria-current="true"] { background:var(--tint); color:var(--ink); }
  .takes a[aria-current="true"]::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--accent); }
  .takes .n { font:10px/1.9 var(--mono); color:#969480; } .takes a[aria-current="true"] .n { color:var(--accent-ink); }
  .takes strong { display:block; font-size:13px; font-weight:550; color:var(--ink); line-height:1.4; overflow-wrap:anywhere; }
  .takes .sub { grid-column:2; display:flex; flex-wrap:wrap; gap:6px 8px; align-items:center; font-size:11px; }
  footer { border-top:1px solid var(--line); padding:22px 0 30px; display:flex; flex-wrap:wrap; gap:10px 24px; align-items:center; font-size:11px; color:var(--muted); }
  footer .brand { font-size:15px; letter-spacing:-.4px; color:var(--ink); } footer .brand svg { width:20px; height:20px; }
  footer a.site { margin-left:auto; font-family:var(--mono); } footer a.site:hover { color:var(--accent-ink); }
  .comments { border-top:1px solid var(--line); padding:18px; display:grid; gap:12px; }
  .comments[hidden], .comments ol:empty { display:none; }
  .comments ol { list-style:none; margin:0; padding:0; display:grid; gap:10px; }
  .comments li { font-size:13px; line-height:1.6; display:grid; gap:2px; }
  .comments .at { font:10px/1.6 var(--mono); color:var(--accent-ink); background:none; border:0; padding:0; justify-self:start; }
  .comments .at:hover { text-decoration:underline; }
  .comments .meta { font-size:11px; color:var(--muted); }
  .comments .body { white-space:pre-line; overflow-wrap:anywhere; }
  .comments form { display:grid; gap:8px; }
  .comments textarea, .comments input { font:inherit; font-size:14px; color:var(--ink); background:var(--panel); border:1px solid var(--line-dark); border-radius:6px; padding:9px 11px; width:100%; }
  .comments textarea { min-height:72px; resize:vertical; }
  .comments .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
  .comments .row input { flex:1 1 160px; width:auto; }
  .comments button.send { padding:10px 14px; min-height:42px; border:1px solid var(--ink); border-radius:6px; background:var(--panel); color:var(--ink); font-size:13px; font-weight:600; }
  .comments .status { font-size:12px; color:var(--muted); margin:0; min-height:1em; }
  @media (max-width:900px) { .layout { grid-template-columns:minmax(0,1fr); } }
  @media (max-width:480px) { .bar-note { display:none; } .next { width:100%; justify-content:space-between; } footer a.site { margin-left:0; } }
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><symbol id="mark" viewBox="0 0 64 64">${MARK}</symbol></svg>
<header class="wrap bar">
  <a class="brand" href="https://www.useretake.app"><svg aria-hidden="true"><use href="#mark"/></svg>retake</a>
  ${o.by ? `<span class="bar-note">Shared with you by ${esc(o.by)}</span>` : ""}
</header>
<main class="wrap">
  <section class="intro">
    <p class="eyebrow">${esc(when)}</p>
    <h1>${esc(o.title)}</h1>
    <p class="lede" id="lede"></p>
  </section>
  <div class="layout${one ? " one" : ""}">
    <section class="shell" aria-live="polite">
      <div class="player-top"><span class="player-dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="file"></span><span class="right" id="pos"></span></div>
      <video id="player" controls preload="metadata" playsinline></video>
      <div class="caption">
        <div><h2 id="title"></h2><p class="who"><span id="len"></span><span id="state" class="tag" hidden>A step failed</span></p></div>
        <button type="button" class="next" id="next" hidden><span id="next-text"></span><span class="arrow" aria-hidden="true">→</span></button>
      </div>
      <div class="notes">
        <p class="note" id="note"></p>
        <p class="label scenes-label">What happens</p>
        <ol class="scenes" id="scenes"></ol>
      </div>
      <div class="comments" id="comments" hidden>
        <p class="label">Comments</p>
        <ol id="comment-list"></ol>
        <form id="comment-form">
          <label class="label" for="comment-text" id="comment-label">Leave a comment</label>
          <textarea id="comment-text" maxlength="2000" required></textarea>
          <div class="row"><input id="comment-by" maxlength="80" autocomplete="name" placeholder="Your name (optional)" aria-label="Your name (optional)"><button type="submit" class="send" id="comment-send">Comment</button></div>
          <p class="status" id="comment-status" role="status" aria-live="polite"></p>
        </form>
      </div>
    </section>
    ${one ? "" : `<nav class="takes" aria-label="All recordings"><div class="takes-head"><span>Takes</span><span id="total"></span></div><ol id="all"></ol></nav>`}
  </div>
</main>
<footer class="wrap">
  <span class="brand"><svg aria-hidden="true"><use href="#mark"/></svg>retake</span>
  <span>Every take is a real browser run, recorded from a script.</span>
  <a class="site" href="https://www.useretake.app">useretake.app</a>
</footer>
<script>
const V = ${data};
const $ = (id) => document.getElementById(id);
const pad = (i) => String(i + 1).padStart(2, "0");
const len = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const total = V.reduce((n, v) => n + v.seconds, 0);
const failed = V.filter((v) => v.failed).length;
$("lede").textContent = V.length === 1
  ? len(V[0].seconds) + (V[0].failed ? " · a step failed in this take; it is marked below." : "")
  : V.length + " takes, " + len(total) + " in all. Play them in order with Next, or pick any take from the list." + (failed ? " " + failed + " of them had a step fail; each is marked." : "");
if ($("all")) {
  $("total").textContent = V.length + " · " + len(total);
  V.forEach((v, i) => {
    const a = el("a"); a.href = "#" + v.id; a.dataset.i = i;
    a.append(el("span", "n", pad(i)), el("strong", null, v.title));
    const sub = el("span", "sub", len(v.seconds));
    if (v.failed) sub.append(el("span", "tag", "A step failed"));
    a.append(sub);
    const li = el("li"); li.append(a); $("all").append(li);
  });
}
const player = $("player");
function show(i, play) {
  const v = V[i];
  if (player.dataset.id !== v.id) { player.poster = v.cover ? "v/" + v.id + ".png" : ""; player.src = "v/" + v.id + ".mp4"; player.dataset.id = v.id; }
  $("file").textContent = v.id + ".mp4";
  $("pos").textContent = V.length > 1 ? pad(i) + " / " + V.length : "";
  $("title").textContent = v.title;
  $("len").textContent = len(v.seconds);
  $("state").hidden = !v.failed;
  $("note").textContent = v.notes || "";
  $("scenes").replaceChildren(...v.scenes.map((s) => { const li = el("li", s.failed ? "fail" : null, s.failed ? s.text + " (a step failed here)" : s.text); if (s.note) li.append(el("small", null, s.note)); return li; }));
  $("scenes").previousElementSibling.hidden = !v.scenes.length;
  const next = $("next");
  if (i + 1 < V.length) { next.hidden = false; $("next-text").textContent = "Next: " + V[i + 1].title; next.dataset.i = i + 1; } else next.hidden = true;
  document.querySelectorAll("#all a").forEach((a) => a.setAttribute("aria-current", String(+a.dataset.i === i)));
  if (play) player.play().catch(() => {});
  if (typeof drawComments === "function" && C) drawComments();
}
function go(i) {
  history.replaceState(null, "", "#" + V[i].id);
  show(i, true);
  const shell = player.closest(".shell"), top = shell.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight * 0.5) shell.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
const fromHash = () => Math.max(0, V.findIndex((v) => v.id === decodeURIComponent(location.hash.slice(1))));
$("next").addEventListener("click", (e) => go(+e.currentTarget.dataset.i));
if ($("all")) $("all").addEventListener("click", (e) => { const a = e.target.closest("a"); if (!a) return; e.preventDefault(); go(+a.dataset.i); });
player.addEventListener("ended", () => { if (!$("next").hidden) $("next").focus(); });
// Comments come from the server that serves this page; opened as a plain
// file there is none, and the section stays hidden.
let C = [];
const mmss = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
function drawComments() {
  const v = V[current()];
  $("comment-list").replaceChildren(...C.filter((c) => c.take === v.id).sort((a, b) => a.at - b.at).map((c) => {
    const li = el("li"), at = el("button", "at", mmss(c.at)); at.type = "button";
    at.addEventListener("click", () => { player.currentTime = c.at; player.play().catch(() => {}); });
    li.append(at, el("span", "body", c.text), el("span", "meta", (c.by ? c.by + " · " : "") + new Date(c.when).toLocaleDateString()));
    return li;
  }));
}
const current = () => Math.max(0, V.findIndex((v) => v.id === player.dataset.id));
const stamp = () => { $("comment-label").textContent = "Leave a comment at " + mmss(player.currentTime || 0); };
player.addEventListener("timeupdate", stamp); player.addEventListener("seeked", stamp); player.addEventListener("loadedmetadata", stamp);
fetch("comments", { cache: "no-store" }).then((r) => r.ok ? r.json() : Promise.reject()).then((all) => { C = all; $("comments").hidden = false; drawComments(); }).catch(() => {});
$("comment-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("comment-text").value.trim();
  if (!text) return;
  $("comment-send").disabled = true; $("comment-status").textContent = "Sending…";
  try {
    const r = await fetch("comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ take: V[current()].id, at: player.currentTime || 0, text, by: $("comment-by").value }) });
    const c = await r.json();
    if (!r.ok) throw new Error(c.error || "could not send");
    C.push(c); $("comment-text").value = ""; $("comment-status").textContent = "Sent."; drawComments();
  } catch (err) { $("comment-status").textContent = "Not sent: " + err.message; }
  $("comment-send").disabled = false;
});
addEventListener("hashchange", () => show(fromHash(), false));
show(fromHash(), false);
</script>
</body>
</html>
`;
}
