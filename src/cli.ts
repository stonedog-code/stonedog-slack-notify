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

import { readFileSync } from "node:fs";

import { send, sendText, type DeploySummary, type SmokeStatus } from "./index.js";

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
    "  --text-file <path>   post this text INSTEAD of rendering from the flags.",
    "                       Use '-' for stdin. For callers that already build a",
    "                       better summary than this tool can. It is a summary,",
    "                       not a log: over 40 lines is truncated and says so.",
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

  // Pre-rendered text short-circuits everything: the caller has already decided
  // what the message says, so none of the summary flags apply.
  const textFileIdx = argv.indexOf("--text-file");
  if (textFileIdx >= 0) {
    const path = argv[textFileIdx + 1];
    if (!path) {
      process.stderr.write("stonedog-slack-notify: --text-file needs a path (or - for stdin)\n");
      return;
    }
    let body: string;
    try {
      body = readFileSync(path === "-" ? 0 : path, "utf8");
    } catch (cause) {
      process.stderr.write(
        `stonedog-slack-notify: could not read ${path}: ${cause instanceof Error ? cause.message : cause}\n`,
      );
      return;
    }
    if (!body.trim()) {
      // An empty summary posted as an empty message is worse than none: it
      // reads as "the deploy said nothing" rather than "something went wrong".
      process.stderr.write("stonedog-slack-notify: --text-file was empty; nothing posted\n");
      return;
    }
    const channelIdx = argv.indexOf("--channel");
    const result = await sendText(body, {
      channel: channelIdx >= 0 ? argv[channelIdx + 1] : undefined,
    });
    if (result.error) {
      process.stderr.write(`stonedog-slack-notify: the summary was NOT posted (${result.error}).\n`);
    }
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
