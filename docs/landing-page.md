# Retake landing-page review

## Preview

- Isolated worktree: `~/Documents/Retake-landing-agent-recording`
- Branch: `landing-agent-recording`
- Run: `npm run site:dev`
- Preview: `http://127.0.0.1:4387/`
- A/B layout comparison: `http://127.0.0.1:4387/compare/`
- Documentation: `http://127.0.0.1:4387/docs/`
- Browser-width review harness: `http://127.0.0.1:4387/__review`
- Original checkout and live site are unchanged. This is a review draft, not a deployment.

## Layout variants

- Version A, the split layout, is the homepage `/` (Gleb's choice, October 14).
- Version B, `/layout-b/` (noindex), centers the main hierarchy and wide example player, but keeps a compact two-column workflow and three-column feature row on desktop. Setup and FAQ content use centered containers; not every section is forced into one column. The setup card explicitly overrides the old split-layout alignment and sizes to its content instead of retaining fixed minimum heights.
- The rejected brief-builder form is absent from both variants.
- `/compare/` switches A/B and preview widths. It is a manual review tool, not a traffic experiment: there is no visitor assignment, conversion tracking, or analytics.
- No layout has been pushed or deployed. The current branch is ahead of upstream with unrelated product commits; isolate website changes before any push.

## Split layout (A) — the preferred direction, October 14

Gleb prefers the split layout. Layout A now has its own layer, `site/split.css` and `site/split.js` (loaded only by the split homepage; centered B at `/layout-b/` is unchanged):

- **Split hero:** the promise on the left; on the right an illustrative agent session (brief → scout → dry run → record → render → a take to review) cycling through the three real examples. "Watch" opens that example in the player below and plays it. Labelled "Illustrative".
- **Frame:** rails down the page standing a gutter outside the content (40px, 20px under 1200px, none on phones), crosshairs where the section lines meet them, `[ BRACKET ]` section labels, a fading cell grid and a playhead timeline under the hero, in the spirit of firecrawl.dev, in Retake's own colours.
- **Animated mark:** inline SVG; the four takes arrive, the amber kept take records across. Replays on hover, and on the closing mark when it scrolls into view.
- Sections fade in on scroll; feature cards, workflow steps and FAQ rows take a soft pointer highlight.
- Everything stands still under `prefers-reduced-motion`; the session then shows its finished state and switches only on click. Without JavaScript, nothing is hidden.
- Checked at 1440px and 390px: no horizontal overflow, no console errors. Site tests pass.

## Documentation

The local `/docs/` page covers first setup, agent connection, recording/review, optional presentation, privacy, and troubleshooting, with local search and copyable examples. CLI examples are checked against a committed fixture of published Retake 0.14.1 (its npm gitHead), rather than assuming the newer local branch has shipped. The preview/fresh/final lifecycle flags are published but deliberately left out: the agent drives them.

## Selected published media

The example player uses only the three videos explicitly selected by Gleb on October 14, 2026:

1. **Default / product overview:** https://x.com/trycapturez/status/2102280223316471854. Full ~57 seconds, 1280×720 (highest published HLS rendition), original voiceover retained.
2. **Education:** https://www.facebook.com/reel/1670144871497010. Full ~31-second TechTutor Cheesy Puffs code walkthrough, 1920×1080.
3. **Content for X:** https://x.com/Peaceful_HN/status/2099791282986258613. Full ~27 seconds, 1920×1080.

All three were downloaded from their exact published posts, not substituted with older local recordings. Video and original audio were muxed without re-encoding or trimming. Audio packet hashes match the source streams for all three. The Facebook video stream was independently hash-matched too. These checks establish preservation, not subjective listening quality.

The old 15-second silent hero cut, Scratch excerpt, mark-done example, and local Retake tour are no longer example selections. Each current example links to its original post. Briefs are illustrative, not historical agent-prompt receipts.

Existing paired first-run/rerun proof recordings and the local review screenshot remain in the workflow explanation. The rerun proof changes captions while keeping browser steps unchanged; it is not proof of automatic interface repair.

## Voiceover and captions

- Voiceover and captions are independent, optional output choices, stated in the hero, feature cards, and FAQ.
- The player does not autoplay or start muted.
- “Watch the narrated demo” selects the full Capture overview and plays with sound. Visitors retain native mute controls.
- Switching examples pauses the previous video.
- No fake editing/caption-removal switches are shown for already-rendered clips.
- Review the silent take and narration script before voiceover synthesis.

## Checks

- `npm run site:test`: 20 static checks pass, covering selected media, optional output, A/B preservation, documentation structure and published CLI compatibility.
- `node --check site/landing.js` and `node --check test/landing.test.mjs` pass.
- Actual playback starts, video frames, audio decoding, and absence of media errors checked in the browser for all three selected videos.
- Earlier media-update checks covered 320, 390, and 1024 widths. Final balanced B was checked at 320px, 390px, and desktop fit; docs were checked at 390px, without horizontal overflow. These are browser-layout checks, not physical-phone tests.
- Public GitHub source links were checked. References to two unpushed guide files were removed; the recording skill and code references are pinned to the published release.
- `npm run site:test:browser` is available for a separate Playwright runner. Browser launch is unavailable in the current sandbox; do not describe that suite as having passed.
- Full Facebook stream decode passed independently. Complete end-to-end browser playback and subjective audio/synchronization quality were not assessed.

## Product and action boundaries

Retake records browser workflows, not general native desktop/mobile apps. Flows are reusable, not self-healing. Optional narration, analysis and visual checks may use external providers and incur provider costs. Do not promise a hosted API, automatic interface repair, or that every optional feature stays offline.

No deployment, external message, account creation, recording job, narration synthesis, paid model call, or public post was triggered by this landing-page update.
