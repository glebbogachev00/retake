# Capture demos — the brief

What each video is for, before any YAML is written. Read this, argue with it,
then the manifests get drafted from whatever survives.

## The rule

Every demo answers one question: **what was going wrong, and what did one
gesture do about it?** Wound → gesture → payoff. If the first caption could
sit under any notes app's video, the wound is missing.

Two consequences:

- **A demo may not open on an empty board.** An empty board has no problem,
  so it can only show features being used. The board must already be in the
  state the product fixes — a pile, a wrong filing, a list that only grew.
  The hero is the one exception: its mess is the input sentence.
- **Captions name the wound or the payoff. Never the control.** "Tap a quoted
  starter" is an instruction. "A messy thought. No form to fill in." is a
  claim. The ideas file already has the right lines — every "Why it lands"
  is a wound statement the old demos then left on the page.

House style stands (`style.md`): still camera, real typing, plain captions,
hold the payoff two seconds. The hero breaks the no-zoom rule in one scene;
that is a choice, not an oversight, and the shorts below do not follow it.

## The set

Seven today. Five after this: three kept, two new, and nothing that shows a
feature for its own sake.

### Keep

**capture-hero** — *Your notes app became a junk drawer.*
Already right. One garbled sentence in; an action with a shelf life and a
thread that grows; then the second thought lands *on* the thread. "Not a new
pile" is the whole product in four words. Leave it alone.

**capture-two-places** — *One sentence, two places.*
The 15-second social cut of the hero. Worth keeping as the short, but its
captions need the wound: open on "One sentence. Two different kinds of
thing." rather than "Capture a thought exactly as it comes." Its demo
sentence is the verified one (eight runs, one action + one thread every
time) — do not swap it.

**distill-messy** — *Too tangled to capture?*
The only existing demo that opens with a wound. Keep the opening, rewrite
the middle: "capture talks it through with you" is feature voice. The beat
that matters is the engine *stating* a draft rather than interrogating, so
the caption on that scene should be the draft's own words. `plan.json` has
it failing on a missing model key — the isolated server reads the repo's
`.env.local`, so confirm that is still true before assuming it.

### New

**tidy-the-pile** — *Everything went in. Nothing came back out.* (~30s)

The one video that shows the sorting layer working on an actual pile, which
is what the landing page promises and nothing currently films.

- **Seed:** a board that has quietly gone wrong. The same thought in two
  threads in different words (a merge). A task captured twice a week apart
  (a duplicate). An action with its own deadline twelve days gone and
  nothing to fade it (let go).
- **Beats:** the board, ordinary-looking. Open Tidy. Rows appear, each one a
  sentence. Accept the merge. Accept the let-go. Back to the board — lighter,
  and nothing deleted: the let-go sits in Faded, recoverable.
- **Payoff caption:** "Two taps. Nothing lost."
- **Risk, stated plainly:** the merge and the duplicate come from the model
  pass, which is not deterministic — the same board has given 0 and then 3
  proposals on consecutive readings. The let-go row is arithmetic and will
  always be there, so the video always has a payoff; the merge is the good
  take. This is what Retake is named for. The reading is cached per board
  state within a session, so once a take has the rows, re-rendering does
  not re-roll them.

**it-learns** — *It got it wrong. You told it once.* (~20s)

No competitor can record this one.

- **Seed:** empty board, no learned rules.
- **Beats:** type "we are out of cold brew again, which is annoying". It lands
  as a thread. Tap Undo. The app asks *Then what was it?* — tap **An
  action**. It re-sorts as an action, and one line appears: *An action, then
  — there is something to close.* Then type "cold brew is completely
  finished again" and watch it land as an action without being asked.
- **Payoff caption:** "Said once. Learned."
- **Verified:** the whole loop ran end to end on 19 Aug — thread without the
  rule, action with it, twice each. The undo banner lives nine seconds; the
  manifest has to tap inside that window.

**the-honest-list** — *A todo list that only ever grows.* (~20s)

Replaces mark-done and shelf-life, whose actual story this is.

- **Seed:** a board in mid-life. One action due tomorrow. One with "6d" on
  its pill. One kept. One already in Faded, two weeks from clearing.
- **Beats:** the board — each pill says how long it has. Tick one done; it
  folds away. Open Faded; there is the one that stopped mattering, with
  "clears in 14d" beside it. Tap Restore — it comes straight back.
- **Payoff caption:** "Things stop mattering. The list knows. Nothing is
  ever just gone."
- **Verified:** fade, Faded and Restore are all deterministic; nothing to
  retake for.

### Cut

**mark-done, shelf-life** — every todo app has this exact video. Their
substance moves into the-honest-list.

**search-thought** — "type, search, found" is a feature anyone can show.
The wound behind it ("retrieve a thought from its words without deciding
where to file it first") is real, but it is a line for the landing page, not
a twenty-second film.

**capture-landed-action, quoted-starter-capture** — near-duplicates of each
other and of the hero. **Both point at `localhost:3000`, which is the live
board, and log in with the real password.** Recording either one captures
demo junk into synced, real data. Delete, do not retarget.

## What has to exist before the manifests

1. **A seed that installs a board with real dates.** Three of the five demos
   need a board that is already old — overdue, faded, mid-shelf-life — and
   the hub takes epoch milliseconds, so a fixture with fixed timestamps is
   stale the day after it is written. Needed: `seeds/seed-board.mjs
   <fixture>` that takes offsets ("due 12 days ago", "faded 3 days ago"),
   stamps them against now, and installs the board the way `wipe-board.mjs`
   does — tombstoning what is there first, bumping `rev`, so an open tab
   does not re-upload the old board over it.
2. **Three fixtures** in that relative form: `pile.json`, `midlife.json`, and
   the existing empty one.
3. **The isolated server on :3100**, as now. Nothing here touches :3000.

## Order

it-learns first — smallest, fully deterministic once the sorter lands the
first capture as a thread, and the strongest claim. Then the-honest-list.
Then tidy-the-pile, because it is the only one that needs retakes and should
not be the thing that decides whether the afternoon worked.

## Open questions for Gleb

- **tidy-the-pile's merge is a good take, not a guaranteed one.** Acceptable,
  or would you rather the video rest only on the deterministic rows and treat
  a model proposal as a bonus when it shows?
- **Captions voice.** The hero's captions are in the landing-page register
  ("not a new pile"). The old shorts were in manual register ("Tap a quoted
  starter"). This brief assumes everything moves to the hero's voice. Yes?
- **Distill stays?** It is the weakest of the keepers — valuable, but its
  payoff is a better sentence, which is a quieter thing to film than a
  board getting lighter. Keep, or park until the other four are done?
