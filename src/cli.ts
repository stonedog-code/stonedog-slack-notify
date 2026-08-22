#!/usr/bin/env node
/**
 * `stonedog-slack-notify` — the interface a deploy script calls.
 *
 * Every product in this fleet deploys through a bash `deploy_web.sh`, so the
 * shell is the real consumer even though the package is TypeScript. That is why
 * this exists as a `bin` rather than only a library: `release_finish()` should
 * be able to call one line and pass the variables it already has.
 *
 *   stonedog-slack-notify \
 *     --service "$SERVICE_NAME" --env "$DEPLOY_ENV" \
 *     --version "$TARGET_VERSION" --tag "$RELEASE_TAG" \
 *     --smoke "$SMOKE_STATUS"
 *
 * IT ALWAYS EXITS 0.
 * ------------------
 * By the time it runs the image is already serving traffic. A non-zero exit
 * here would turn a live deploy into a red build over a chat message, and in a
 * chain that ends `release_finish` the exit status belongs to the SMOKE, not to
 * the reporting. Callers should still write `|| true` for the same reason they
 * do around `smoke` and `tag_release` — belt and braces on the thing that must
 * not break the chain.
 */

import { send, type DeploySummary, type SmokeStatus } from "./index.js";

const SMOKE_VALUES: readonly SmokeStatus[] = ["passed", "failed", "skipped", "crashed"];

function usage(): string {
  return [
    "stonedog-slack-notify — post a deploy summary to Slack",
    "",
    "  --service <name>     required",
    "  --env <name>         required (prod, dev, …)",
    "  --version <x.y.z>",
    "  --tag <tag>          omit when no tag was written; the message says so",
    "  --image <image>      what the RUNNING deployment reports, not what was built",
    `  --smoke <status>     one of: ${SMOKE_VALUES.join(", ")}   (default: skipped)`,
    "  --counts p,f,s       smoke counts, e.g. 11,0,2",
    "  --outstanding <text> repeatable",
    "  --url <url>",
    "  --channel <#name>    default #deploy, or $SLACK_DEFAULT_CHANNEL",
    "",
    "With no SLACK_BOT_TOKEN it prints what it would have sent, and where.",
  ].join("\n");
}

function parse(argv: string[]): { summary: DeploySummary; channel?: string } | string {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const service = get("--service");
  const env = get("--env");
  if (!service || !env) return "both --service and --env are required";

  const rawSmoke = get("--smoke") ?? "skipped";
  if (!SMOKE_VALUES.includes(rawSmoke as SmokeStatus)) {
    // Refused rather than coerced. Mapping an unknown verdict onto "failed"
    // would report a test failure that may not have happened; onto "passed"
    // would claim a verification that certainly did not.
    return `--smoke must be one of ${SMOKE_VALUES.join(", ")} (got "${rawSmoke}")`;
  }

  let smokeCounts: DeploySummary["smokeCounts"];
  const rawCounts = get("--counts");
  if (rawCounts) {
    const parts = rawCounts.split(",").map((n) => Number(n.trim()));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      return `--counts must be "passed,failed,skipped" (got "${rawCounts}")`;
    }
    smokeCounts = { passed: parts[0]!, failed: parts[1]!, skipped: parts[2]! };
  }

  const outstanding: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--outstanding" && argv[i + 1]) outstanding.push(argv[i + 1]!);
  }

  return {
    channel: get("--channel"),
    summary: {
      service,
      env,
      version: get("--version") || undefined,
      tag: get("--tag") || undefined,
      image: get("--image") || undefined,
      smoke: rawSmoke as SmokeStatus,
      smokeCounts,
      outstanding: outstanding.length ? outstanding : undefined,
      url: get("--url") || undefined,
    },
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const parsed = parse(argv);
  if (typeof parsed === "string") {
    // Still exit 0 — see the file header. A usage mistake in a deploy script
    // must be loud, not fatal.
    process.stderr.write(`stonedog-slack-notify: ${parsed}\n\n${usage()}\n`);
    return;
  }

  const result = await send(parsed.summary, { channel: parsed.channel });
  if (result.error) {
    process.stderr.write(`stonedog-slack-notify: the summary was NOT posted (${result.error}).\n`);
  }
}

await main();
process.exit(0);
