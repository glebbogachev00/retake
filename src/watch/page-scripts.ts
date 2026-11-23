/**
 * What Watch mode puts into the page under test: a mask over the regions a
 * viewer must never see, and a cursor a person can follow.
 *
 * Both are drawn by the page itself, so they are in everything that is a
 * picture of the page — the live stream, every screenshot and the video —
 * with no second pass that could miss a frame. Both are installed with
 * `context.addInitScript`, so they survive navigations and are there before
 * the page's first paint.
 *
 * A page whose Content-Security-Policy forbids inline styles would silently
 * drop a <style> element — a mask meant to hide a password would show it.
 * So styles go in through a constructed stylesheet (not subject to
 * style-src) and element properties set from script, never markup.
 */

/** Installs the mask machinery once per document, then applies `ops` in
    order. Each call to mask()/unmask() adds one more init script carrying
    just its own op, so the order of calls is the order on every page. */
export function maskScript(ops: { add?: string[]; remove?: string[] }): string {
  return `(() => {
  const W = window;
  if (!W.__retakeMask) {
    const sels = [];
    let sheet = null;
    const restyle = () => {
      try {
        if (!sheet) { sheet = new CSSStyleSheet(); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; }
        // One rule at a time: a selector this engine rejects must not take the others with it.
        while (sheet.cssRules.length) sheet.deleteRule(0);
        for (const s of sels) { try { sheet.insertRule(s + "{filter:blur(16px) grayscale(1)!important}", sheet.cssRules.length); } catch {} }
      } catch {}
    };
    let layer = null;
    const boxes = [];
    const set = (el, o) => { for (const k in o) el.style.setProperty(k, o[k], "important"); };
    const ensureLayer = () => {
      if (layer && layer.isConnected) return layer;
      const root = document.body || document.documentElement;
      if (!root) return null;
      layer = document.createElement("div");
      layer.setAttribute("data-retake", "mask");
      set(layer, { position: "fixed", left: "0", top: "0", width: "0", height: "0", overflow: "visible", "pointer-events": "none", "z-index": "2147483646" });
      boxes.length = 0;
      root.appendChild(layer);
      return layer;
    };
    const draw = () => {
      const L = sels.length ? ensureLayer() : layer;
      if (L) {
        const rects = [];
        for (const s of sels) {
          let found;
          try { found = document.querySelectorAll(s); } catch { continue; }
          for (const el of found) {
            if (L.contains(el)) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            rects.push(r);
          }
        }
        while (boxes.length < rects.length) {
          const b = document.createElement("div");
          set(b, { position: "fixed", background: "#111", "border-radius": "4px", "pointer-events": "none" });
          L.appendChild(b);
          boxes.push(b);
        }
        boxes.forEach((b, i) => {
          const r = rects[i];
          if (!r) { b.style.setProperty("display", "none", "important"); return; }
          set(b, { display: "block", left: (r.left - 4) + "px", top: (r.top - 4) + "px", width: (r.width + 8) + "px", height: (r.height + 8) + "px" });
        });
      }
      requestAnimationFrame(draw);
    };
    W.__retakeMask = {
      add(s) { if (!sels.includes(s)) { sels.push(s); restyle(); } },
      remove(s) { const i = sels.indexOf(s); if (i >= 0) { sels.splice(i, 1); restyle(); } },
      list() { return [...sels]; },
    };
    restyle();
    requestAnimationFrame(draw);
  }
  for (const s of ${JSON.stringify(ops.add ?? [])}) W.__retakeMask.add(s);
  for (const s of ${JSON.stringify(ops.remove ?? [])}) W.__retakeMask.remove(s);
})();`;
}

/** A soft dot that glides to wherever the mouse goes, and rings on a press.
    Playwright moves the mouse instantly; the glide is what lets a person
    see where it went. Never in the way: no pointer events. Top frame only. */
export const CURSOR_SCRIPT = `(() => {
  if (window.top !== window || window.__retakeCursor) return;
  window.__retakeCursor = true;
  const set = (el, o) => { for (const k in o) el.style.setProperty(k, o[k], "important"); };
  let dot = null;
  const ensure = () => {
    if (dot && dot.isConnected) return dot;
    const root = document.body || document.documentElement;
    if (!root) return null;
    dot = document.createElement("div");
    dot.setAttribute("data-retake", "cursor");
    set(dot, { position: "fixed", left: "0", top: "0", width: "18px", height: "18px", margin: "-9px 0 0 -9px", "border-radius": "50%", background: "rgba(20,20,20,.55)", border: "2px solid rgba(255,255,255,.9)", "box-sizing": "border-box", "pointer-events": "none", "z-index": "2147483647", transition: "transform .32s cubic-bezier(.3,.7,.2,1), opacity .2s", opacity: "0" });
    root.appendChild(dot);
    return dot;
  };
  const move = (e) => { const d = ensure(); if (!d) return; set(d, { transform: "translate(" + e.clientX + "px," + e.clientY + "px)", opacity: "1" }); };
  const press = (e) => {
    move(e);
    const root = document.body || document.documentElement;
    if (!root) return;
    const ring = document.createElement("div");
    ring.setAttribute("data-retake", "cursor");
    set(ring, { position: "fixed", left: e.clientX + "px", top: e.clientY + "px", width: "36px", height: "36px", margin: "-18px 0 0 -18px", "border-radius": "50%", border: "2px solid rgba(20,20,20,.6)", "box-sizing": "border-box", "pointer-events": "none", "z-index": "2147483647", transition: "transform .45s ease-out, opacity .45s ease-out", transform: "scale(.4)", opacity: "1" });
    root.appendChild(ring);
    requestAnimationFrame(() => set(ring, { transform: "scale(1.2)", opacity: "0" }));
    setTimeout(() => ring.remove(), 600);
  };
  addEventListener("mousemove", move, { capture: true, passive: true });
  addEventListener("mousedown", press, { capture: true, passive: true });
})();`;
