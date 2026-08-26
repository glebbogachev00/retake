# Giving a landing page a desktop layout — notes from doing it to Capture

Written 2026-08-26, rebuilding `trycapture.app`'s landing page for wide screens.
Retake's `site/index.html` has the same defects and can take the same treatment.

This is the method that worked plus the mistakes that cost the most time. Read
the failures — most of them looked like sensible moves at the time, and two of
them shipped to production.

There are two separate problems here and they are easy to confuse. **Width** is
mechanical and takes an hour. **Flow** is the one that actually decides whether
the page is any good, and it took the rest of the session. Do width first
because flow is easier to judge once the page is not fighting the screen.

---

# Part 1 — Width

## The defect, in numbers

Capture's landing page was one `760px` column at every screen width. At 1440px
that is **340px of dead space on each side — 47% of the screen unused** — and
the desktop layout *was* the mobile layout, centred.

Gleb, captured on his phone: *"Why are both Capture and Retake landing pages
designed so that all the content is just in the middle, like a strip, with a
bunch of empty spaces on the sides?"* and *"on the desktop it is basically a
copy-paste of the mobile version, which it shouldn't be."*

**Retake has it worse.** `site/index.html` line 36 is `main { max-width: 880px }`,
and all six of its media queries are `max-width` (mobile-down). There is no
`min-width` rule anywhere — so Retake does not have a cramped desktop layout, it
has *no* desktop layout, only a phone one that never stops applying.

Measure first:

```js
const w = document.querySelector('main').getBoundingClientRect();
({ innerWidth, content: Math.round(w.width), deadEachSide: Math.round(w.left) })
```

## What is NOT the fix

**Do not just raise `max-width`.** 880px is roughly right for *reading*. We built
that variant, looked at it, and Gleb dropped it: still the mobile stack, only
wider, and the headline began breaking three ways with an orphan word alone on a
line. The fix is giving desktop a **shape of its own** while prose keeps its
measure.

## What worked

**One width, all the way down.** The single most important rule, and the one we
got wrong first. An early pass gave the header 760, the hero 1320, the demo card
760 and the video 1320 again — four edges stacked. Gleb: *"a and c look ok but
still look like a mess."* The moment everything shared one container width it
read as designed.

```css
/* Everything below only applies once there IS width to use. */
@media (min-width: 1100px) {
  .site-wrap { max-width: 1120px; }
}
```

**A big centred hero.** The part Gleb picked out unprompted: *"I like the top
section of c with text."*

```css
.site-hero    { text-align: center; }
.site-hero h1 { font-size: clamp(64px, 7vw, 104px); max-width: none; }
.site-lede    { max-width: 620px; margin-inline: auto; }
.site-actions { justify-content: center; }
```

**Rows that have something to pair, pair.** This is where width gets used — not
by stretching text, but by putting related things beside each other.

```css
.kind-grid        { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.split, .reel-more{ display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
```

**One card edge; hold the reading measure on the text, not the card.** Capping
prose cards at `820px` and leaving them left-aligned produced a ragged right
edge against the full-width blocks. Cap the paragraphs instead:

```css
.note p, .problem p, .quiet p, .proof p { max-width: 68ch; }
```

**Lead with the recording, not a diagram of it.** A posed "you say → it lands as"
card sat above the video. They make the same point and the video makes it by
moving. Swap: video first, card below in the slot the video vacated.

**A container around the video, no caption under it.** Bare was tried and
rejected — *"we can put a little container around it, maybe a white border that
we had before, but you don't need to add a comment on the bottom."* The caption
repeated the headline.

**Do not autoplay a take that opens on a title card.** Autoplay looked broken
because frame 0 is an intro card, which as a still is an empty rectangle. Use
`controls` plus a `poster` on the *payoff* frame.

---

# Part 2 — Flow (the one that matters)

Width made the page fit. It did not make it good. Gleb, after all of the above
was done:

> *"My issue is that there is no flow. The user doesn't know what to follow, he
> doesn't know what he's looking at. We need to guide the user through the
> landing page section by section. Right now you just throw things and the user
> is just like, what am I paying attention to? What is the key idea?"*

## The diagnosis I got wrong twice

I first read this as **density** — too many elements, too tiring — and attacked
it twice. Both attempts failed, and the failures are instructive:

**Attempt 1: remove the card borders.** Keep boxes only for things that are
genuinely objects; let prose sit on the page background. Verdict: *"you just
removed the card, I don't think it fits, it is calmer now but not better."*
Calm is not the same as better — removing definition made it flat.

**Attempt 2: remove the repeated all-caps kickers and un-dot the bullets.**
Eight mono labels down to five, twelve bullets set as sentences. Verdict:
*"I don't really know, what's the difference?"*

**That question is the finding.** If the user cannot see the difference, it is
not a fix. I had changed *marks*, not *structure*. Both attempts were tuning the
texture of a page whose problem was that it had no architecture.

## The actual diagnosis

**Every heading on the page lived inside a card, and all of them were the same
size.** There was no level of hierarchy above the boxes. So the page had no
sections — just a flat stack a reader had to parse for themselves. Nothing ever
said *here is what you are about to look at, and why*.

Check for this on any page: list every heading and its computed font size. If
they are all inside cards and all within a few pixels of each other, the page
has no sections regardless of how much whitespace you add.

```js
[...document.querySelectorAll('h2')].map(h => ({
  text: h.textContent.slice(0, 40),
  size: getComputedStyle(h).fontSize,
  inCard: !!h.closest('.site-card'),
}))
```

## The fix: a page-level signpost

Introduce one level *above* the cards. It sits on the page background, in the
display face, larger than anything in the boxes beneath it, and carries a
one-line gloss saying what the section is for.

```jsx
function Movement({ id, title, gloss }) {
  return (
    <div className="movement" data-move={id}>
      <h2>{title}</h2>
      <p>{gloss}</p>
    </div>
  );
}
```

```css
.movement    { margin: 40px 0 16px; }
.movement h2 { font-family: var(--font-display), Georgia, serif;
               font-size: 30px; font-weight: 500; line-height: 1.1;
               letter-spacing: -0.02em; margin: 0 0 10px; }
.movement p  { margin: 0; color: var(--muted); font-size: 16px;
               line-height: 1.55; max-width: 56ch; }

@media (min-width: 1100px) {
  .movement    { margin: 56px 0 20px; text-align: center; }
  .movement h2 { font-size: 40px; }
  .movement p  { font-size: 17px; margin-inline: auto; }
  /* The card under a signpost belongs to it. */
  .movement + * { margin-top: 0; }
}
```

Capture ended with four: *Three kinds of thing* · *Who it is for, and what it
refuses* · *Who built it, and on what* · *Yours to keep*. Each with a single
line under it, e.g. *"Two short lists. The second one is why the first one
works."*

## Rules learned while getting the signposts right

**Numbers were tried and cut.** `01 / 02 / 03` in mono above each title. The
argument for them is real — they tell a reader there is an end, which is most of
why a long page feels tiring. Gleb cut them anyway: *"I don't know why you add
tiny numbers. We don't need numbers, we just need the sections."* Numbering a
marketing page makes it read as a manual. Keep the ordering hook as a data
attribute; do not render it.

**Do not signpost the obvious.** The first signpost was *"Watch it work"* over
the demo video. Cut: *"let's remove watch it work — maybe they can figure it out
from the video."* A signpost earns its place only where a reader would otherwise
not know what they are looking at. A video is self-evident.

**Once sections exist, the cards inside them must stop repeating the label.**
This is the biggest polish win. The closing block had a signpost *"Yours to
keep"*, a card kicker `YOURS`, and a card heading *"Your thinking stays yours."*
— one idea wearing three labels. The signpost is the heading now; the card keeps
its body.

```css
.site-proof > .funding-card-label,
.site-proof > h2 { display: none; }
```

**A signpost must cover everything in its section.** Ours said *"What it will not
become"* over a block whose left column was *who this is for* — it described
half its own section. Renamed to *"Who it is for, and what it refuses."* Check
every signpost against everything under it, not just the first thing.

**Signposting exposes bad ordering, which is the point.** Numbering the sections
made it obvious the argument ran 01 → 04 → 02 → 03 → 05: the maker's personal
note sat right after the demo, interrupting the explanation with a biography
before anyone knew what the product did. The order the argument wants is: **show
it working → say what it makes → say what it refuses → who built it → it's
yours.** Numbers are worth adding temporarily during development purely as an
ordering check, then removing.

**Reorder with flex `order`, not by moving markup** — cheaper and reversible:

```css
.site-wrap { display: flex; flex-direction: column; }
.site-wrap > .site-hero      { order: 1; }
.site-wrap > .hero-clip      { order: 3; }
.site-wrap > [data-move="02"]{ order: 6; }
.site-wrap > .site-kind-grid { order: 7; }
```

**Target with data attributes, never `:nth-of-type`.** I used
`.movement:nth-of-type(n)` first. `nth-of-type` counts siblings of the same
*element type* — the signposts are `div`s among many other `div`s — so every
heading silently attached to the wrong section: *"Yours to keep"* landed at the
top of the page and *"What it will not become"* sat over *"Your thinking stays
yours."* It fails silently and looks like a content bug.

---

# Failures worth not repeating

**1. Hand-written `aspect-ratio` drifts from the file.** A commit that literally
claimed to "stop cropping the demos" set `aspect-ratio: 16 / 9` on a `1440x1180`
recording; the browser obeyed the number and pillarboxed it into black bars.
**Give every `<video>` its file's real `width`/`height` attributes** — the ratio
then comes from the recording and cannot drift, and layout still reserves the
right box before metadata loads.

> Retake risk: `site/index.html` builds `<video>` tags in JS with no
> `width`/`height` at all.

**2. Committing markup without its media.** A hero `<video>`'s markup was
committed while its `.mp4`/`.jpg` stayed untracked. Locally perfect; in
production both 404'd and every visitor got an empty player at 0:00, for days.
**An untracked asset is a 404 in production and never a local one.** Check
`git status --porcelain site/` before pushing.

**3. Re-encoding a video while fixing something unrelated.** While fixing
"posters look soft" I re-encoded a demo to 1920x1080, letterboxing the content
inside black bars — baking them into the file. Caught only because Gleb looked.

**4. Verifying against a stale build.** The preview server ran `npm start`
against a *prebuilt* dist two days old. Every screenshot "confirming" the fix
was of a build from before the bug existed — it looked correct for entirely the
wrong reason. **Verify against a server that compiles from source**, and
sanity-check by grepping the rendered HTML for a string you just added.

**5. Screenshots that silently lie.** In an embedded browser pane, screenshots do
not repaint after a *programmatic* scroll (`window.scrollTo`, `scrollIntoView`)
— blank or stale frames while the DOM reports correct geometry. Emulating 1440px
in a small pane also scales the page into a corner, too small to judge. Use
headless Chrome at true width:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --hide-scrollbars --virtual-time-budget=11000 \
  --window-size=1440,4000 --screenshot=out.png "http://localhost:PORT/"
```

**6. Measuring instead of looking.** I reported a layout fixed on the strength of
`getBoundingClientRect` numbers. The numbers were right and the page was still
ragged. Gleb: *"Did you actually see the version… can you actually look at what
you created."* Numbers prove the absence of black bars; only looking finds a
mess.

**7. Tuning texture when the problem is structure.** See Part 2. Two rounds spent
on borders and label counts before noticing the page had no hierarchy. **If a
change is hard for the user to see, it was the wrong change** — do not defend
it, find the structural problem.

---

# Method

**Build candidates as real pages, not mockups.** A throwaway route rendering the
real component with a variant attribute, one CSS block per variant:

```jsx
// src/app/lab/[v]/page.tsx — scratch, never linked, deleted after the pick
export default async function Lab({ params }) {
  const { v } = await params;
  return <Landing variant={v} />;
}
```

Same CSS, fonts and videos as production, so what is judged is the real thing.
Three variants took about twenty minutes. Gleb opened all three at full width in
his own browser, killed one immediately, and steered the rest. Every round that
skipped "render it and look" produced something that had to be redone.

For a static page like Retake's, copy `site/index.html` to `site/lab-a.html` and
change only the CSS block. Delete them once a direction is picked.

**Tell the user the exact URL.** Variants live at `/lab/N`, not `/` — Gleb spent
a round looking at the root wondering why nothing had changed.

---

# Checklist for the Retake page

**Width**
1. Measure the dead space at 1440 and write the number down.
2. Add a `@media (min-width: 1100px)` block — there is currently none.
3. Pick one container width (~1100–1150) and give it to *everything*.
4. Centre the hero; let the headline grow; keep the lede ~620px.
5. Pair what can pair: case-study logos, release notes, any two-list section.
6. Cap paragraphs at ~62–68ch rather than capping their containers.

**Flow**
7. List every `h2` with its size and whether it is inside a card. If they are all
   boxed and all the same size, the page has no sections.
8. Add page-level signposts — display face, larger than anything in the cards,
   one line of gloss. Not over anything self-evident like a video.
9. Number them *temporarily* to check the argument is in order, then delete the
   numbers.
10. Reorder with flex `order` + data attributes. Never `:nth-of-type`.
11. Delete every label a signpost now duplicates.
12. Check each signpost describes *everything* beneath it.

**Media and shipping**
13. Give every `<video>` its real `width`/`height`; poster on a payoff frame; no
    autoplay if the take opens on a title card.
14. `git status --porcelain site/` — no untracked media.
15. Screenshot at true 1440 with headless Chrome and **look at it**.
16. Check the phone width; the `min-width` guard should mean nothing below 1100
    changed, but confirm rather than assume.

# Related

- `docs/friction-notes-2026-08-25-audit.md` — Retake recording friction
- Capture commit `a87c1a6` — the width change, reasoning in the message
