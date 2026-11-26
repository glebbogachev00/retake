/* The header's two controls, the same on both areas of the window.

   The theme button: System → Light → Dark, remembered in localStorage for
   Watch and Demos alike. Each page applies the saved choice in <head>
   before it paints; this only draws the button and changes it.

   The project switcher: the project Watch shows, picked from a list. With
   one project it is just its name. The window remembers the last one. */
(function () {
  const KEY = 'retake-theme', NAMES = { system: 'System', light: 'Light', dark: 'Dark' };
  const ICON = {
    system: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg>',
    light: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    dark: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.75 5.75 0 0 1 6.4 2.5a5.75 5.75 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  };
  const theme = document.getElementById('theme');
  if (theme) {
    const get = () => { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'system'; } catch (e) { return 'system'; } };
    const apply = m => {
      if (m === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = m;
      theme.innerHTML = ICON[m]; theme.title = 'Theme: ' + NAMES[m]; theme.setAttribute('aria-label', 'Theme: ' + NAMES[m]);
    };
    theme.onclick = () => {
      const m = { system: 'light', light: 'dark', dark: 'system' }[get()];
      try { if (m === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, m); } catch (e) {}
      apply(m);
    };
    addEventListener('storage', e => { if (e.key === KEY) apply(get()); });
    apply(get());
  }
})();

/** The project Watch shows: the one last opened, kept for both areas. */
window.retakeProject = {
  get() { try { return localStorage.getItem('retake-project'); } catch (e) { return null; } },
  set(id) { try { if (id) localStorage.setItem('retake-project', id); } catch (e) {} },
  /** Draw the switcher from the projects Watch knows. `pick` is what choosing one does. */
  draw(projects, current, pick) {
    const el = document.getElementById('proj');
    if (!el) return;
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const cur = projects.find(p => p.id === current) || projects[0];
    if (!cur) { el.innerHTML = ''; return; }
    const one = projects.length < 2;
    document.body.classList.toggle('one-project', one);
    el.innerHTML = one
      ? `<span class="rt-proj">${esc(cur.name)}</span>`
      : `<button class="rt-proj" id="projBtn" type="button" aria-haspopup="true" aria-expanded="false">${esc(cur.name)}<span class="rt-caret" aria-hidden="true">▾</span></button>`
        + `<div class="rt-menu" id="projMenu" role="menu" hidden>${projects.map(p => `<button type="button" role="menuitem" data-p="${esc(p.id)}"${p.id === cur.id ? ' aria-current="true"' : ''}><i class="rt-dot${p.loud ? ' loud' : ''}" aria-hidden="true"></i>${esc(p.name)}${p.loud ? '<span class="rt-sr"> — needs a look</span>' : ''}</button>`).join('')}<a role="menuitem" href="/watch/add">Add an app…</a></div>`;
    if (one) return;
    const btn = document.getElementById('projBtn'), menu = document.getElementById('projMenu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden)); };
    menu.onclick = e => { const b = e.target.closest('[data-p]'); if (!b) return; close(); window.retakeProject.set(b.dataset.p); pick(b.dataset.p); };
    document.addEventListener('click', e => { if (!el.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  },
};
