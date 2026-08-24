# Fix brief: Retake demo mode, launch mode, and Capture launch cut

Paste this brief into Claude while it works in `~/Documents/Retake`.

## Outcome

Make the Capture launch video feel clear, deliberate, and ready to present. A viewer must understand the product promise without reading an explanation.

The entry promise is simple:

> One sentence becomes an action and a thread.

The current Capture landing page adds two deeper promises:

- Capture learns when the person corrects a wrong sort.
- A thread reads its evidence and proposes the next move.

Together, the product story is: capture the mess, improve through correction, then turn accumulated thinking into action.

Use the current output as the failed reference:

`outputs/capture-two-places/demo.mp4`

Do not defend the existing cut because its build and checks passed. Those checks proved file integrity, not demo quality.

## Two Retake output jobs

Retake serves two different jobs. Do not judge or build them with one editing rule.

### Demo mode

A demo proves how a product works. It favors direct interaction, legible evidence, and minimal framing. A title, narration, or branded ending is optional.

### Launch mode

A launch video presents the product. It can use a title, narrative pacing, narration, music, visual emphasis, and a branded ending.

The current Capture video is a launch video. The critique concerns how this cut uses those elements, not their presence.

## Current Capture landing structure

Use `src/app/Landing.tsx` as the current product-story source.

The page now presents three proof stories:

1. **One sentence, two places.** A mixed thought becomes an action and a thread.
2. **It got it wrong. You told it once.** Undo records a correction, and the next sort changes.
3. **It names the next move.** A thread reads its evidence and offers an action.

The page gives the first story visual priority. It shows one large video, then the two deeper stories below it.

This hierarchy should guide the video system:

- A functional demo can prove one story at a time.
- A short launch teaser can focus on the entry promise.
- A fuller product presentation can connect all three stories as one progression.

Do not force all three stories into one short video. Choose the output job first.

## What failed

### 1. The current pacing is too slow

The video lasts 28.8 seconds, but the runtime does not build a launch narrative. Typing takes about seven seconds. The viewer waits without receiving new information.

Do not force a demo-mode duration onto the launch cut. Use the shortest runtime that supports the presentation. Remove dead time, not intentional launch pacing.

### 2. The payoff is hard to see

The interface is small, pale, and surrounded by empty space. The action and thread appear separately. The viewer must search the screen to understand the result.

Show the action and thread together in one clear payoff frame. The visual must prove the split without help from narration.

### 3. The captions do the product job

The captions explain what happened while the viewer searches the interface for proof. The product action should carry the story.

Use captions only when they add information that the screen cannot show. Do not use a caption to describe an obvious visible action.

### 4. The current title and outro weaken the launch story

The title card is a valid launch element, but its treatment feels generic. It does not establish a distinct Capture presentation.

The outro promotes `retake-demos` and pulls attention away from Capture. A Capture launch video must end with Capture, its promise, or its next step. Use Retake branding only when the video presents Retake.

### 5. The callout adds noise

The final callout does not make the thread clearer. It adds another visual layer after the result.

Remove it unless a test viewer cannot find the thread without it. If the result needs a callout, improve the composition first.

### 6. The voice sounds robotic

The current voice uses Edge TTS Jenny. The voice does not sound natural enough for a launch presentation.

Do not ship the current voiceover. Replace it only with approved continuous narration. A silent cut is better than unapproved synthetic speech.

### 7. The narration pipeline breaks speech into fragments

This is the main narration defect. Retake synthesizes each scene caption as a separate clip. It places each clip at the scene start.

This design causes:

- prosody to reset for every sentence
- an unnatural read, wait, read, wait rhythm
- silence that follows scene boundaries instead of spoken cadence
- captions to act as a narration script
- video timing to control speech timing.

Changing the voice will not fix this structure.

## Required Retake rules

Give demo mode and launch mode separate output contracts. Do not add launch treatment to a functional demo by default.

Launch mode can offer a title, narration, music, callouts, and a branded ending. Each element must serve the product story.

Keep synthetic voiceover off until the person approves the actual voice and full narration performance.

If Retake keeps narration support, redesign it as a separate pipeline:

1. Write one continuous spoken script.
2. Synthesize the full script as one performance, or use segments that preserve shared context and prosody.
3. Measure the spoken timing.

4. Edit the video to the narration.
5. Create captions from the approved narration.
6. Let the person hear and approve the voice before the final render.

Do not treat successful synthesis or healthy volume levels as approval. Those checks prove that audio exists. They do not prove that the voice sounds good.

## Required Capture launch cut

For a short teaser, build a compact entry story:

1. Open with Capture and the promise.
2. Show the sentence without a seven-second typing delay.
3. Trigger Capture.
4. Show the action and thread together as the payoff.
5. Hold the result long enough to understand it.
6. End with Capture branding, its promise, or a relevant next step.

For a fuller product presentation, use this progression:

1. A messy sentence sorts into an action and a thread.
2. A correction teaches the sorter.
3. The growing thread proposes the next move.
4. Capture closes as a system that moves thought toward action.

Do not ship these current treatments:

- fragmented Edge TTS voiceover
- the unrelated `retake-demos` outro
- a callout that does not improve comprehension
- repeated explanatory captions
- long typing footage
- empty holds.

Keep or replace launch elements when they improve the presentation. Do not remove them only because a functional demo would omit them.

## Acceptance criteria

The work is complete only when all criteria pass:

- A viewer can state the promise after one viewing.
- The action and thread appear together in one payoff frame.
- The text remains legible at normal playback size.

- The title establishes Capture and its promise.
- The ending belongs to Capture, not Retake.
- Any voiceover plays as continuous, natural speech.
- A person approves the actual voice before final render.
- Any callout improves comprehension.
- No single setup beat feels longer than its information value.

- A human watches the final MP4 before calling it complete.
- File checks still pass after the quality review passes.

## Verification

Render the new cut. Open the MP4 and watch it at normal speed. Do not judge it from the manifest, proof log, test output, waveform, or volume data.

Report:

1. the final duration
2. the exact output path
3. what changed in the manifest and renderer
4. what a human observed during playback
5. any Retake default or skill rule changed to prevent this failure.
