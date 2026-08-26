# Giving a landing page a desktop layout — notes from doing it to Capture

Written 2026-08-26, after rebuilding `trycapture.app`'s landing page for wide
screens. Retake's `site/index.html` has the same defect and can take the same
treatment. This is both the method that worked and the mistakes that cost the
most time — read the failures section before you start, because most of them
look like sensible moves.

---

## The defect, stated in numbers

Capture's landing page was one `760px` column at every screen width. At 1440px
that is **340px of dead space on each side — 47% of the screen unused** — and,
more to the point, the desktop layout *was* the mobile layout, centred. Nothing
about it used the width it was given.

Gleb's own words, captured on his phone: *"Why are both Capture and Retake
landing pages designed so that all the content is just in the middle, like a
strip, with a bunch of empty spaces on the sides?"* and *"on the desktop it is
basically a copy-paste of the mobile version, which it shouldn't be."*

**Retake has it worse.** `site/index.html` line 36 is `main { max-width: 880px }`,
and all six of its media queries are `max-width` (mobile-down). There is no
`min-width` rule anywhere, which means there is no desktop layout at all — only
a phone layout that never stops applying.

Measure before you design. In the console:

```js
const w = document.querySelector('main').getBoundingClientRect();
({ innerWidth, content: Math.round(w.width), deadEachSide: Math.round(w.left) })
```

## What is NOT the fix

**Do not just raise `max-width`.** 880px is roughly right for *reading* — long
measures are harder to read, so widening the column trades one defect for
another. We built that variant ("one wider column, same order"), looked at it,
and Gleb dropped it. It was still recognisably the mobile stack, only wider, and
the headline began breaking three ways with an orphan word on its own line.

The fix is giving desktop a **shape of its own**, while prose keeps its measure.

## What worked

**One width, all the way down.** This is the single most important rule and the
one we got wrong first. Our first attempt gave the header 760, the hero 1320,
the demo card 760 and the video 1320 again — four different edges stacked down
the page. Gleb's reaction: *"a and c look ok but still look like a mess."* The
moment everything shared one container width, it read as designed:

```css
/* Everything below only applies once there IS width to use. */
@media (min-width: 1100px) {
  .site-wrap { max-width: 1120px; }
}
```

**A big centred hero.** Headline, lede and buttons centred, headline allowed to
grow. This was the part Gleb picked out unprompted: *"I like the top section of
c with text."*

```css
.site-hero      { text-align: center; }
.site-hero h1   { font-size: clamp(64px, 7vw, 104px); max-width: none; }
.site-lede      { max-width: 620px; margin-inline: auto; }
.site-actions   { justify-content: center; }
```

**Rows that have something to pair, pair.** This is where the width actually
gets used — not by stretching text, but by putting related things beside each
other. Three concept cards across; "who this is for" beside "what it refuses to
become"; two secondary videos as a pair.

```css
.kind-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.split, .reel-more { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
```

**One card edge, reading measure held by the text inside.** An earlier pass
capped prose cards at `820px` and left them left-aligned, so they alternated
with full-width blocks and produced a ragged right edge. Cap the *paragraphs*,
not the cards:

```css
.note p, .problem p, .quiet p, .proof p { max-width: 68ch; }
```

**Lead with the recording, not a diagram of it.** The page had a posed
"you say → it lands as" card above the video. They make the same point, and the
video makes it by moving. We swapped them: video first, card below in the slot
the video vacated. Neither is repeated.

**A container around the video, no caption under it.** We tried bare (no card)
and Gleb asked for the container back — *"we can put a little container around
it, maybe a white border that we had before, but you don't need to add a comment
on the bottom."* The caption repeated the headline.

**Do not autoplay a take that opens on a title card.** Autoplay looked broken
because frame 0 is an intro card — as a still, an empty rectangle. Use
`controls` plus a `poster` set to the *payoff* frame, so the first thing anyone
sees is the result.

## Failures worth not repeating

These all shipped to the live site or wasted a round trip. Every one of them
looked reasonable at the time.

**1. Hand-written `aspect-ratio` drifts away from the file.** A commit that
literally claimed to "stop cropping the demos" set `aspect-ratio: 16 / 9` on a
`1440x1180` recording. The browser obeyed the number and pillarboxed the video
into black bars. **Give every `<video>` its file's real `width`/`height`
attributes** — the ratio then comes from the recording and cannot drift when a
take is re-recorded, and the layout still reserves the right box before metadata
loads.

> Retake risk: `site/index.html` builds `<video>` tags in JS with no
> `width`/`height` at all. Add them from the actual files.

**2. Committing markup without its media.** A hero `<video>`'s markup was
committed while `capture-hero.jpg`/`.mp4` stayed untracked. Locally it worked
perfectly; in production both 404'd and every visitor got an empty player with
controls at 0:00, for days. **An untracked asset is a 404 in production and
never a local one.** Assets belong in the same commit as the markup pointing at
them. Check with `git status --porcelain public/` before pushing.

**3. Re-encoding a video while fixing something unrelated.** While fixing
"posters look soft" I re-encoded a demo to 1920x1080, which letterboxed the
content inside black bars — baking the bars into the file. Caught only because
Gleb looked at it. Leave media alone unless the media is the thing being fixed.

**4. Verifying against a stale build.** This is the worst one. The preview
server ran `npm start` against a *prebuilt* dist directory two days old. Every
screenshot I took "confirming" the fix was of a build from before the bug
existed — it looked correct for entirely the wrong reason. **Verify against a
server that compiles from source**, and sanity-check by grepping the rendered
page for a string you just added.

**5. Screenshots that silently lie.** In the in-app browser pane, screenshots do
not repaint after a *programmatic* scroll (`window.scrollTo`, `scrollIntoView`)
— you get a blank or stale frame while the DOM reports correct geometry. And
emulating a 1440px viewport in a small pane scales the page into a corner, too
small to judge. **Use headless Chrome at true width instead:**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --virtual-time-budget=10000 \
  --window-size=1440,4000 --screenshot=out.png "http://localhost:PORT/"
```

**6. Measuring instead of looking.** I reported a layout as fixed on the
strength of `getBoundingClientRect` numbers. The numbers were right and the page
was still ragged. Gleb: *"Did you actually see the version, there are still
empty space misalignments — can you actually look at what you created."* He was
right. Numbers prove absence of black bars; only looking finds a mess.

**7. Removing card borders to reduce noise.** The page has ~9 stacked bordered
cards, each with its own all-caps mono kicker, and it is genuinely tiring —
Gleb: *"this section is just visually taxing, there's so many things happening,
and the page doesn't guide the user."* My fix was to strip borders from the
prose sections and keep boxes only for "objects". Verdict: *"you just removed
the card, I don't think it fits, it is calmer now but not better."* Reverted.

**This problem is still open.** Calm is not the same as better — removing
definition made it flat. If you hit the same thing on Retake, the untried
directions are (a) reduce the *number* of blocks by merging related ones,
(b) vary card weight so one or two dominate instead of nine competing equally,
or (c) drop the all-caps kickers, which duplicate the bold heading right below
them and are most of what makes it read like a manual. Do not just delete
borders.

## The method that actually worked

**Build the candidates as real pages, not mockups.** A throwaway route rendering
the real component with a `data-layout` attribute, and one CSS block per
variant:

```jsx
// src/app/lab/[v]/page.tsx  — scratch, never linked, deleted after the pick
export default async function Lab({ params }) {
  const { v } = await params;
  return <Landing layout={v} />;
}
```

```css
.site-wrap[data-layout="a"] { /* … */ }
.site-wrap[data-layout="c"] { /* … */ }
```

Same CSS, same fonts, same videos as production, so what you judge is the real
thing. Three variants took about twenty minutes. Gleb opened all three at full
width in his own browser, killed one immediately, and steered the rest.

For a static page like Retake's `site/index.html`, the equivalent is copying it
to `site/lab-a.html` / `lab-c.html`, changing only the CSS block, and deleting
them once a direction is picked.

**Then: render, look, fix, render again.** Every round in this session that
skipped "look" produced something that had to be redone.

## Checklist for the Retake page

1. Measure the dead space at 1440 and write the number down.
2. Add a `@media (min-width: 1100px)` block — there is currently none.
3. Pick one container width (~1100–1150) and give it to *everything*.
4. Centre the hero; let the headline grow; keep the lede ~620px.
5. Pair what can pair: the case-study logos, the release notes, any two-list
   section.
6. Cap paragraphs at ~62–68ch rather than capping their containers.
7. Give every `<video>` its real `width`/`height`; poster on a payoff frame;
   no autoplay if the take opens on a title card.
8. `git status --porcelain site/` before pushing — no untracked media.
9. Screenshot at true 1440 with headless Chrome and **look at it**.
10. Check the phone width too; the `min-width` guard should mean nothing below
    1100 changed, but confirm rather than assume.

## Related

- `docs/friction-notes-2026-08-25-audit.md` — Retake recording friction
- Capture commit `a87c1a6` — the layout change described here, with the
  reasoning in the message
