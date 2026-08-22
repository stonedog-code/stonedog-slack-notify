# @stonedogcode/slack-notify

Post a deploy summary to Slack — or to the console when no token is configured.

```bash
stonedog-slack-notify \
  --service stonedogcode --env prod \
  --version 1.4.2 --tag prod-web-2026.08.22-001 \
  --image stonedogcode.web.42 \
  --smoke passed --counts 11,0,2
```

```
✅ smoke passed  (11 passed, 0 failed, 2 skipped) — deployed AND verified
tag `prod-web-2026.08.22-001`  ·  image `stonedogcode.web.42`
```

## Why it exists

A deploy is the one action whose effects nobody can see from the transcript.
"Deployed ✅" tells a reader nothing they can act on. This posts the summary a
person actually needs: what shipped, whether it was verified, and what is left.

## Install

```bash
npm install --save-dev @stonedogcode/slack-notify
```

Set `SLACK_BOT_TOKEN` (scope: `chat:write`) and optionally
`SLACK_DEFAULT_CHANNEL` (default `#deploy`).

## Four design decisions worth knowing before changing it

### 1. With no token it prints instead of sending

That fallback is the design, not a debugging convenience — it is what makes the
call safe to put in a deploy script unconditionally. The alternatives are both
worse: throwing means a laptop deploy fails on its reporting step, so people
stop calling it; silently doing nothing means you cannot tell *correctly inert*
from *misconfigured in CI and posting nowhere*, and you find out weeks later
when someone asks why the channel went quiet.

Output goes to **stderr**, so it cannot corrupt a deploy script's stdout.

### 2. A reporting failure can never fail a deploy

By the time this runs the image is already serving traffic. A Slack outage
turning a live deploy into a red build would be worse than a missing message, so
`send()` catches every network error and returns an outcome instead of throwing,
and **the CLI always exits 0**. In a chain ending `release_finish`, the exit
status belongs to the smoke — not to the chat message.

### 3. The smoke has FOUR verdicts, and collapsing them loses the useful ones

| | Means |
|---|---|
| `passed` | deployed **and** verified |
| `failed` | the suite ran and failed — **the image is live regardless; nothing rolled back** |
| `skipped` | deployed but **not verified**. Never reported as success |
| `crashed` | the suite never produced a verdict — a timeout or infrastructure error |

`crashed` is separate from `failed` deliberately. A timeout with no report XML is
not a test failure, and reporting it as one sends engineers to investigate the
wrong system. An unrecognised `--smoke` value is **refused, not coerced**:
mapping it onto `failed` would report a failure that may not have happened, and
onto `passed` would claim a verification that certainly did not.

### 4. A missing tag is stated, not omitted

An untagged live release is the single most important thing to surface — a tag
exists so a rollback can find what shipped. With no `--tag` the message says
*"no tag written — nothing records what shipped"* rather than quietly leaving
the line out.

## Wiring it into `deploy_web.sh`

Every product in this fleet ends its chain in a bash `release_finish()`, which
already runs the smoke and writes the tag without letting either abort the run.
The notifier goes in the same place, on the same terms:

```bash
release_finish() {
    smoke || true
    tag_release || true

    # Unconditional, exactly like tag_release. A summary that only posts on the
    # happy path is missing precisely when someone needs it — the failure
    # NEH-126 removed, where a red smoke silently skipped the release record.
    npx --no-install stonedog-slack-notify \
        --service "$SERVICE_NAME" --env "$DEPLOY_ENV" \
        --version "$TARGET_VERSION" --tag "$RELEASE_TAG" \
        --smoke "$SMOKE_STATUS" || true
    ...
}
```

`--no-install` keeps it pinned to the lockfile: a deploy must not resolve an
unpinned package from the network.

## Testing

```bash
npm run gate     # typecheck + tests + build
```

15 tests. **Non-vacuity checked in both directions** — four defects were planted
and each was caught by exactly one named test, with the tree back to 15 passing
after every restore:

| Planted | Caught by |
|---|---|
| the dry-run path goes silent | `with no token it sends nothing and prints what it would have sent` |
| a skipped smoke reported as verified | `a SKIPPED smoke is never reported as success` |
| `crashed` collapsed into `failed` | `a CRASHED smoke is distinguished from a failing one` |
| a network error thrown rather than caught | `a network failure is reported, never thrown` |

There is also a test asserting all four verdicts render *differently*, so a
future edit cannot quietly make one of them invisible.

**No E2E tier**, and it would need a real Slack workspace. The `send()` path is
covered against a stubbed `fetch` at the payload level; that the workspace
accepts the payload is unproven here.
