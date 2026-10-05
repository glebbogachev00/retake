/** A failed first draft must say why, as something the person can do. It
    used to say "the details above show what failed" above nothing, while
    the real reason was an expired sign-in. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, operatorFailure } from "../src/operator/run.js";

test("an expired sign-in says to sign in again, with the command", () => {
  const m = operatorFailure("claude-code", "Failed to authenticate: OAuth session expired and could not be refreshed");
  assert.match(m, /Claude Code needs you to sign in again/);
  assert.match(m, /run `claude auth login`/);
  assert.match(operatorFailure("codex", "401 Unauthorized"), /`codex login`/);
});

test("a usage limit, and anything else, says what the agent said", () => {
  assert.match(operatorFailure("claude-code", "You've hit your usage limit"), /usage limit/);
  assert.match(operatorFailure("codex", "the app did not start on :3000"), /stopped before the demo was ready: the app did not start/);
  assert.match(operatorFailure("codex", ""), /without saying why/);
});

test("the agent runs as the person: their user, not just HOME and PATH, and no borrowed Claude sign-in", () => {
  const saved = { ...process.env };
  process.env.USER = "someone"; process.env.LOGNAME = "someone"; process.env.CLAUDECODE = "1"; process.env.ANTHROPIC_API_KEY = "borrowed";
  try {
    const env = agentEnv();
    // On a Mac the Keychain entry holding the sign-in is looked up by user.
    assert.equal(env.USER, "someone");
    assert.equal(env.LOGNAME, "someone");
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.ok(env.PATH);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
