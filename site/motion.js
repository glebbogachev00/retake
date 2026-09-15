(() => {
  const root = document.documentElement;
  const heading = document.querySelector('.hero h1');
  const blocks = [...document.querySelectorAll(
    '.steps li, section[aria-labelledby="library-title"], .demo > h2, .demo > .section-copy, section[aria-labelledby="cases-title"] > h2, section[aria-labelledby="cases-title"] > .section-copy, .case, .maker, .start'
  )];
  blocks.forEach(block => block.setAttribute('data-motion', ''));
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let observer;
  let split = false;

  function configure() {
    observer?.disconnect();
    root.removeAttribute('data-motion-mode');
    heading?.classList.remove('hero-arrive');
    blocks.forEach(block => block.classList.remove('motion-enter'));
    if (preference.matches || !('IntersectionObserver' in window)) return;

    // Keep the original text nodes' whitespace, <br> and <em> exactly in place.
    if (heading && !split) {
      const walker = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      let index = 0;
      nodes.forEach(node => {
        const fragment = document.createDocumentFragment();
        node.textContent.split(/(\s+)/).forEach(part => {
          if (!part || /^\s+$/.test(part)) fragment.append(part);
          else {
            const word = document.createElement('span');
            word.className = 'motion-word';
            word.style.setProperty('--word', index++);
            word.textContent = part;
            fragment.append(word);
          }
        });
        node.replaceWith(fragment);
      });
      split = true;
    }
    const native = CSS.supports('animation-timeline: view()');
    root.dataset.motionMode = native ? 'native' : 'fallback';
    // Only intersection boundaries trigger JS; native timelines own all scroll
    // progress. Finite fallback entrances replay after leaving either edge.
    observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        entry.target.classList.toggle(entry.target === heading ? 'hero-arrive' : 'motion-enter', entry.isIntersecting);
      });
    }, { threshold:0 });
    if (heading) observer.observe(heading);
    if (!native) blocks.forEach(block => observer.observe(block));
  }
  preference.addEventListener('change', configure);
  configure();
})();
