# Retake Agent Handoff

Read this file before Retake work. It is a project-specific supplement to `~/Documents/agent-team/PORTABLE-AGENT-TEAM-BRIEF.md`.

## Scope

Work only on Retake. Do not modify Capture or the portable team architecture.

## Current state

Retake already includes or documents:

- manifest-driven recording;
- validate, dry-run, run, render, check, and contact-sheet workflows;
- render-time scene markers and `nudge`;
- music support;
- launch and vertical presets;
- smart idle compression work;
- agent-shaped CLI and MCP installation path;
- output and take preservation rules.

Read the repository `AGENTS.md` and `BACKLOG.md` before changing code.

## Current next work

The current backlog lists these concrete items:

1. Mechanical caption checks for dead scenes.
2. Mechanical caption checks for captions that outlive their subject.
3. Mobile and device presets.
4. More efficient card rendering and browser reuse.
5. Voiceover from captions.
6. Typing rhythm and launch preset improvements.
7. Per-project workspaces later.

## Product conflict to resolve

The Capture board asks for demo transitions and animations. The Retake backlog says transitions, filters, and stock intros are deliberately refused because Retake is not becoming a video editor.

Do not implement transitions until Gleb chooses one of these directions:

- keep Retake deterministic and refuse editor-style transitions;
- add a narrow, code-defined transition primitive for a specific demo need.

## Existing UI request

The board says to remove the edit button and rename “Show in Finder” to “Show in Folder.” Search the current UI before acting. The repository search did not confirm that either label currently exists.

## Retake loop

Never go directly to a full recording:

```text
write or edit manifest
→ retake validate
→ retake dry
→ fix dry failures
→ preview or draft recording
→ read proof-log.md
→ retake check
→ final recording only after the flow passes
```

Use render instead of re-recording when only size, caption, speed, zoom, music, or scene placement changes.

## Verification

For code changes, run the relevant tests, typecheck, and build. For demo changes, include:

- the manifest used;
- dry-run result;
- output path;
- proof log;
- check result;
- contact sheet or rendered preview when visual quality matters.

Do not claim a recording works from the existence of an output file alone.
