# Agent production guide

Use this guide for a client video series. It turns one brief into repeatable, reviewable demos without repeated browser captures.

## 1. Lock the series brief

Record these facts before you edit a manifest:

- audience and one outcome per video

- delivery size and frame rate

- product name and language

- title pattern, intro, outro, and poster design

- voice, speaking rate, and pronunciation notes

- music bed and target loudness

- camera policy, such as static or approved bounded zoom

- privacy selectors and prohibited screens

- actions that must stop before confirmation

- approval folder and file naming pattern

Do not infer a new style after the first video. Use the approved series treatment until the person changes it.

## 2. Map the site before a batch

Scout every required route before recording. Save one row per flow:

- **Route:** Exact URL and expected redirect.

- **Session:** Signed out, signed in, or manual sign-in required.

- **Start state:** Visible element that proves the page is ready.

- **Action:** The user action shown on camera.

- **Selector:** One unique stable selector, plus a fallback when useful.

- **Result:** A visible postcondition that proves the action worked.

- **Privacy:** Elements to hide for the whole capture.

- **Safety stop:** Control the agent must never activate.

- **Evidence:** A current screenshot of the settled state.

Use `persistentCss` for account data, balances, notifications, QR codes, addresses, IDs, and other private elements. Apply it before page content loads so private data cannot flash during navigation. Omit a screen when reliable coverage is not possible.

Prewarm slow or unstable routes before a capture. Confirm that the saved session reaches the expected page. A site map reduces selector repair and makes later re-recording a bounded maintenance task.

Freeze promotional carousels before capture. Remove support launchers and first-use overlays at document start. Do not let unrelated motion imitate a user action.

## 3. Prove the action before producing the full video

The first short proof must show this sequence:

1. The cursor approaches the target.
2. Activate the control.
3. The interface changes.
4. The changed state remains readable.
5. The narration describes the visible result.

A static screen with narration is not an interaction proof. Do not produce the full version until the proof passes.

Every action needs a visible postcondition. Wait for the result, not a timer. Use `gone`, `minChars`, or `stableMs` when presence alone can lie. Treat a selector that matches more than one element as a failure.

Test every example value during reconnaissance. Some unfunded financial forms replace typed values with zero. Do not force values into the DOM. Do not fund an account to make a demo pass. Record the safety blocker instead.

## 4. Use one browser capture

Run this path:

```bash
npm run retake -- validate demos/<name>.yaml
npm run retake -- dry demos/<name>.yaml
npm run retake -- run demos/<name>.yaml --preview --fresh --no-master
npm run retake -- check outputs/<name>
npm run retake -- render outputs/<name> demos/<name>.yaml \
  --final --preset post-landscape --no-master
```

The preview capture is the source for the final render. Do not run the browser again to change captions, pacing, cards, music, narration, crop, layout, trim, or output frame rate. Re-render the existing take.

Record again only when the browser action, route, fixture, focus target, or visible state changed. Use `--from <scene>` for a changed tail and `--until <scene>` for a short proof.

Never use a second final `run`. Final delivery is a `render` from the preview take.

## 5. Keep camera motion bounded

Use a static camera unless the person approved zoom. A zoom shot must have four phases:

1. ease in before the click
2. hold through the action and visible result
3. ease out once
4. remain wide until the next distinct shot

Do not pump between nearby actions. Do not remain zoomed after a focused scene. Do not display focus boxes, crop guides, or camera geometry. If a bounded shot does not pass frame review, remove it instead of spending the production budget on repeated tuning.

## 6. Build the poster, intro, and outro as one system

Use one branded template across the series. Each video changes only its number, Russian title, subtitle, and selected product frame.

The first encoded frame must match `thumbnail.png`. Check the pixels or extract the first frame before delivery. Never reuse a stale poster from another video. Never let Retake fall back to an arbitrary scene when the series requires a branded poster.

The intro must transition into the settled first scene, not a setup or search state left behind before recording. Inspect the first three seconds at intervals of 250 ms or less. When replacing a rendered segment with FFmpeg, use frame-accurate trim filters. Input-side fast seeking can land on an earlier keyframe and reintroduce a stale state.

Keep title motion small. Settle the title before the product footage starts. End on a related branded frame with a short acknowledgement, enough breathing room to register it, and a smooth fade.

## 7. Make narration solve a viewer problem

Write each video around one question the viewer needs answered. Explain where the control is, what it changes, and when the viewer should use it. Do not narrate the screen as a list of visible objects.

Set the viewer knowledge level before writing the script. For a beginner video, assume no prior knowledge. Define each control or term the first time it appears. Explain where it is, what it shows or changes, and why the viewer may need it. Do not use specialist slang unless you explain it. Split a dense workflow into short parts instead of compressing several concepts into one tour.

Start each instruction when the cursor starts moving toward its target. The spoken action, cursor movement, click, and visible result must read as one event. Do not wait until the interface has changed before naming the action.

Generate narration before the final timing pass. Measure every clip. Each scene must hold long enough for its line, plus a short pause before the next line.

Use one visual master for voice comparisons. Render Ava and Emma from the same source when the person requests both. Speaking rate and tone are separate decisions. A faster rate must still sound natural and must not overlap the next scene.

Use these checks:

- line starts as the cursor moves toward the named control
- click occurs during the spoken instruction, not before it
- visible result appears before the line ends
- line explains the control purpose or decision value

- no two narration clips overlap
- final words complete before the music tail
- output uses 48 kHz stereo audio
- narration remains clear on laptop speakers

## 8. Keep music active but subordinate

For concise product tours, start near 100 to 112 BPM. Use one restrained bed across the series. Duck it under narration and raise it only in gaps. Avoid sleepy ambient tracks and aggressive promotional music.

Leave about 0.75 to 1.25 seconds after the last spoken phrase. Fade the music through the outro. Never cut narration or music at the final frame.

## 9. Review the finished artifact, not the manifest

A successful command is not approval. Review the exact MP4 intended for sharing.

Required gates:

1. `retake check` passes.

2. The full MP4 decodes without errors.

3. `ffprobe` confirms 1920 by 1080, 30 fps, H.264 video, and expected audio.

4. The opening frame matches the branded poster.

5. A timestamped contact sheet includes the ending frame.

6. Dense frames around each action show cursor, activation, and result.

7. No account data, balances, notifications, QR codes, addresses, or IDs appear.

8. No warning, stale menu, failed resource screen, or unfinished state appears.

9. Voice lines align with their scenes.

10. The outro and audio end smoothly.

Extract the literal first and last encoded video frames. A frame near the end does not prove that the last frame is black. Check the exact final frame before approval.

If you cannot check any gate, mark the video `HOLD`. Do not send it for approval.

## 10. Separate production state from approval

Use these status words exactly:

- **configured**: the manifest exists
- **recorded**: a raw take exists
- **rendered**: an MP4 exists
- **reviewed**: the final MP4 passed every gate
- **delivered**: the person received the reviewed file
- **approved**: the person explicitly accepted that exact file

Copy reviewed candidates to `Best Takes/To Approve`. Keep only review MP4 files at the top level of that folder. Store posters and thumbnails in `Thumbnails/`, notes in `Notes/`, and superseded candidates in a recoverable `.trash/` folder. Promote only the exact watched file. Preserve its raw take and manifest. Delete obsolete versions only after approval and only after confirming that no approved file depends on them.

## 11. Control time and system load

For a known site, target three minutes or less from capture start to reviewed preview. Browser waits, failed selectors, repeated captures, voice changes, and manual review consume most of the time. FFmpeg rendering is usually not the main cost.

Run one browser capture at a time by default. Parallel browser captures can compete for CPU, network, site state, and the same account session. Parallelize safe work instead:

- route scouting in isolated contexts
- manifest drafting
- narration generation
- render variants in separate output folders
- frame extraction and mechanical QA

Add bounded capture concurrency later. Require isolated browser contexts, separate output locks, separate mutable site state, and measured CPU and memory limits.

## 12. Prompt template for an agent

```text
Produce a <count>-video <language> series for <product>.

Audience: <audience>
Each video outcome: <numbered list>
Safety stops: <actions that must never be confirmed>
Privacy: <elements to cover or omit>
Series treatment: <title, intro, outro, poster rules>

Voice: <voice and speaking rate>
Music: <style and BPM>
Camera: <static or exact approved bounded shots>
Delivery: 1920x1080, 30 fps, H.264, one reviewed MP4 per video

Before recording, map every route, stable selector, fallback selector,
visible postcondition, privacy selector, and safety stop. Prove one short
action sequence. Then use one preview capture per video and render all
corrections from that take. Stop and mark HOLD if any action, privacy,
thumbnail, audio, or final-frame gate cannot be verified.
```

Report only blockers, decisions, measured timings, and reviewed deliverables. Do not call a configured or rendered video finished.
