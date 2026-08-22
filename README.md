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

## Creating the Slack app

You need a **bot token** (`xoxb-…`). It comes from an app you create once per
workspace.

1. **https://api.slack.com/apps → Create New App → From scratch.** Name it
   something a reader will recognise in the channel — the app name is what
   appears as the author of every message — and pick the workspace that holds
   your target channel.
2. **OAuth & Permissions → Scopes → Bot Token Scopes → Add an OAuth Scope.**
   Add **`chat:write`**. That is the only scope this package needs.

   Add **`chat:write.public`** *only* if you would rather not invite the bot to
   each channel. It lets the app post to any public channel without being a
   member, which is convenient and a broader grant than most deploys need.
3. **Install to Workspace**, approve, and copy the **Bot User OAuth Token** —
   the one starting `xoxb-`.

   Not the App-Level token (`xapp-`, for Socket Mode) and not the User token
   (`xoxp-`, which acts as *you*). Only `xoxb-` is right here.
4. **Invite the bot to the channel:** in Slack, `/invite @YourAppName` in
   `#deploy`. Skipping this without `chat:write.public` gives
   `not_in_channel` — an error that reads like a permissions problem and is
   really a missing invite.

### Rotating or revoking

**OAuth & Permissions → Rotate** (or *Revoke All OAuth Tokens*) invalidates the
old token immediately. Anything still holding it starts printing instead of
posting, which is visible rather than silent — but nothing warns you, so update
the store in the same change.

## Configuring

Two environment variables:

| | |
|---|---|
| `SLACK_BOT_TOKEN` | the `xoxb-…` token. **Absent ⇒ print, do not send** |
| `SLACK_DEFAULT_CHANNEL` | optional, default `#deploy` |

### Where to keep the token

**Not in the blob that becomes your container's environment.** A running web app
has no business holding a Slack token, and mixing deploy-time credentials with
runtime config widens the blast radius for nothing.

In this fleet the token lives in a dedicated `<project>/deploy` secret that only
the deploying machine reads:

```bash
# zsh-safe: `read -p` means "read from coprocess" in zsh, so a bash-style
# prompt silently leaves the variable UNSET and stores an empty token.
printf 'Paste the xoxb- token: '
stty -echo; read -r TOKEN; stty echo; printf '\n'

# Refuse anything that is not a bot token. The failure worth guarding against
# is not a typo — it is storing an EMPTY value and getting a success payload.
if [[ "$TOKEN" != xoxb-* ]]; then
  echo "refusing: expected an xoxb- token, got ${#TOKEN} chars" >&2
else
  aws secretsmanager create-secret \
    --profile <admin-profile> --region <region> \
    --name <project>/deploy \
    --description "Deploy-time credentials. NOT injected into the container." \
    --kms-key-id alias/<project>-prod \
    --secret-string "$(jq -nc --arg t "$TOKEN" \
        '{SLACK_BOT_TOKEN:$t, SLACK_DEFAULT_CHANNEL:"#deploy"}')"
fi
unset TOKEN
```

Use `put-secret-value` instead of `create-secret` if the secret already exists.

## Confirming it works

Four checks, cheapest first. Each one rules out a different failure.

### 1. The message renders — no token, no network

```bash
npx stonedog-slack-notify --service demo --env prod --version 1.0.0 --smoke passed
```

```
[slack:dry-run] post -> #deploy
  *demo* v1.0.0 → prod
  ✅ smoke passed — deployed AND verified
  *no tag written* — nothing records what shipped
```

`dry-run` here means **no token was found**. If you expected it to post, the
token is not reaching the process — which is the next check.

### 2. The token is stored, and readable by the identity that deploys

Print the *shape*, never the value:

```bash
aws secretsmanager get-secret-value --profile <deploy-profile> --region <region> \
  --secret-id <project>/deploy --query SecretString --output text \
| python3 -c "
import json,sys
d=json.load(sys.stdin); t=d.get('SLACK_BOT_TOKEN','')
print('token length:', len(t), '| xoxb prefix:', t.startswith('xoxb-'))
print('channel:', d.get('SLACK_DEFAULT_CHANNEL'))
"
```

Expect a length around 55–60 and `True`. **A length of 0 is the failure this
check exists for** — a secret can be created with an empty value and report
success.

Read it as the **deploy** identity, not the admin one. The read path is what a
missing grant breaks, and an admin who can read it proves nothing about the
machine that actually runs the deploy.

### 3. It really posts

```bash
SLACK_BOT_TOKEN=$(aws secretsmanager get-secret-value --profile <deploy-profile> \
  --region <region> --secret-id <project>/deploy --query SecretString --output text \
  | jq -r .SLACK_BOT_TOKEN) \
npx stonedog-slack-notify --service demo --env prod --version 0.0.0 \
  --smoke skipped --outstanding "this is a test message, ignore it"
```

No `[slack:dry-run]` line and no error means it posted. Look in the channel.

Common failures, and what they actually mean:

| Slack error | Cause |
|---|---|
| `not_in_channel` | the bot was never invited, and you did not grant `chat:write.public` |
| `channel_not_found` | wrong name, a private channel, or a `#` on a raw channel id |
| `invalid_auth` | token revoked, rotated, or a `xoxp-`/`xapp-` token by mistake |
| `missing_scope` | `chat:write` was never added, or the app was not reinstalled after adding it |

### 4. A real deploy reports

Run a deploy and watch the channel. **Post the unhappy path deliberately at
least once** — a `--smoke failed` message is the one you actually need to
trust, and it is the one nobody ever tests.

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
