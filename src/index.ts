/**
 * Post a deploy summary to Slack — or to the console when there is no token.
 *
 * THE CONSOLE FALLBACK IS THE POINT
 * ---------------------------------
 * With no `SLACK_BOT_TOKEN`, nothing is sent and the message is printed saying
 * exactly what WOULD have gone where. That is what makes this safe to call
 * unconditionally from a deploy script. The alternatives are both bad:
 *
 *   - throwing when credentials are absent means a laptop deploy fails on the
 *     reporting step, so people stop calling it;
 *   - silently doing nothing means you cannot tell "correctly inert" from
 *     "misconfigured in CI and posting nowhere" — and you find out weeks later
 *     when someone asks why the channel went quiet.
 *
 * A REPORTING FAILURE MUST NEVER FAIL A DEPLOY
 * --------------------------------------------
 * By the time this runs, the image is already serving traffic. A Slack outage
 * turning a live deploy into a red build would be a worse outcome than a
 * missing message, so every network error is caught and reported, never thrown.
 * `send()` returns an outcome rather than signalling by exception.
 */

/** What the smoke did. THREE states, and collapsing them loses the useful one. */
export type SmokeStatus = "passed" | "failed" | "skipped" | "crashed";

export interface DeploySummary {
  /** Lightsail service / product name, e.g. "stonedogcode". */
  service: string;
  /** Environment, e.g. "prod". */
  env: string;
  /** The version that shipped, without a leading v. */
  version?: string;
  /** The release tag, or absent when none was written. */
  tag?: string;
  /** The image the running deployment actually reports. */
  image?: string;
  /** The smoke's verdict. */
  smoke: SmokeStatus;
  /** Counts, when the suite produced them. */
  smokeCounts?: { passed: number; failed: number; skipped: number };
  /** Anything the operator must still do. */
  outstanding?: string[];
  /** A link to the run or the deployment. */
  url?: string;
}

export interface SendResult {
  /** True when a real message reached Slack. */
  sent: boolean;
  /** True when there was no token and the message was printed instead. */
  dryRun: boolean;
  /** Set when a send was attempted and failed. Never thrown. */
  error?: string;
  /** Where it went, or would have gone. */
  channel: string;
  /** The rendered text, so a caller can assert on it. */
  text: string;
  /**
   * Slack's own message id for a successful post.
   *
   * This is the proof, and it is why it is surfaced rather than discarded.
   * `sent: true` is this library's opinion; `ts` is Slack's — it comes back in
   * the `chat.postMessage` response and identifies a message that now exists.
   */
  ts?: string;
}

export const DEFAULT_CHANNEL = "#deploy";

/**
 * How much pre-rendered text a caller may post.
 *
 * A deploy summary is a SUMMARY, never a log. A run's console output pasted
 * into a channel is how a channel gets muted, and it is also how internal
 * hostnames and stack traces end up somewhere searchable by a wide audience.
 * Callers with a richer summary than `render()` produces are the reason
 * `sendText` exists — but "richer" means a better summary, not a transcript.
 *
 * Over the limit is TRUNCATED and SAID SO, not silently dropped: a message
 * that quietly loses its last half is worse than one that admits it.
 */
export const MAX_TEXT_LINES = 40;
export const MAX_TEXT_CHARS = 3500;

const SLACK_API = "https://slack.com/api";

/** Read at call time, never cached at import — a test sets this after import. */
function token(): string | undefined {
  const raw = process.env.SLACK_BOT_TOKEN?.trim();
  return raw ? raw : undefined;
}

export function configured(): boolean {
  return token() !== undefined;
}

function normaliseChannel(channel?: string): string {
  const c = channel?.trim();
  if (!c) return DEFAULT_CHANNEL;
  // A raw channel id passes through untouched: they start with C/G/D, carry no
  // '#', and are upper-case. Prefixing one yields channel_not_found, an error
  // that reads like a permissions problem and is not.
  if (/^[CGD][A-Z0-9]+$/.test(c)) return c;
  return c.startsWith("#") ? c : `#${c}`;
}

/**
 * The icon for a verdict.
 *
 * `skipped` and `crashed` are deliberately NOT the same as `failed`. A skipped
 * smoke verified nothing, and a crashed one means the suite never produced a
 * verdict at all — sending someone to debug a test failure that did not happen
 * is how an infrastructure outage gets misdiagnosed.
 */
function icon(status: SmokeStatus): string {
  switch (status) {
    case "passed":
      return "✅";
    case "failed":
      return "❌";
    case "skipped":
      return "⚠️";
    case "crashed":
      return "💥";
  }
}

function verdictLine(s: DeploySummary): string {
  const c = s.smokeCounts;
  const counts = c ? `  (${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped)` : "";
  switch (s.smoke) {
    case "passed":
      return `${icon(s.smoke)} smoke passed${counts} — deployed AND verified`;
    case "failed":
      return `${icon(s.smoke)} smoke FAILED${counts} — the image is live regardless; nothing rolled back`;
    case "skipped":
      return `${icon(s.smoke)} smoke SKIPPED — this release is deployed but NOT verified`;
    case "crashed":
      return `${icon(s.smoke)} smoke never produced a verdict (timeout or infrastructure error) — deployed, NOT verified, and the failure is probably not in the tests`;
  }
}

/**
 * Render the summary.
 *
 * The order is the deploy-summary contract: what shipped, then what was run and
 * what passed, then what is verified vs merely deployed, then what is
 * outstanding. A reader must not have to infer the verdict from the absence of
 * bad news.
 */
export function render(s: DeploySummary): string {
  const lines: string[] = [];
  const version = s.version ? `v${s.version}` : "v?";
  lines.push(`*${s.service}* ${version} → ${s.env}`);
  lines.push(verdictLine(s));

  const facts: string[] = [];
  facts.push(s.tag ? `tag \`${s.tag}\`` : "*no tag written* — nothing records what shipped");
  if (s.image) facts.push(`image \`${s.image}\``);
  lines.push(facts.join("  ·  "));

  if (s.outstanding?.length) {
    lines.push("Outstanding:");
    for (const item of s.outstanding) lines.push(`  • ${item}`);
  }
  if (s.url) lines.push(`<${s.url}|deployment>`);
  return lines.join("\n");
}

/**
 * Send the summary, or print it when there is no token.
 *
 * Never throws. See the file header: the image is already live by the time this
 * runs, so a reporting failure must not be able to fail the deploy.
 */
export async function send(
  summary: DeploySummary,
  opts: { channel?: string; stream?: NodeJS.WriteStream } = {},
): Promise<SendResult> {
  return post(render(summary), opts);
}

/**
 * The transport, shared by `send` and `sendText`.
 *
 * One implementation of the console fallback and the never-throwing contract:
 * two copies would drift, and the half that drifted would be the one nobody
 * exercised.
 */
async function post(
  text: string,
  opts: { channel?: string; stream?: NodeJS.WriteStream } = {},
): Promise<SendResult> {
  const channel = normaliseChannel(opts.channel ?? process.env.SLACK_DEFAULT_CHANNEL);
  // stderr, so this cannot corrupt a deploy script's machine-readable stdout.
  const stream = opts.stream ?? process.stderr;

  const bearer = token();
  if (!bearer) {
    stream.write(`[slack:dry-run] post -> ${channel}\n`);
    for (const line of text.split("\n")) stream.write(`  ${line}\n`);
    return { sent: false, dryRun: true, channel, text };
  }

  try {
    const response = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ channel, text }),
    });
    const body = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
    if (!body.ok) {
      const error = body.error ?? `http ${response.status}`;
      stream.write(`[slack] chat.postMessage rejected: ${error}\n`);
      return { sent: false, dryRun: false, error, channel, text };
    }
    // SAY SO. A successful post used to print nothing, which made it
    // indistinguishable from a call that never happened — and that is exactly
    // what it turned out to be indistinguishable from: confirming the first
    // production deploy took a human opening Slack, because the log offered
    // only silence. Slack hands back a message id; reporting it turns "no error
    // appeared" into evidence a deploy log actually carries.
    stream.write(`[slack] posted to ${channel} (ts ${body.ts ?? "unknown"})\n`);
    return { sent: true, dryRun: false, channel, text, ts: body.ts };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    stream.write(`[slack] could not reach Slack: ${error}\n`);
    return { sent: false, dryRun: false, error, channel, text };
  }
}


/**
 * Post text the caller rendered itself.
 *
 * `send()` renders from a `DeploySummary`, which is the right shape for most
 * callers. Some already build a better summary than this package can — reading
 * the image and deployment state back from the cloud provider, the version from
 * the running container, the changes from git — and forcing that through a
 * fixed struct would throw most of it away.
 *
 * The console fallback, the never-throwing contract and the truncation guard
 * are identical to `send()`. Only the rendering moves to the caller.
 */
export async function sendText(
  text: string,
  opts: { channel?: string; stream?: NodeJS.WriteStream } = {},
): Promise<SendResult> {
  return post(clamp(text), opts);
}

/** Trim to the limits, and say so in the message when it bites. */
export function clamp(text: string): string {
  let out = text.replace(/\s+$/, "");
  const lines = out.split("\n");
  let trimmed = false;

  if (lines.length > MAX_TEXT_LINES) {
    out = lines.slice(0, MAX_TEXT_LINES).join("\n");
    trimmed = true;
  }
  if (out.length > MAX_TEXT_CHARS) {
    out = out.slice(0, MAX_TEXT_CHARS);
    trimmed = true;
  }
  return trimmed
    ? `${out}\n… truncated — this is a summary, not a log. The full output is in the deploy log.`
    : out;
}
