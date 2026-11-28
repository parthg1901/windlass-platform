# Staging validation, 21 November 2026

Test host: Oracle Ampere, Linux arm64, two CPUs, 12 GB nominal RAM. Baseline source: `7bc117c`. The staging web and gateway ports were 16440 and 16420. All platform traffic in these checks stayed on loopback or the private Compose network. Production services, public tunnels and real agent credentials were outside the test.

The [security wave checks](#security-wave-on-loopback-staging) cover the restricted ingress, encrypted restore, sign-in key migration, hosted Docker refusal and browser policy.

For runner releases, follow the [server and runner release order](runner-release.md).

## Bring-up and gateway

From the repository root, the first build and start used an empty engine volume. The engine started first while the server image finished building.

```sh
deploy/selfhost/init-env.sh staging
stack=.data/selfhost/staging.env
dc() { docker compose --env-file "$stack" -f deploy/selfhost/compose.yaml "$@"; }
dc build
dc up -d --no-build engine
dc up -d --no-build --wait --wait-timeout 180
curl -fsS http://127.0.0.1:16440/health
curl -fsS http://127.0.0.1:16440/ | head -c 80
docker exec wlp-staging-engine-1 rivet-engine --runtime-info
```

The page returned HTTP 200 with `<!doctype html>`. Health and platform info returned HTTP 200. `/platform/connection` issued an expiring token for the default namespace and advertised `http://127.0.0.1:16420`. The engine returned 401 for an unauthenticated namespace list and 403 for a pool list using the browser token. Its runtime identified itself as engine v3, version 3.1.1. The arm64 engine executable in the image and the installed npm package both had SHA-256 `a27caab5a55b1a45df3a07025026416aab1fd6a98fa2449fe18eee82d7c06714`. The configuration and registration sources are linked in the [self-hosting guide](README.md#rivet-311-implementation-references).

## Stream and storage recovery

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts --sessions 1 --minutes .12 \
  --interval 5 --baseline 5 --proof .data/selfhost/smoke-proof.json
export SELFHOST_BACKUP_DIR="$PWD/.data/selfhost/archives"
archive=$(deploy/selfhost/backup.sh "$stack")
fresh=$(deploy/selfhost/restore.sh "$stack" "$archive")
SELFHOST_VOLUME="$fresh" dc up -d --no-build --force-recreate --wait --wait-timeout 180
server/node_modules/.bin/tsx scripts/selfhost-load.ts --verify .data/selfhost/smoke-proof.json
```

Two successful turns emitted 58 ACP updates. The restored user listed the session, and the first 39 persisted timeline items matched SHA-256 `fc5290410b89048e92305ad3f7c88b3c901e7abe087a32ae324543f6bdf74b41`. The original staging volume was put back into service and the drill volume removed.

An additional S3-compatible drill used the AWS CLI and a loopback Moto test server. With `SELFHOST_BACKUP_DIR` unset and `SELFHOST_BACKUP_KEEP=1`, the scripts uploaded an archive, expired an older snapshot under the same project prefix and preserved an unrelated object. Download and restore into a fresh volume reproduced the same 39-item digest through a separate Compose project on ports 18440 and 18420. The restored engine retained the original canonical issuer while clients dialed the new gateway port. Using the new port as the canonical issuer instead returned 503 during JWT issuance, including in a trial with a higher issuer generation.

## Workload

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --sessions 4 --minutes 25 --burners --interval 10 --baseline 60 \
  --proof .data/selfhost/load-proof.json
```

The 25-minute measurement ran from 09:04:06 to 09:29:06 UTC. Final in-flight turns and burner removal finished at 09:29:12. Each session completed 208 turns, emitted 6,032 ACP updates and delivered 3,536 live deltas to its subscriber. Total: **832 successful turns, 24,128 updates, zero failed turns**. The local probes made 600 reads during load, with zero failures. The page probe fetched the HTML document. It did not measure browser rendering or asset downloads.

Each cell gives **p50 / p95 / maximum in milliseconds**. Combined percentiles use all four probes' individual samples. All table cells had zero errors.

| Probe | Idle (6 per probe) | Load 0–15 min (90 per probe) | Load 15–25 min (60 per probe) | Recovery (6 per probe) |
|---|---:|---:|---:|---:|
| Web page | 20 / 63 / 63 | 14 / 75 / 229 | 11 / 45 / 484 | 7 / 14 / 14 |
| User listSessions | 26 / 64 / 64 | 19 / 76 / 242 | 17 / 42 / 484 | 11 / 15 / 15 |
| User models | 28 / 65 / 65 | 21 / 105 / 242 | 17 / 42 / 566 | 12 / 17 / 17 |
| Full session snapshot | 35 / 67 / 67 | 57 / 138 / 298 | 104 / 194 / 763 | 82 / 112 / 112 |
| **All probes** | 28 / 65 / 67 | 24 / 119 / 298 | 19 / 150 / 763 | 12 / 105 / 112 |

All four burners ran throughout the measurement with a 1.5-CPU quota, 256 shares and a 1,536 MiB memory limit each. Forty-six host CPU samples from 09:06:50 to the end averaged 99.98% busy (minimum 99.92%, from Linux CPU accounting). The busy loops used little RAM. The first 37 seconds of the pre-load baseline overlapped the tail of the repository checks. All those checks finished before the burners started. The full-session snapshot had the highest late-load p95, 194 ms. Each snapshot reads the session's accumulated timeline.

**Logs:** zero engine or server error lines during load, zero matches for the UPS buffer, late heartbeat or lease-fencing messages, and zero container restarts. Four engine warnings in recovery and one during teardown reported that an actor WebSocket tunnel stopped. The server had no warning or error lines in the load-test log window.

The supplied real-agent Cloud reference measured idle p50/p95 of 41/84 ms and late-load p50/p95/max of 261/8,300/14,500 ms, with nine failures and an engine restart. This run used loopback requests, a scripted ACP stream and CPU-only burners. Production network latency, model behavior, agent memory pressure and workspace disk I/O were outside the measurement.

## Final restore and handoff

The load run preceded two validation changes: the server now rejects credentials in a configured token endpoint, and temporary containers clear the Compose labels inherited from their image. The measurement used the same private endpoint, engine executable, repository actors, fake ACP workload, quotas and CPU shares as the committed kit.

The server and engine images were built again and tagged `bf9db32`. The newly started server read the loaded session. A second S3-compatible backup was then restored to a new, isolated volume. The stop, tar copy and container start took 17 seconds. The gzip archive was 17,606,117 bytes. A lookup through the restored user actor and a snapshot through the restored session actor reproduced all **3,954 timeline items**, SHA-256 `49974fa911cf90ceb4b0160a7577bde58349e2a1d1e6452ff656cc40ad26c00e`.

```sh
deploy/selfhost/backup.sh .data/selfhost/staging.env
deploy/selfhost/restore.sh .data/selfhost/staging.env "$(cat .data/selfhost/final-archive.out)"
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:18440 --project wlp-restore-check \
  --verify .data/selfhost/load-proof.json
```

Trimmed output from the final drill:

```text
Stop, volume copy and start took 17 s
Retention kept the newest snapshot and the unrelated object.
Restored user lists the session; verified timeline items: 3954 sha256: 49974fa911cf90ceb4b0160a7577bde58349e2a1d1e6452ff656cc40ad26c00e
```

Staging is on its original volume, `wlp-staging_engine-data`. The drill containers, restored volumes, CPU burners and local S3 test service were removed. The mode-600 stack env, final proof and archives are in the git-ignored `.data/selfhost/` directory. The final archive's basename is in `.data/selfhost/final-archive.out`. Public tunnel routing and a remote bucket were outside the drill.

## Repository checks

```sh
(cd web && npx tsx ../scripts/web-stage-check.ts)
WLP_DEMO=1 WLP_SANDBOX=fake pnpm test
pnpm typecheck
pnpm --filter @windlass-platform/server exec tsx ../scripts/runner-e2e.ts
# In a shell with the private staging admin token exported:
WLP_CHECK_ENGINE=http://127.0.0.1:16420 pnpm --filter @windlass-platform/server exec tsx ../scripts/connection-check.ts
```

On the committed implementation the web-stage check found all 19 bundled files, all three workspace typechecks passed, and the repository test command reported:

```text
Test Files  33 passed (33)
Tests       570 passed (570)
ALL PASSED: 146 passed, 0 failed, 1 skipped (sandbox layer: fake)
```

The skip covers cloning a real repository in the fake layer. The runner end-to-end check passed 62 checks and the connection check passed all 58, including real token expiry against the local engine.

## Security wave on loopback staging

| Item | Commit | Implementation and checks |
|---|---|---|
| F7 | `74b55be` | [Ingress rules](tunnel.example.yml), [web gateway discovery](../../web/src/api/rivet.ts), [discovery regression](../../web/src/api/rivet.test.ts), [ingress integration check](../../scripts/selfhost-ingress-check.ts) |
| F8 | `eb787c1` | [Backup](backup.sh), [restore](restore.sh), [age pin and archive names](archive-common.sh), [local backup checks](check-backup.sh) |
| F1 | `1660a45` | [Configuration](../../server/src/config.ts), [startup refusal](../../server/src/startup.ts), [startup regression](../../scripts/connection-check.ts) |
| F6.1 | `0b3de46` | [Initializer](init-env.sh), [Compose](compose.yaml), [key import](signin-key.env), [seal-key selection](../../server/src/config.ts), [migration regression](check-signin-key.sh) |
| F13 | `5306117` | [Web headers](../../server/src/web.ts), [server wiring](../../server/src/index.ts), [HTML entry](../../web/index.html), [theme script](../../web/public/theme.js), [header checks](../../scripts/web-files-check.ts), [browser check](../../scripts/selfhost-csp-check.cjs) |

Each implementation commit updates the [operator guide](README.md).

These checks used the deployment changes based on `07f2365`, the existing `wlp-staging` Compose project and Rivet 3.1.1. The two origins were simulated locally. The staging volume kept its original canonical issuer.

| Check | Before the change | After the change |
|---|---|---|
| Engine ingress | With the previous whole-host mapping, the ingress check failed at `/namespaces` and identified the engine port as its upstream. The web client configuration test failed because the discovered gateway still triggered a metadata lookup. | The candidate YAML passed cloudflared's offline matcher. An in-process runner paired, opened both real gateway sockets and delivered a successful streamed turn through a local reverse proxy. On a local TLS proxy using the same matcher, the genuine staging admin bearer got 404 on namespaces, pools, token issuance, node registration and the actor API. A Chromium demo login and user feed passed over HTTPS and WSS. |
| Engine credentials | The private namespace list accepts the configured admin token (200). | The private engine issued a 60-second JWT with only `node:create` (200). The pool list refused that JWT (403). The tagged node-registration handler checks this grant. The drill did not register an additional engine node. |
| Backups | The check reported `backup accepted a missing recipient`, `missing .age suffix`, `missing age header` and `tar could read the published object`. | The local object had the age v1 header, and tar refused it. Missing recipient and missing recovery identity were refused. A valid identity restored a fresh engine volume. An explicitly requested local plaintext backup also restored without an identity. The drill used the pinned Linux arm64 release and local directory backend. |
| Docker hosting | The startup check reported `remote engine refuses the hosted Docker layer: condition not met`. | The server entry point exited 1 with the remote-engine Docker refusal. Embedded Docker, an explicit remote override and a fake remote provider passed the startup checks. |
| Sign-in key | The live initializer check reported a missing independent key. An explicitly empty key silently fell back to the signing secret. | In an isolated fixture, Compose delivered the generated 32-byte key and preserved an existing server-env key on a legacy stack. A separate process reopened a sign-in after the signing secret changed and the old value became the seal key. An explicitly empty seal key was refused. |
| Web headers | The web-file check had seven header failures. Chromium signed in, received a WebSocket frame and reported `Injected inline script executed`. | All 24 web-file cases passed. Chromium received a real user feed frame, blocked the injected script, and saw one-year HSTS on the TLS origin. cbor-x and Zod each made one caught eval probe. Both continued under the policy without an eval exception allowance. |

The account-free ingress test invoked `cloudflared tunnel --config … ingress rule` locally and proxied HTTP and WebSocket requests to the selected loopback service. The browser TLS drill used a temporary loopback certificate. No Cloudflare route or public hostname was used.

The current staging volume reproduced the surviving 3,954-item proof and a fresh 21-item session. The original 39-item session was present in the archived morning snapshot. We restored that snapshot on staging, verified the 39 items, backed up that volume with age and restored the encrypted object to a second volume. The source and decrypted timelines matched in all three comparisons.

```text
  39 items  fc5290410b89048e92305ad3f7c88b3c901e7abe087a32ae324543f6bdf74b41
3954 items  49974fa911cf90ceb4b0160a7577bde58349e2a1d1e6452ff656cc40ad26c00e
  21 items  53ca45a7fd55c2d645f1201e9076f81669564fe70baa44ff4dbd55a3a78e14da
```

The drill stopped staging before each volume change, checked the restored user's session and timeline, and returned to `wlp-staging_engine-data`. One backup attempt immediately after the smoke run detected an unclean service exit and skipped the archive. It restarted the stack and the retry completed after a clean stop.

Reproduce on a loopback staging stack from the repository root. The backup check requires a private local drill directory, a recipient and its matching test identity as described in the [self-host guide](README.md#backup-and-restore). Its stdout is the archive basename. Follow the volume-switch and restore verification steps above using a proof verified on the source volume immediately before the drill.

```sh
server/node_modules/.bin/tsx scripts/selfhost-ingress-check.ts deploy/selfhost/tunnel.example.yml app.example.com engine.example.com
archive=$(deploy/selfhost/check-backup.sh .data/selfhost/staging.env)
fresh=$(deploy/selfhost/restore.sh .data/selfhost/staging.env "$archive")
WLP_CHECK_SECTIONS=startup server/node_modules/.bin/tsx scripts/connection-check.ts
deploy/selfhost/check-signin-key.sh
server/node_modules/.bin/tsx scripts/web-files-check.ts
node scripts/selfhost-csp-check.cjs http://127.0.0.1:16440
```

The original staging server tag was rebuilt during the browser test. Rebuilding the recorded `bf9db32` source reproduced its original Linux/arm64 runtime manifest, `sha256:bfc1ea5fcc6d76cbf9a3632adabbe74010a7fa0f7e8e821a7340e778d371e314`. At handback, the server was healthy on that manifest, and a read through the original engine volume reproduced the 3,954-item digest again. The temporary test image tag, drill volumes, archive copies and recovery identity were removed.

The standalone web-stage check, run as `(cd web && npx tsx ../scripts/web-stage-check.ts)`, found all 19 bundled files. `pnpm typecheck` passed for runner, server and web. The connection check passed all 61 cases with the private staging engine, including real token expiry. On the first `WLP_DEMO=1 WLP_SANDBOX=fake pnpm test` run, 574 web tests passed and server end-to-end reported 145 passed, one failed and one skipped. The demo login actor had entered the engine's `destroying` state before the test could observe its `attempt_done` response.

An unchanged full rerun passed. The two Node check scripts reported 4 and 3 passes, and all 5 runner fairness cases passed. Vitest reported 574 passes in 34 files. Server end-to-end reported 146 passed, 0 failed and 1 skipped. The skip covers cloning a repository with the fake sandbox provider.

# Engine readiness drill, 28 November 2026

Test host: AWS, Linux amd64, two vCPUs, 3.8 GB RAM, Docker 29.10.1, Compose 5.8.1. Each run restored the same 244 MB archive of a long-running stack (its active-envoy index had grown over many node versions and failed registrations) into a fresh loopback-only drill project with fake sandboxes, freshly generated credentials and no tunnel, or started on an empty volume. A sampler read the engine's health status and its metrics every 5 s. Times are seconds since the engine container started. "Cancelled" is the healthcheck's count of cancelled and timed-out storage commands. "Listed" counts completed list-active-envoys commands.

| Run | Engine | Health | Cancelled | Listed | Server |
|---|---|---|---|---|---|
| Restored, 10 min command deadline | `engine.json` with `command_timeout_ms` | starting until 37 s, healthy at 42 s | 0 at 5 s, 16 at 10 s, 25 at 26 s, then steady | 0 until 21 s, 10 at 26 s | started at 41 s, healthy at 47 s, 0 restarts |
| Restored, default 5 s deadline | Rivet defaults | starting for 20 min, then unhealthy at about 1,230 s | 90 at 121 s, 323 at 600 s, 616 at 1,200 s | never | never started |
| Empty volume, built from this repository | `3.1.1` tag | healthy at 36 s ("idle") | 0 | 0 | healthy at 42 s, 0 restarts |

On the restored data the clean-up finished between 21 s and 26 s. During it the count rose every 5 to 6 s. With the default deadline the clean-up never finished: over 20.5 minutes the count rose 162 times, at most 17 s and on average 7.6 s apart, and no list-active-envoys command ever completed. The 120 s window for an engine whose clean-up has not been seen to finish is seven times that longest pause. The empty volume never ran an actor or index command, so it used the 30 s idle window. Before the healthcheck had an idle window, the same empty volume took 134 s.

The server registered on its first try every time, and `/platform/connection` issued a token. Its own registration added four cancellations after the engine was already healthy, without a restart.

Release and backup paths on the restored data, with the same 10 minute deadline:

| Step | Result |
|---|---|
| Server-only release (`up -d --no-build --no-deps --wait server` with a new node version) | 6 to 7 s, engine container unchanged, including an engine created before it had a healthcheck |
| Engine replacement (stop the server, `up --no-deps --wait engine`, then the server) | engine healthy after 38 to 48 s, stack healthy after 44 to 54 s |
| `backup.sh`, engine with the healthcheck | copy 18 s, readiness and server start 45 s, server healthy, 0 restarts |
| `backup.sh`, engine created before the healthcheck (probe run with `docker exec`) | copy 21 s, readiness and server start 41 s, server healthy, 0 restarts |

`dc config --hash engine` matched the engine container's `com.docker.compose.config-hash` label until the service definition changed. An earlier `backup.sh` that restarted the server with `compose start` left it stopped against an engine created before the healthcheck: Compose refused the dependency ("no healthcheck configured"). The script now restarts the same containers with `docker start`.

The drill projects, restored volumes, copied archive and credential file were removed afterwards, and the archive copies and credential files were shredded.
