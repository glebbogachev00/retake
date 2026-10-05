# How to prompt an agent to use Retake

You do not need to write YAML or know browser automation. Tell the agent what the viewer should understand, then specify the production choices that matter.

## The short prompt

Use this when you want the agent to choose sensible defaults:

```text
Use Retake to record a Russian walkthrough of my product.
Show a new user creating a project and seeing it in the dashboard.
Use a calm female voice, light electronic music, a static camera,
and a branded title card. Deliver a reviewed 1920x1080 MP4.
Do not show account details. Stop before any paid action.
```

## The complete prompt

For a repeatable series, include these fields:

```text
Use Retake to produce <number> videos for <product>.
Audience: <who will watch>
Language: <language>
Outcome: <one visible result per video>
Recording type: <demo, launch, tutorial, bug proof, or docs clip>
Format: <landscape, square, vertical, or GIF>
Voice: <voice, tone, and pace>
Music: <none or style and energy>
Camera: <static or a few bounded zoom shots>
Branding: <intro, outro, thumbnail, colors, logo>
Privacy: <details to hide or screens to omit>
Safety stops: <actions that must never be confirmed>
Length: <target range>
Delivery: <resolution and files>
Before recording, map the routes and prove the first interaction.
Use one browser capture per video. Make voice, music, cards, pacing,
and format changes by re-rendering the same take. Review the exact final
MP4 for visible actions, private data, audio timing, and a clean ending.
Do not send a video that has not passed those checks.
```

## Choose the recording type


- **Demo:** Shows one workflow and its visible result. Use this for help content and client walkthroughs.

- **Launch:** Adds a branded opening, music, and a stronger ending. Use this for public product posts.

- **Tutorial:** Explains a task step by step. Keep one outcome per video.

- **Bug proof:** Reproduces a defect and holds on the evidence. Keep it short and literal.

- **Docs clip:** Produces a short MP4 or GIF for a README or help page.

- **Series:** Uses one locked visual and audio treatment across several workflows.

## Choose a format


- **Landscape:** 1920x1080 at 30 fps. Use for product tours, websites, YouTube, and desktop viewing.

- **Square:** 1080x1080 at 30 fps. Use for feed posts.

- **Vertical:** 1080x1920 at 30 fps. Use for Shorts and Reels.

- **GIF:** Use only for short silent documentation clips. MP4 is clearer and smaller for most UI demos.

Retake can render several formats from one approved browser take. Ask for all required formats before delivery, but do not ask the agent to re-record each format.

## Voice and narration

State the language, voice, tone, and pace separately. For example:

```text
Voice: Russian-capable female voice, calm but engaged, 8% faster than default.
Pronounce the brand as "Бинекс" in speech. Keep the official spelling on screen.
```

Ask the agent to synthesize and measure every line before final timing. A voice can be faster without becoming natural, so approve both pace and character. When comparing voices, keep the visuals and music identical.

## Music

Describe energy rather than naming a vague mood:

```text
Music: restrained electronic bed, 106 BPM, light rhythm and movement.
Keep it below the narration, continue it through the ending, and fade smoothly.
```

Say `Music: none` for a silent or documentation-first demo.

## Camera and zoom

Use `Camera: static` unless the interface is hard to read. When you need zoom, request bounded shots:

```text
Camera: use at most two gentle zoom shots. Ease in before the click,
hold through the result, then ease out once. No pulsing or locked zoom.
```

Do not ask for a zoom on every click. Cursor emphasis is usually enough.

## Branding and thumbnails

Describe one reusable system:

```text
Branding: use the product logo, dark blue background, and Russian title.
The opening frame and thumbnail must match. Use the same treatment for the outro.
Do not add safety or explanatory subtitles to the title card.
```

For a series, tell the agent to lock the approved template. Only the video number, title, and selected product image should change.

## Privacy and safe stopping points

Be explicit when the product contains accounts, money, or personal data:

```text
Hide email, phone, user ID, balances, notifications, addresses, QR codes,
order IDs, referral details, and payment or identity information.
Omit any screen that cannot be covered reliably.
Do not place a trade, start a transfer, launch a bot, or confirm a paid action.
Stop immediately before the final confirmation.
```

The agent should inspect navigation transitions as well as settled screens. Private data can flash while a new page loads.

## What a good agent run looks like

The agent should:


1. Map the pages, selectors, visible results, overlays, privacy regions, and forbidden controls.

2. Validate and dry-run the workflow before recording.

3. Record a short action proof that shows cursor approach, action, changed state, and readable hold.

4. Capture the browser once.

5. Re-render voice, music, cards, pacing, and alternate formats from that take.

6. Review the final MP4 from beginning to end.

7. Deliver only a video that passed action, privacy, branding, audio, and ending checks.

If a selector or page changed, the agent should repair that part of the workflow and rerun it. A copy, voice, music, pacing, card, or format change should not require another browser recording.

## Example: ten safe financial-product walkthroughs

```text
Use Retake to produce ten Russian walkthroughs of the product.
Each video must show one real interaction and one visible result.
Use a calm, engaged Russian-capable female voice at a natural brisk pace.
Use restrained electronic music around 108 BPM. Use a static camera.
Create a branded Russian intro, matching thumbnail, and smooth outro.
Deliver each video as a reviewed 1920x1080, 30 fps H.264 MP4.
Keep the account unfunded. Do not add payment details, complete identity
verification, execute an order, place a trade, start copy trading, launch
a bot, deposit, or withdraw funds. For transactional flows, stop before
final confirmation. Hide all account-specific and financial information.
Before recording the batch, map every route and state. Prove the first
interaction. Use one browser capture per video and re-render all production
changes from that take. Mark any video HOLD if its action, privacy, thumbnail,
voice timing, music ending, or final state cannot be verified.
```

## Before you approve a video

Check five things:


1. You can see the cursor, action, and result.

2. The title and thumbnail belong to this video.

3. The narration describes what is on screen at that moment.

4. No private or unsafe state appears, including during navigation.

5. The final sentence and music end smoothly.

If one check fails, ask for a correction from the existing take first. Ask for a new recording only when the browser interaction or page state must change.
