# dsh-retry

A retry executor plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) model requests: fixed-schedule retries, tuned for relay endpoints and unstable upstreams.

## Quick start

```bash
dsh plugin --profile web add github:imrcpan/dsh-retry
```

DeepSeek Harness retries failed model requests at the agent step boundary. The bundled executor (`@deepseek-ai/dsh-llm-retry`) takes its wait from a provider `retryPolicy` that only exposes exponential backoff (`initialDelayMs`, `maxDelayMs`, `jitterRatio`). This plugin replaces that curve with an explicit schedule:

| retry | 1 | 2 | 3 | 4 | 5 | 6 and later |
| --- | --- | --- | --- | --- | --- | --- |
| wait | 2s | 5s | 5s | 5s | 10s | 20s, unlimited |

A retried step is re-run inside the same open turn against the same durable history, so no partial answer is duplicated and the model never sees the retry.

## Built for relay and pooled upstreams

A relay endpoint is a third-party API proxy that fans one key out across a pool
of upstream accounts. It fails per account, not per request: a 401, an exhausted
quota or a 404 on one backend says nothing about the next attempt, and a public
gateway in front of the pool adds 5xx pages of its own. This executor is tuned
for that deployment and for unstable networks:

- **Per-account failures are retried.** `AUTH`, `QUOTA`, `ACCOUNT_QUOTA`,
  `ACCOUNT_TOKEN_INVALID` and `INVALID_CREDENTIAL` are retried, and the
  `HTTP_*` prefix covers every unclassified 4xx, so `HTTP_404` is repeated
  instead of ending the turn.
- **Gateway noise is retried.** Cloudflare and proxy 5xx answers classify as
  `SERVER`, including HTML error pages that never parse as JSON.
- **Corrupt streams are retried.** A broken SSE frame classifies as
  `MALFORMED_RESPONSE`.
- **Waits stay short and predictable.** 2s, 5s, 5s, 5s, 10s, then every 20s
  without limit, so a short wobble costs seconds instead of an exponential climb
  toward a ceiling.
- **No duplicated output.** Recovery re-runs the step against the durable
  history, so a retried request never repeats a half-finished answer.

The executor does not rotate accounts by itself: a retry only re-issues the
request, so the relay has to select a different upstream for the next attempt.

## Why a separate executor

- Fixed delays: 2s, 5s, 5s, 5s, 10s, then a steady 20s tail instead of exponential growth.
- One unlimited tail, for upstreams that eventually recover.
- Prefix matching for failure-code families, so `HTTP_*` covers unclassified 4xx statuses such as `HTTP_404`.
- Standard `llm/retry` events, so the Chat retry status row and the Trajectory panel keep working.

## Requirements

- DeepSeek Harness `0.2.1-rc.5` (other releases may differ).
- Node.js `>=20.3`, which provides `AbortSignal.any`.

## Install

The package is a DSH bundle: `package.json` declares `dsh.bundle.patch`, so the
standard install also mounts the executor and retires the bundled one. No
hand-written patch is required.

```bash
dsh plugin --profile web add github:imrcpan/dsh-retry
```

Restart the profile afterwards; the composition is read at boot. The row then
appears under Plugins, where its `config` is editable.

The shipped layer ([cordis.patch.yml](./cordis.patch.yml)) inserts the executor
and disables `llm-retry`:

```yaml
- insert:
    - id: dsh-retry
      name: "dsh-retry"
      config:
        schedule: [2000, 5000, 5000, 5000, 10000]
        tailDelayMs: 20000
        retryableCodes: [ ... ]   # full list in cordis.patch.yml
- id: llm-retry
  disabled: true
```

Disabling `llm-retry` matters: two mounted executors would compete for the same
failure and both write retry chain state. Keep the row disabled if the profile
overrides it.

### Install from a checkout

Install the checkout as a bundle so its manifest applies:

```bash
dsh plugin --profile web add /absolute/path/to/dsh-retry
```

A plain `file:` dependency is also accepted, but then no bundle layer is
applied and the block above has to be copied into the profile's
`cordis.patch.yml` by hand:

```json
{
  "dependencies": {
    "dsh-retry": "file:./plugins/dsh-retry"
  }
}
```

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `schedule` | `[2000, 5000, 5000, 5000, 10000]` | wait in milliseconds before retries 1..n; the array length is the bounded head |
| `tailDelayMs` | `20000` | wait for every retry after the schedule is exhausted |
| `retryableCodes` | see below | failure codes that are worth repeating |

A `retryableCodes` entry ending in `*` is a prefix rule. `HTTP_*` matches `HTTP_404`, `HTTP_409`, `HTTP_422` and any other unclassified status. A bare `*` is rejected because it would match every failure.

## Default retryable codes

| code | typical cause |
| --- | --- |
| `EMPTY_RESPONSE` | a completed response with no content blocks |
| `RATE_LIMIT` | HTTP 429 or a provider rate-limit error |
| `SERVER` | HTTP 5xx, including gateway and Cloudflare 5xx responses |
| `TIMEOUT` | a request or stream deadline |
| `TRANSPORT` | connection reset, socket error, truncated stream |
| `PI_AI_ERROR` | an upstream error the pi-ai adapter could not classify |
| `AUTH` | HTTP 401 or 403; with a pooled account upstream another account may succeed |
| `QUOTA`, `ACCOUNT_QUOTA` | exhausted balance or account quota |
| `ACCOUNT_TOKEN_INVALID` | a stored account token rejected with 401 |
| `INVALID_CREDENTIAL` | a malformed credential entry in the pool |
| `MALFORMED_RESPONSE` | a corrupt SSE frame or a mismatched event type |
| `HTTP_*` | unclassified 4xx statuses such as `HTTP_404`, `HTTP_409`, `HTTP_422` |

## Not retried

| code | why |
| --- | --- |
| `CONTEXT_WINDOW_EXCEEDED` | compaction owns the recovery; retrying would loop |
| `INVALID_REQUEST` | the request itself is wrong, so another account cannot help |
| `NO_ADAPTER`, `UNSUPPORTED_REASONING_EFFORT` | configuration errors |
| `MISSING_CREDENTIAL` | no credential is configured for the route |
| `ACCOUNT_SIGN_IN_REQUIRED` | a human has to sign in |
| `ABORTED` | cancellation must stay terminal |
| `UNKNOWN` | the fallback code for foreign errors, unsafe to repeat without limit |

Add any of them to `retryableCodes` if your deployment disagrees.

## What you see

Each planned retry appends a durable `llm/retry` event, then `llm/retry-started` once the wait ends. The Chat transcript renders a row such as `Retrying model request (2/5) . 4s` with an expandable failure reason and delay, and the Trajectory panel lists the attempt, error code and delay. Retries 6 and later render with an unlimited maximum.

No toast is raised, no partial output from a failed attempt is kept, and the model sees nothing: it only receives the rebuilt request for the step that is being retried. Every attempt is a separately billed provider request.

## Limitations

- The retry chain counter lives in memory per session. A host restart ends the turn, so nothing is lost that a durable counter would have preserved.
- Only agent-loop requests are retried. Direct `ctx.llm.stream()` callers stay single-attempt.
- The tail is genuinely unlimited. When the upstream never recovers, the turn stays in the retrying state until it is stopped.
- Retrying pooled credential and quota failures assumes the pool rotates on the next attempt. A permanently exhausted pool loops every 20 seconds.

## License

MIT.
