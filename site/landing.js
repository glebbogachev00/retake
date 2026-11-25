(() => {
  'use strict';
  const examples = {
  "product": {
    "request": "“Show what Capture does: turn a mixed thought into structure, ask about saved thoughts, and share context with an agent.”",
    "description": "A full product overview, with the original voiceover.",
    "src": "/media/capture-x-2102280223316471854-v1.mp4",
    "poster": "/media/capture-x-2102280223316471854-v1.jpg",
    "file": "capture-product-overview.mp4",
    "title": "Capture",
    "category": "Product video",
    "duration": "57 sec · With voiceover",
    "label": "Capture product overview with its original voiceover",
    "note": "The full Capture video published on X, with its original voiceover. The example brief is illustrative.",
    "sourceUrl": "https://x.com/trycapturez/status/2102280223316471854",
    "sourceLabel": "View on X ↗"
  },
  "teaching": {
    "request": "“Walk through the Scratch code behind the Cheesy Puffs animation, and show how the project works.”",
    "description": "A real TechTutor student-project walkthrough, as published on Facebook.",
    "src": "/media/techtutor-cheesy-puffs-fb-v1.mp4",
    "poster": "/media/techtutor-cheesy-puffs-fb-v1.jpg",
    "file": "techtutor-cheesy-puffs.mp4",
    "title": "TechTutor",
    "category": "Educational walkthrough",
    "duration": "31 sec · Published recording",
    "label": "TechTutor Cheesy Puffs Scratch code walkthrough",
    "note": "The selected Cheesy Puffs code walkthrough from TechTutor’s Facebook page. The example brief is illustrative.",
    "sourceUrl": "https://www.facebook.com/reel/1670144871497010",
    "sourceLabel": "View on Facebook ↗"
  },
  "content": {
    "request": "“Record the real Capture workflow so people can see what happens beyond a to-do list.”",
    "description": "Content made from a real product workflow.",
    "src": "/media/capture-personal-x-2099791282986258613-v1.mp4",
    "poster": "/media/capture-personal-x-2099791282986258613-v1.jpg",
    "file": "capture-content-for-x.mp4",
    "title": "Capture",
    "category": "Content for X",
    "duration": "27 sec · Published recording",
    "label": "Capture product demo published on Gleb’s personal X account",
    "note": "The exact product demo shared on Gleb’s personal X account, with its original audio. The example brief is illustrative.",
    "sourceUrl": "https://x.com/Peaceful_HN/status/2099791282986258613",
    "sourceLabel": "View on X ↗"
  }
};
  const setup = {
    prompt: { label: 'Paste this into your coding agent', code: 'Set up Retake from https://github.com/glebbogachev00/retake in this project and open its local UI. Use the first-run questions to collect the app URL and workflow. Dry-run the flow, record a silent preview, and show me the video and local review link. Wait for my review before making corrections or adding narration. Keep secrets out of chat. Do not commit or deploy anything.', hint: 'The first preview is a starting point. Watch it and tell your agent what to change.' },
    cli: { label: 'Run inside your app project · Node.js 20+', code: 'npm install -g retake-demos\nretake install\nretake ui', hint: 'Setup downloads Chromium and registers Claude Code tools when available. Open localhost:4310 to review. Restart your agent to load newly added tools.' },
    mcp: { label: 'Use the local MCP server', code: '# After installing retake-demos:\nretake install\n\n# Print configuration for your agent:\nretake agent', hint: 'Claude Code can register automatically. For Codex or Cursor, use the configuration printed by retake agent, then restart the client. This is a local tool server, not a hosted API.' }
  };
  const workflow = {
    record: { title: 'Start with something worth showing.', copy: 'Your agent turns the brief into a reusable flow, checks the steps with a dry run, and records the real browser.', href: '/docs/#record-review-rerun', link: 'Read the recording guide' },
    review: { title: 'The take is yours to judge.', copy: 'Open the local library to watch the video and inspect its scene stills. Tell your agent what to shorten, reframe, or do differently.', href: '#connect', link: 'Set up the local review window' },
    rerun: { title: 'A new take, from the same flow.', copy: 'When the app changes, ask your agent to update the steps and record again. This paired example keeps the browser steps unchanged and revises the captions.', href: '/rerun-proof', link: 'Watch the first run and rerun' }
  };
  if (document.body.classList.contains('centered-layout')) {
    const compactWorkflow = window.matchMedia('(max-width: 760px)');
    const syncWorkflowOrientation = () => document.querySelector('.workflow-steps').setAttribute('aria-orientation', compactWorkflow.matches ? 'horizontal' : 'vertical');
    compactWorkflow.addEventListener('change', syncWorkflowOrientation);
    syncWorkflowOrientation();
  }
  const video = document.getElementById('example-video');
  const visual = document.getElementById('workflow-visual');
  const recordVisual = visual.innerHTML;
  let currentSetup = 'prompt';
  let copyTimer;
  function text(id, value) { document.getElementById(id).textContent = value; }
  function activate(group, active) { group.forEach(button => { const selected = button === active; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; }); }
  function wireTabs(selector, callback, vertical = false) {
    const group = [...document.querySelectorAll(selector)];
    group.forEach((button, index) => {
      button.addEventListener('click', () => { activate(group, button); callback(button); });
      button.addEventListener('keydown', event => {
        let next;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = group.length - 1;
        if (event.key === 'ArrowRight' || (vertical && event.key === 'ArrowDown')) next = (index + 1) % group.length;
        if (event.key === 'ArrowLeft' || (vertical && event.key === 'ArrowUp')) next = (index - 1 + group.length) % group.length;
        if (next !== undefined) { event.preventDefault(); group[next].focus(); group[next].click(); }
      });
    });
    return group;
  }
  wireTabs('[data-example]', button => {
    const example = examples[button.dataset.example];
    video.pause();
    text('video-format', '');
    video.poster = example.poster;
    video.src = example.src;
    video.setAttribute('aria-label', example.label);
    video.load();
    text('example-request', example.request);
    text('example-description', example.description);
    text('video-file', example.file);
    const caption = document.getElementById('example-title');
    caption.replaceChildren(document.createTextNode(example.title + ' '));
    const category = document.createElement('span'); category.className = 'caption-muted'; category.textContent = '/ ' + example.category; caption.append(category);
    text('example-duration', example.duration);
    text('example-footnote', example.note);
    const source = document.getElementById('example-source');
    source.href = example.sourceUrl;
    source.textContent = example.sourceLabel;
    document.getElementById('example-panel').setAttribute('aria-labelledby', button.id);
  });
  wireTabs('[data-step]', button => {
    const step = workflow[button.dataset.step];
    text('workflow-detail-title', step.title);
    text('workflow-detail-copy', step.copy);
    const link = document.getElementById('workflow-detail-link'); link.href = step.href; link.textContent = step.link + ' ↗';
    document.getElementById('workflow-panel').setAttribute('aria-labelledby', button.id);
    if (button.dataset.step === 'record') visual.innerHTML = recordVisual;
    if (button.dataset.step === 'review') visual.innerHTML = '<img class="workflow-image" src="/retake-ui.png" width="2880" height="1800" alt="Retake local library showing a recorded take and scene stills">';
    if (button.dataset.step === 'rerun') visual.innerHTML = '<div class="rerun-visual"><div class="take-card"><img src="/media/retake-proof-first-run-poster.jpg" width="1920" height="1080" alt="Recorded first-run proof example"><span>First recorded take</span></div><div class="take-card new"><img src="/media/retake-proof-rerun-poster.jpg" width="1920" height="1080" alt="Recorded rerun proof example"><span>Revised captions</span></div></div>';
  }, true);
  wireTabs('[data-setup]', button => {
    clearTimeout(copyTimer);
    document.querySelector('#copy-setup span').textContent = 'Copy';
    currentSetup = button.dataset.setup;
    const method = setup[currentSetup];
    text('setup-label', method.label); text('setup-code', method.code); text('setup-hint', method.hint); text('copy-status', '');
    document.getElementById('setup-panel').setAttribute('aria-labelledby', button.id);
  });
  document.getElementById('copy-setup').addEventListener('click', async () => {
    clearTimeout(copyTimer);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(setup[currentSetup].code);
      text('copy-status', 'Copied. Paste it into your agent or terminal.');
      document.querySelector('#copy-setup span').textContent = 'Copied';
      copyTimer = setTimeout(() => { document.querySelector('#copy-setup span').textContent = 'Copy'; text('copy-status', ''); }, 4000);
    } catch {
      const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(document.getElementById('setup-code')); selection.removeAllRanges(); selection.addRange(range);
      text('copy-status', 'Select and copy the highlighted instructions with your keyboard.');
    }
  });
  document.getElementById('watch-demo').addEventListener('click', () => {
    document.getElementById('tab-product').click();
    video.muted = false;
    video.play().catch(() => { /* Native playback controls remain available. */ });
  });
  const knownFormat = () => { if (video.videoHeight) text('video-format', video.videoWidth + ' × ' + video.videoHeight); };
  video.addEventListener('loadedmetadata', knownFormat);
})();
