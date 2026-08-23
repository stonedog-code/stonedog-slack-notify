/**
 * Every assertion here is about the bytes a caller would see or send.
 *
 * The interesting behaviours are the ones a deploy depends on and that fail
 * silently if they regress: the console fallback, the three-plus-one smoke
 * states staying distinct, and send() never throwing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import {
  DEFAULT_CHANNEL,
  MAX_TEXT_CHARS,
  MAX_TEXT_LINES,
  clamp,
  configured,
  render,
  send,
  sendText,
  type DeploySummary,
} from "../src/index.ts";

/** A stand-in for stderr that keeps what was written. */
function capture() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  }) as unknown as NodeJS.WriteStream;
  return { stream, text: () => chunks.join("") };
}

const base: DeploySummary = { service: "stonedogcode", env: "prod", smoke: "passed" };

function withoutToken<T>(fn: () => T): T {
  const saved = process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_BOT_TOKEN;
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env.SLACK_BOT_TOKEN = saved;
  }
}

// ── the console fallback ─────────────────────────────────────────────────────

test("with no token it sends nothing and prints what it would have sent", async () => {
  const out = capture();
  const result = await withoutToken(() =>
    send({ ...base, version: "1.2.3", tag: "prod-web-2026.08.22-001" }, { stream: out.stream }),
  );

  assert.equal(result.sent, false);
  assert.equal(result.dryRun, true);
  assert.equal(result.channel, DEFAULT_CHANNEL);

  const printed = out.text();
  assert.match(printed, /dry-run/); // it is inert
  assert.match(printed, /#deploy/); // WHICH channel
  assert.match(printed, /stonedogcode/); // WHAT would have been sent
  assert.match(printed, /1\.2\.3/);
});

test("configured() tracks the token and is read at call time", () => {
  withoutToken(() => assert.equal(configured(), false));
  process.env.SLACK_BOT_TOKEN = "xoxb-not-real";
  assert.equal(configured(), true);
  delete process.env.SLACK_BOT_TOKEN;
  assert.equal(configured(), false);
});

test("a whitespace-only token counts as absent", () => {
  process.env.SLACK_BOT_TOKEN = "   ";
  assert.equal(configured(), false);
  delete process.env.SLACK_BOT_TOKEN;
});

// ── the smoke verdicts must stay distinct ────────────────────────────────────

test("passed says deployed AND verified", () => {
  assert.match(render({ ...base, smoke: "passed" }), /deployed AND verified/);
});

test("a FAILED smoke says the image is live anyway", () => {
  // The single most important sentence in the message. A red smoke rolls
  // nothing back, and a reader who assumes otherwise leaves a broken release up.
  const text = render({ ...base, smoke: "failed" });
  assert.match(text, /FAILED/);
  assert.match(text, /live regardless/);
});

test("a SKIPPED smoke is never reported as success", () => {
  const text = render({ ...base, smoke: "skipped" });
  assert.match(text, /NOT verified/);
  // The claim that must never appear on a skipped smoke. Asserted as the exact
  // success phrase rather than a clever negative lookahead — the first version
  // of this line used one, and it matched the "verified" inside "NOT verified".
  assert.doesNotMatch(text, /deployed AND verified/);
});

test("a CRASHED smoke is distinguished from a failing one", () => {
  // Gemini's finding, and the reason this is a fourth state rather than a
  // synonym for failed: a timeout with no report is not a test failure, and
  // reporting it as one sends people to debug the wrong system.
  const text = render({ ...base, smoke: "crashed" });
  assert.match(text, /never produced a verdict/);
  assert.match(text, /not in the tests/);
});

test("all four verdicts render differently", () => {
  const seen = new Set(
    (["passed", "failed", "skipped", "crashed"] as const).map((smoke) =>
      render({ ...base, smoke }),
    ),
  );
  assert.equal(seen.size, 4, "two verdicts rendered identically, so one is invisible");
});

// ── what shipped ─────────────────────────────────────────────────────────────

test("a missing tag is called out, not silently omitted", () => {
  // An untagged live release is the single most important thing to surface:
  // a tag exists so a rollback can find what shipped.
  assert.match(render(base), /no tag written/);
});

test("counts are included when known", () => {
  const text = render({ ...base, smokeCounts: { passed: 11, failed: 0, skipped: 2 } });
  assert.match(text, /11 passed, 0 failed, 2 skipped/);
});

test("outstanding items are listed", () => {
  const text = render({ ...base, outstanding: ["rotate the smoke account"] });
  assert.match(text, /Outstanding:/);
  assert.match(text, /rotate the smoke account/);
});

// ── it must never fail a deploy ──────────────────────────────────────────────

test("a network failure is reported, never thrown", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-not-real";
  const saved = globalThis.fetch;
  globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const out = capture();
  try {
    const result = await send(base, { stream: out.stream });
    assert.equal(result.sent, false);
    assert.equal(result.dryRun, false);
    assert.match(result.error ?? "", /ECONNREFUSED/);
    assert.match(out.text(), /could not reach Slack/);
  } finally {
    globalThis.fetch = saved;
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test("a Slack rejection is reported, never thrown", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-not-real";
  const saved = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
    )) as typeof fetch;
  const out = capture();
  try {
    const result = await send(base, { stream: out.stream });
    assert.equal(result.sent, false);
    assert.equal(result.error, "channel_not_found");
  } finally {
    globalThis.fetch = saved;
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test("a successful post SAYS SO, with Slack's own message id", async () => {
  // The whole point. Silence on success is indistinguishable from a call that
  // never happened — which is precisely what it turned out to be
  // indistinguishable from in production: confirming the first real deploy took
  // a human opening Slack, because the log offered nothing either way.
  process.env.SLACK_BOT_TOKEN = "xoxb-not-real";
  const saved = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, ts: "1787441464.148339" }), { status: 200 }),
    )) as typeof fetch;
  const out = capture();
  try {
    const result = await send(base, { stream: out.stream });
    assert.equal(result.sent, true);
    assert.equal(result.ts, "1787441464.148339", "Slack's message id must be surfaced, not discarded");
    assert.match(out.text(), /posted to #deploy/);
    assert.match(out.text(), /1787441464\.148339/, "the id is the evidence — it must be in the output");
  } finally {
    globalThis.fetch = saved;
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test("a successful post reports sent", async () => {
  process.env.SLACK_BOT_TOKEN = "xoxb-not-real";
  const saved = globalThis.fetch;
  let sentBody: string | undefined;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    sentBody = String(init.body);
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  }) as unknown as typeof fetch;
  try {
    const result = await send({ ...base, version: "9.9.9" }, { channel: "releases" });
    assert.equal(result.sent, true);
    assert.equal(result.channel, "#releases", "a bare name gains its #");
    assert.match(sentBody ?? "", /9\.9\.9/);
  } finally {
    globalThis.fetch = saved;
    delete process.env.SLACK_BOT_TOKEN;
  }
});

test("a raw channel id passes through without a #", async () => {
  // Prefixing one yields channel_not_found, which reads like a permissions
  // problem and is not.
  const out = capture();
  const result = await withoutToken(() => send(base, { channel: "C0123ABC", stream: out.stream }));
  assert.equal(result.channel, "C0123ABC");
});

// ── pre-rendered text ────────────────────────────────────────────────────────
//
// For callers that already build a better summary than render() can. The
// console fallback and the never-throwing contract must be identical to send();
// only the rendering moves.

test("sendText posts the caller's own text verbatim", async () => {
  const out = capture();
  const result = await withoutToken(() =>
    sendText("*optima* v2.1.0 → prod\nsomething only optima knows", { stream: out.stream }),
  );
  assert.equal(result.dryRun, true);
  assert.match(result.text, /something only optima knows/);
  assert.match(out.text(), /dry-run/);
});

test("a summary is not a log: over 40 lines is truncated and says so", () => {
  // The guard exists because a run's console output pasted into a channel is
  // how a channel gets muted — and how internal detail reaches a searchable,
  // wide-audience place.
  const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const out = clamp(long);
  assert.ok(out.split("\n").length <= MAX_TEXT_LINES + 1, "did not trim to the line limit");
  assert.match(out, /truncated — this is a summary, not a log/);
  assert.match(out, /line 0/, "kept the beginning");
  assert.doesNotMatch(out, /line 99/, "kept the end it should have dropped");
});

test("a very long single line is truncated by characters too", () => {
  const wide = "x".repeat(MAX_TEXT_CHARS * 2);
  const out = clamp(wide);
  assert.ok(out.length < MAX_TEXT_CHARS + 200);
  assert.match(out, /truncated/);
});

test("text within the limits is passed through untouched", () => {
  // The guard must not add noise to the normal case.
  const fine = "a\nb\nc";
  assert.equal(clamp(fine), fine);
});
