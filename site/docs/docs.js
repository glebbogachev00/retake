/* Progressive enhancement only. The entire guide and navigation live in HTML. */
(() => {
  'use strict';
  const search = document.querySelector('.docs-search');
  const input = document.querySelector('#docs-query');
  const results = document.querySelector('#search-results');
  const status = document.querySelector('#search-status');
  const feedback = document.querySelector('#copy-feedback');
  const sections = Array.from(document.querySelectorAll('[data-doc-section]')).map(section => ({
    id: section.id,
    title: section.querySelector('h1, h2').textContent.replace(/\s+/g, ' ').trim(),
    text: section.textContent.replace(/\s+/g, ' ').toLowerCase(),
  }));
  let feedbackTimer;
  function resetSearch() {
    input.value = '';
    results.replaceChildren();
    results.hidden = true;
    status.textContent = '';
    input.focus();
  }
  function searchDocs() {
    const query = input.value.trim().toLowerCase();
    results.replaceChildren();
    if (!query) { results.hidden = true; status.textContent = ''; return; }
    const words = query.split(/\s+/);
    const matches = sections.filter(section => words.every(word => section.text.includes(word)));
    matches.sort((a, b) => Number(b.title.toLowerCase().includes(query)) - Number(a.title.toLowerCase().includes(query)));
    for (const match of matches) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = '#' + match.id;
      link.textContent = match.title;
      item.append(link);
      results.append(item);
    }
    results.hidden = matches.length === 0;
    status.textContent = matches.length ? `${matches.length} matching ${matches.length === 1 ? 'section' : 'sections'}.` : 'No matching sections. Try “setup”, “voice” or “login”.';
  }
  search.hidden = false;
  input.addEventListener('input', searchDocs);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); resetSearch(); }
    if (event.key === 'ArrowDown') { const first = results.querySelector('a'); if (first) { event.preventDefault(); first.focus(); } }
  });
  results.addEventListener('keydown', event => {
    const links = Array.from(results.querySelectorAll('a'));
    const index = links.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); resetSearch(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = index + (event.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) input.focus();
      else links[Math.min(next, links.length - 1)]?.focus();
    }
  });
  results.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    const target = document.getElementById(link.hash.slice(1));
    if (target) { target.setAttribute('tabindex', '-1'); target.focus({ preventScroll: true }); }
  });
  document.addEventListener('keydown', event => {
    const target = event.target;
    const editing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !editing && !event.metaKey && !event.ctrlKey && !event.altKey)) {
      event.preventDefault();
      input.focus();
    }
  });
  document.querySelectorAll('.docs-code').forEach(block => {
    const code = block.querySelector('code');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'docs-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', 'Copy ' + block.querySelector('.docs-code-head span').textContent);
    block.querySelector('.docs-code-head').append(button);
    button.addEventListener('click', async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = 'Copied';
        feedback.textContent = 'Copied to clipboard.';
      } catch {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(code);
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = 'Select & copy';
        feedback.textContent = 'Clipboard unavailable. Text selected: use your browser’s Copy command.';
      }
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => { feedback.textContent = ''; }, 5000);
      setTimeout(() => { button.textContent = 'Copy'; }, 3000);
    });
  });
  function markCurrent() {
    document.querySelectorAll('.docs-navigation a').forEach(link => {
      if (link.hash === window.location.hash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  window.addEventListener('hashchange', markCurrent);
  markCurrent();
})();
