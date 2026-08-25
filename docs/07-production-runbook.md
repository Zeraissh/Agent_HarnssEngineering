# Production deployment runbook

## Supported production boundary

The production target is the compiled Web host plus the Electron shell. The Electron app always
loads the current host URL, so `ask_user`, continuation, recovery, and event rendering cannot drift
behind a copied UI. Android remains an experimental client until a platform credential store,
signed release pipeline, and HTTPS integration test are supplied; cleartext HTTP is disabled.
This profile is single-operator/single-tenant. A public multi-user service still requires per-user
identity, authorization, quota ownership, and data partitioning beyond the shared host token.

## Release gate

Before assigning a version or image tag, all of the following must pass from a clean checkout:

```powershell
npm ci --ignore-scripts
npm audit
npm run typecheck
npm test
npm run build
npm run pack:check
cd cross-app
npm ci --ignore-scripts
npm audit
npm test
npm run build
node --check electron/main.cjs
```

The pack audit is an allowlist gate. A release package may contain only `dist/`, `README.md`, and
the npm manifest; local histories, `.env`, worktrees, demos, and customer artifacts are rejected.
`desktop:dist` refuses Windows/macOS production artifacts when signing credentials are absent.
`desktop:dist:unsigned` is local-test-only and must never be uploaded as a release.

Releases are cut by pushing a `vX.Y.Z` tag. The `Release` workflow re-runs this entire gate on CI,
builds the container image, pushes it to GHCR (`ghcr.io/<owner>/agent-harness`, version tag plus
`sha-<commit>` tag), and records the digest-pinned reference in the GitHub Release notes. Production
always deploys that digest reference, never a mutable tag — the recorded digest survives builder
cache pruning and machine changes, which is what makes the rollback procedure below executable.

## Deployment

1. Back up the history volume and record the currently running image digest.
2. Generate a random access token of at least 32 characters in the secret manager.
3. Terminate TLS at a trusted reverse proxy and forward `Host`, `X-Forwarded-Host`, and
   `X-Forwarded-Proto`. Keep the container port bound to loopback.
4. Copy `.env.production.example` outside the repository, populate secrets, and set an absolute
   `AGENT_WORKSPACE`.
5. Set `AGENT_IMAGE` to the digest-pinned reference from the target GitHub Release notes, then
   start `deploy/docker-compose.production.yml`.
6. Confirm `/health` is HTTP 200 and `/ready` is HTTP 200. A 503 readiness response means history
   protection or shutdown state is degraded; do not send traffic.
7. Open `https://<public-host>/?access_token=<token>` once. The host exchanges it for an HttpOnly,
   SameSite cookie and redirects to a clean URL.

Remote listeners fail to start without authentication and a declared TLS boundary. Bash is removed
from the remote tool surface by default. Enabling it requires the separate
`AGENT_UI_ALLOW_REMOTE_EXECUTION=1` acknowledgement and an OS/container isolation review.
Load `deploy/prometheus-alerts.yml` into the monitoring stack and configure the scraper with the same
Bearer token used by the operator; `/metrics` is authenticated whenever the host token is enabled.
Name the scrape job exactly `agent-harness` — the process-death alert (`AgentHarnessDown`) matches on
that job label and stays silent under any other name. Run outcomes are queryable as
`agent_harness_runs_finished_total{outcome=...}`; the rollback trigger "run errors exceed baseline"
is backed by the `AgentHarnessRunErrorRatio` alert. Token spend is queryable as
`agent_harness_tokens_total{role=execution|verification|planner, kind=input|output|cache_read|cache_creation}`
(accumulated as each segment completes); the `AgentHarnessTokenBurnRate` alert warns when non-cache-read
tokens exceed 2M per hour — tune that threshold to the account's actual limits and model pricing.

## Canary and smoke checks

Send only an operator canary first, then verify:

- create a single-mode run with `ask_user=true` and confirm a location-style ambiguity produces a
  visible question and can resume after an answer;
- create a plan-mode run and reject the plan gate, confirming zero subtasks execute;
- stop an active run and confirm `run_end` is persisted;
- restart the host and derive a continuation child from a completed checkpoint;
- submit an evil Origin, `text/plain` create request, oversized body, and fifth concurrent run;
  expected results are 403, 415, 413, and 429 respectively;
- hold `/api/stream`, send SIGTERM, and confirm shutdown completes within the configured timeout.

## Rollback triggers and procedure

Rollback immediately when any of these occur: two consecutive readiness failures, authentication or
Origin bypass, history write degradation, inability to answer `ask_user`, graceful shutdown beyond
10 seconds, or a canary run losing its terminal event. Also rollback when 5xx responses exceed 1%
for five minutes or run errors materially exceed the previous release baseline.

Stop new traffic, preserve the failed release logs/history volume, set `AGENT_IMAGE` back to the
digest recorded in the previous GitHub Release, and start the compose file again. The current history format remains version 1 and no migration is performed,
so rollback does not require rewriting stored runs. Re-run the canary checks before restoring normal
traffic. Desktop rollback is installation of the previous signed artifact; never replace it with an
unsigned build.
