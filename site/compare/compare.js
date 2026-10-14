(() => {
  'use strict';
  const variants = {
    a: { path: '/', title: 'Retake Version A: split layout, the homepage' },
    b: { path: '/layout-b/', title: 'Retake Version B: centered layout' }
  };
  const tabs = [...document.querySelectorAll('[data-variant]')];
  const widths = [...document.querySelectorAll('[data-width]')];
  const frame = document.getElementById('variant-frame');
  const panel = document.getElementById('layout-preview');
  const open = document.getElementById('open-variant');
  const params = new URLSearchParams(location.search);
  let current = params.get('variant') === 'b' ? 'b' : 'a';
  let width = ['768', '390'].includes(params.get('width')) ? params.get('width') : 'fit';

  function updateUrl() {
    const query = new URLSearchParams({ variant: current });
    if (width !== 'fit') query.set('width', width);
    history.replaceState(null, '', location.pathname + '?' + query);
  }
  function chooseVariant(key, forceReload = false) {
    current = key;
    tabs.forEach(tab => {
      const selected = tab.dataset.variant === key;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    if (forceReload || frame.getAttribute('src') !== variants[key].path) frame.src = variants[key].path;
    frame.title = variants[key].title;
    open.href = variants[key].path;
    panel.setAttribute('aria-labelledby', 'variant-' + key);
    updateUrl();
  }
  function chooseWidth(value) {
    width = value;
    panel.style.setProperty('--preview-width', value === 'fit' ? '100%' : value + 'px');
    widths.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.width === value)));
    updateUrl();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => chooseVariant(tab.dataset.variant, true));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next !== undefined) { event.preventDefault(); tabs[next].focus(); tabs[next].click(); }
    });
  });
  widths.forEach(button => button.addEventListener('click', () => chooseWidth(button.dataset.width)));
  chooseVariant(current);
  chooseWidth(width);
})();
