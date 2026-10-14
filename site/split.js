/* Split layout (A): the session card, the logo, and the page arriving.
   The session is an illustration of what an agent does with Retake — brief,
   scout, dry run, record, render, a take to review — cycling through the
   three real examples below. It pauses when hovered, scrolled away or the
   tab is hidden, and stands still entirely under reduced motion. */
(() => {
  'use strict';
  const root = document.documentElement;
  root.classList.add('split-js');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- the logo: takes arrive; hovering replays a take ----------
  const replay = (svg) => {
    svg.classList.toggle('replay');
  };
  for (const brand of document.querySelectorAll('.brand')) {
    const svg = brand.querySelector('.mark');
    if (svg) brand.addEventListener('mouseenter', () => replay(svg));
  }

  // ---------- the session card ----------
  const session = document.querySelector('.session');
  const TAKES = {
    product: { brief: 'Show what Capture does: turn a mixed thought into structure, and share it with an agent.', file: 'capture-product-overview.mp4', seconds: 57, length: '57 sec · ready to review', render: 'with voiceover', thumb: '/media/capture-x-2102280223316471854-v1.jpg', label: 'Watch the Capture product overview' },
    teaching: { brief: 'Walk through the Scratch code behind Cheesy Puffs, sprite by sprite.', file: 'techtutor-cheesy-puffs.mp4', seconds: 31, length: '31 sec · ready to review', render: '1920 × 1080', thumb: '/media/techtutor-cheesy-puffs-fb-v1.jpg', label: 'Watch the TechTutor Cheesy Puffs walkthrough' },
    content: { brief: 'Record the real Capture workflow, so people see more than a to-do list.', file: 'capture-content-for-x.mp4', seconds: 27, length: '27 sec · ready to review', render: 'for X', thumb: '/media/capture-personal-x-2099791282986258613-v1.jpg', label: 'Watch the Capture clip made for X' },
  };
  const ORDER = ['product', 'teaching', 'content'];

  if (session) {
    const $ = (id) => document.getElementById(id);
    const briefEl = $('session-brief');
    const timerEl = $('session-timer');
    const steps = [...session.querySelectorAll('.session-steps li')];
    const buttons = [...session.querySelectorAll('.session-takes button')];
    let current = 'product';
    let run = 0;          // bumps on every restart, so an old sequence stops itself
    let paused = false;
    let visible = true;

    const wait = (ms, id) => new Promise((resolve) => {
      const tick = () => {
        if (id !== run) return resolve(false);
        if (paused || !visible || document.hidden) return setTimeout(tick, 120);
        setTimeout(() => resolve(id === run), ms);
      };
      tick();
    });
    const setPhase = (phase) => {
      session.dataset.phase = phase;
      const at = ['scout', 'dry', 'rec', 'render'].indexOf(phase);
      steps.forEach((li, i) => {
        li.classList.toggle('done', phase === 'done' || (at > -1 && i < at));
        li.classList.toggle('on', i === at);
      });
    };
    const mmss = (s) => `00:${String(Math.floor(s)).padStart(2, '0')}`;
    const select = (key) => {
      current = key;
      const t = TAKES[key];
      buttons.forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.take === key)); b.style.setProperty('--p', 0); });
      $('session-thumb').src = t.thumb;
      $('session-file').textContent = t.file;
      $('session-length').textContent = t.length;
      $('session-render').textContent = t.render;
      $('session-result').setAttribute('aria-label', t.label);
    };
    const progress = (p) => buttons.find((b) => b.dataset.take === current)?.style.setProperty('--p', p);

    const play = async (key) => {
      const id = ++run;
      select(key);
      const t = TAKES[key];
      if (still) { briefEl.textContent = t.brief; timerEl.textContent = mmss(t.seconds); setPhase('done'); progress(1); return; }
      // Type the brief.
      setPhase('type');
      timerEl.textContent = '00:00';
      briefEl.textContent = '';
      for (let i = 1; i <= t.brief.length; i++) {
        briefEl.textContent = t.brief.slice(0, i);
        progress(0.25 * i / t.brief.length);
        if (!(await wait(i === t.brief.length ? 380 : 18 + Math.random() * 26, id))) return;
      }
      // Scout, dry run.
      setPhase('scout'); progress(.32); if (!(await wait(750, id))) return;
      setPhase('dry'); progress(.42); if (!(await wait(850, id))) return;
      // Record: the timer runs the take's length, sped up.
      setPhase('rec');
      const frames = 30;
      for (let f = 1; f <= frames; f++) {
        timerEl.textContent = mmss(t.seconds * f / frames);
        progress(.42 + .38 * f / frames);
        if (!(await wait(2400 / frames, id))) return;
      }
      setPhase('render'); progress(.88); if (!(await wait(900, id))) return;
      setPhase('done'); progress(1);
      if (!(await wait(5200, id))) return;
      play(ORDER[(ORDER.indexOf(key) + 1) % ORDER.length]);
    };

    buttons.forEach((b) => b.addEventListener('click', () => play(b.dataset.take)));
    session.addEventListener('mouseenter', () => { paused = true; });
    session.addEventListener('mouseleave', () => { paused = false; });
    session.addEventListener('focusin', () => { paused = true; });
    session.addEventListener('focusout', () => { paused = false; });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => { visible = e.isIntersecting; }, { threshold: .2 }).observe(session);
    }

    // The take it made: open it in the player below and play it.
    $('session-result').addEventListener('click', () => {
      const tab = document.querySelector(`[data-example="${current}"]`);
      if (tab && tab.getAttribute('aria-selected') !== 'true') tab.click();
      const target = document.getElementById('examples');
      target?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
      const video = document.getElementById('example-video');
      if (video) setTimeout(() => { video.play().catch(() => {}); }, still ? 0 : 450);
    });

    play('product');
  }

  // ---------- the page arriving as you scroll ----------
  if (!still && 'IntersectionObserver' in window) {
    const targets = document.querySelectorAll('.split-layout .section-heading, .split-layout .example-shell, .split-layout .proof-strip, .split-layout .workflow-grid, .split-layout .feature-row article, .split-layout .connect-layout, .split-layout .faq-layout, .split-layout .closing');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        if (e.target.classList.contains('closing')) {
          const svg = e.target.querySelector('.mark');
          if (svg) replay(svg);
        }
        io.unobserve(e.target);
      }
    }, { threshold: .12, rootMargin: '0px 0px -40px 0px' });
    targets.forEach((el, i) => {
      el.classList.add('reveal');
      if (el.matches('.feature-row article')) el.style.transitionDelay = `${(i % 3) * 90}ms`;
      io.observe(el);
    });
  }

  // ---------- surfaces that answer the pointer ----------
  const glow = document.querySelectorAll('.split-layout .feature-row article, .split-layout .workflow-steps button, .split-layout .faq-list details');
  for (const el of glow) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
    el.addEventListener('pointerleave', () => { el.style.removeProperty('--mx'); el.style.removeProperty('--my'); });
  }
})();
