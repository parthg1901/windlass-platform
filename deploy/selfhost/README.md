# Windlass on one Linux host

The server serves the built web app and platform HTTP routes. A separate Rivet 3.1.1 engine runs the actor gateway, scheduler and durable actor storage. The server opens an outbound node connection over the private Compose network. Staging uses demo sign-in, fake sandboxes and a runner stand-in for the load test.

The arm64 staging run includes per-probe timings and a restore of the measured timeline. [Validation results](VALIDATION.md)

## Bring up staging

Use Docker Engine, Compose v2.24 or later, Bash, Git and OpenSSL. Run these commands from the repository root.

```sh
deploy/selfhost/init-env.sh staging
stack=.data/selfhost/staging.env
dc() { docker compose --env-file "$stack" -f deploy/selfhost/compose.yaml "$@"; }
dc up -d --build --wait --wait-timeout 180
dc ps
curl -fsS http://127.0.0.1:16440/health
curl -fsS http://127.0.0.1:16440/ | head -c 80
```

The initializer creates a private, git-ignored, mode-600 file and refuses to overwrite it. Keep a protected copy of the env file with the corresponding release. New live stacks generate independent signing and sealing secrets. Staging and legacy stacks use the signing secret for sealing when WLP_SIGNIN_KEY is unset. Engine archives contain actor data and engine signing keys. Restrict access to both.

| Stack | Compose project | HTTP and web | Actor gateway | Initial volume |
|---|---|---|---|---|
| Staging | `wlp-staging` | `127.0.0.1:16440` | `127.0.0.1:16420` | `wlp-staging_engine-data` |
| Live | `wlp-live` | `127.0.0.1:26440` | `127.0.0.1:26420` | `wlp-live_engine-data` |

The two projects have separate networks, image tags, volumes and credentials. Each engine uses one leader and one writer to its volume. The volume contains both `log/` and `objects/`. The local filesystem object store supplies the cluster metadata and cold data. At first start the server waits for the admin API, creates the default namespace and pool if absent, then starts the registry. Readiness checks both the node's health and the server's ability to issue browser tokens.

### Engine readiness

Rivet 3.1.1 answers `/health` within seconds of starting. After every start, though, the first command that touches its active-envoy index (an actor alarm, or the server's node registration) first runs a one-time clean-up of that index. A server that registers during the clean-up misses the SDK's fixed 30 s registration window and exits, and every failed registration makes the index, and the next clean-up, larger. Commands that wait on the clean-up are cancelled by their callers or hit the storage command deadline, and the engine counts both on its metrics port (6430, inside the container only).

The engine's healthcheck, [`engine-ready.sh`](engine-ready.sh), reports healthy once `/health` answers and those counts have stopped moving: for 15 s after a list-active-envoys command has completed, which proves the clean-up finished; for 30 s while no actor or index command has run at all, as on a new install; and otherwise for `SELFHOST_ENGINE_SETTLE_SECONDS` (default 120). An engine whose clean-up never finished paused its count for at most 17 s in 20 minutes ([drill](VALIDATION.md#engine-readiness-drill-28-november-2026)). From then on it only asks `/health`, for the life of the engine process. The server waits for a healthy engine. The healthcheck's start period is 20 minutes, so give `--wait-timeout` up to 1,500 s whenever the engine starts on existing data.

[`engine.json`](engine.json) raises `storage.command_timeout_ms` to 10 minutes. With the default 5 s deadline, each step of a large index's clean-up is cut off and the clean-up starts over, indefinitely, so the engine never reports healthy and the server never starts. The cost is that a stuck storage command can hold its caller for up to 10 minutes.

The engine image is tagged `SELFHOST_ENGINE_TAG` (default `3.1.1`), apart from the server's `SELFHOST_RELEASE`, so a server release leaves the running engine and its index alone. `dc up --build` rebuilds the engine under the same tag, and Compose replaces the engine only when the image or its service definition changed.

### Routing and a future live stack

For a locally managed named tunnel, copy [the ingress example](tunnel.example.yml) to the tunnel service's config, set its UUID and mode-600 root-owned credential file, then substitute your two hostnames and the loopback ports for the selected stack. For a remotely managed tunnel, enter the equivalent ordered ingress rules in its remote configuration. The example uses staging ports. Live uses 26440 for web and 26420 for the engine. Keep the final `http_status:404` rule and preserve WebSocket upgrades. Keep token-bearing discovery responses uncached and exclude gateway URLs, query strings and WebSocket protocols from access logs. For `/signin`, record the path alone at every proxy. Omit full request URI, query, Referer and request-body fields from edge log exports. The example sets cloudflared to fatal-only logging because even upstream request errors can include the full destination URL. Apply that level to remotely managed connectors too. If this tunnel is the only path to the web listener and overwrites the client address, set `WLP_CLIENT_IP_HEADER=cf-connecting-ip` for per-client login limits. The engine's private Compose address serves node registration, bootstrap and token minting.

With RivetKit 3.1.1, browser and runner handles address actors by name and key. The gateway resolves the key in the query string. Login POSTs go to `/platform/login/{start,finish,demo}` on the web host. Browsers call `/gateway/{user,userGitlab,agentSession}/action/<action>` and subscribe at `/gateway/{user,userGitlab,agentSession}/connect`. An actor the web app newly opens (`ACTOR` in the web client) needs adding to both groups of the tunnel's path rule; a web test checks the example against that list. Runners upgrade `/gateway/machine/websocket/control` and `/gateway/agentSession/websocket/runner`. Both clients disable metadata lookup. Leave the engine REST API private, including `/actors`, `/namespaces`, `/pools`, `/nodes`, `/envoys/connect` and `/auth/tokens`. [Gateway URL builder](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/actor-websocket-client.ts) · [Action transport](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts) · [Socket paths](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/common/actor-router-consts.ts) · [Engine REST API](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/api-endpoints.ts) · [Web client](../../web/src/api/rivet.ts) · [Runner client](../../runner/src/control.ts)

On a loopback demo stack, check the candidate rules before installation (substitute the configured hostnames). This uses cloudflared's offline matcher and a local reverse proxy to run a demo login and a paired stand-in runner turn. It creates demo actor data. With the staging `RIVET_ADMIN_TOKEN` in the check process environment, it also sends authenticated requests to the local edge. No Cloudflare account or tunnel connection is required.

```sh
cloudflared tunnel --config deploy/selfhost/tunnel.example.yml ingress validate
server/node_modules/.bin/tsx scripts/selfhost-ingress-check.ts deploy/selfhost/tunnel.example.yml app.example.com engine.example.com
```

At cutover, replace any whole-host engine route with the allowlist and validate the final configuration. Start or restart the connector with those rules, then route both DNS names to the configured tunnel. Confirm that `/namespaces` and `/auth/tokens` on the public engine hostname return the edge's 404, then sign in, open the session feed and confirm the paired runner completes a turn.

The engine supports an expiring namespace JWT with the `node` resource and `create` operation for node registration. Its only static engine credential is the admin token. The current server also bootstraps namespaces and pools and mints browser and runner credentials, which requires a persistent management credential. Isolating that credential from the server requires moving those operations to a private service and renewing the node JWT before reconnects (maximum lifetime 24 hours). [Node registration](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/pegboard-envoy/src/routes.rs) · [Wire resource names](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/auth-policy/src/types.rs) · [Issuance](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/api-public-shim/src/tokens.rs) · [Engine auth configuration](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/auth.rs)

Before first live boot, run `SELFHOST_ENV_DIR=<private directory> deploy/selfhost/init-env.sh live` (see [Keep live env files outside the checkout](#keep-live-env-files-outside-the-checkout)), stage the target architecture's Windlass binary using `server/stage-windlass.sh`, and select the live env file in the commands above. Edit the application and gateway origins to the intended HTTPS names. Set the engine's canonical origin to that gateway name **before initializing its volume**. A tunnel may be installed later. The server issues tokens over Compose DNS, so the public hostname need not resolve from inside its container.

The gateway URL clients dial (`WLP_PUBLIC_ENDPOINT`) and the engine's canonical leader URL (`SELFHOST_ENGINE_ORIGIN`) are separate settings. The latter determines the JWT issuer persisted in the signing ring. Keep it stable for the life of the data, including restores. For an existing loopback staging volume, keep its original canonical URL when assigning it a client-facing hostname. Changing the issuer of an existing ring can produce `503 auth.issuance_unavailable` even with correct admin credentials.

The live preset selects the production image, disables demo login and runs real Windlass sign-in commands locally. Choose paired-machine sessions for workloads on a separate machine. The preset's hosted provider is fake. Configure a supported real provider separately if hosted sessions are required. Additional application settings, including the user allowlist, go in the mode-600 server env file the stack env file selects. Set `WLP_PLAN_USERS` there too (user ids, or `*`) for users to run hosted turns on a connected plan, hosted Windlass's own ChatGPT models included. The server warns at startup while it is unset. Configure and pair a runner for the intended stack independently. A runner paired to another deployment has its own identity and session data.

For platform login with the existing GitHub App, keep its repository connection callback first and add `<web-origin>/signin` as a second callback URL. Enable the App's **Email addresses** read-only permission only when admitting GitHub users through `WLP_ALLOWED_EMAILS`. For Google, register a **Web application** OAuth client with the exact authorized redirect URI `<web-origin>/signin`. Set `WLP_GOOGLE_CLIENT_ID` and `WLP_GOOGLE_CLIENT_SECRET` in the protected server env file and recreate the server. Google login is disabled and its button is hidden unless both are set. Register each web origin where people sign in.


### The model relay's hostname

E2B sandboxes reach Windlass's model relay at a hostname of its own, so that their allow list opens only the relay and not the web app (see [the model relay](../../docs/model-relay.md#where-the-relay-runs)). Choose a name, for example `windlass-relay.example.com`, and set it in the server env file:

```sh
WLP_MODEL_RELAY_URL=https://windlass-relay.example.com
WLP_E2B_WINDLASS_VERSION=0.7.1
```

Add one ingress rule for it, before the final `http_status:404` rule, to the same loopback port as the application hostname (26440 on live, 16440 on staging). The server checks the method, path and turn lease for requests under the relay prefix:

```yaml
  - hostname: windlass-relay.example.com
    path: '^/model-relay/'
    service: http://127.0.0.1:26440
```

Then route the name to the tunnel (`cloudflared tunnel route dns <tunnel> windlass-relay.example.com`, or a proxied CNAME to `<tunnel UUID>.cfargotunnel.com`) and restart the connector. Leave the `Host` header as it comes (no `httpHostHeader`): the server serves the relay only when the request's `Host` is that name. Check from outside: `curl -s https://windlass-relay.example.com/model-relay/v1/models -H 'authorization: Bearer x'` answers `relay_lease_ended`, and `https://windlass-relay.example.com/` answers 404. The server logs `e2b.model_relay: Windlass's model requests go through https://windlass-relay.example.com/model-relay/v1` at startup. Without `WLP_MODEL_RELAY_URL` it logs that E2B turns are handed their access token instead.

## Agents never run on the platform host

An agent container escape or a compromised runner with the Docker socket can expose the engine data, tunnel credentials and every user's sealed sign-ins and their decryption key. Keep hosted sandboxes set to `fake` or `e2b` and pair a runner on a separate machine, since running the owner's development agents under a root-equivalent account on the platform host exposes the same secrets.

Before opening an invitation-only deployment to traffic, verify that the effective live configuration
has demo sign-in disabled and at least one entry in `WLP_ALLOWED_USERS` or `WLP_ALLOWED_EMAILS`.
Empty lists admit any authenticated GitHub or Google account. Confirm that staging and production use
independent credentials and that the gateway exposes only the intended routes listed above.
Record pass/fail results without printing the configuration values.

### Resource allocation

The engine has 4,096 CPU shares and a 2,304 MiB memory limit. The server has 3,072 shares and a 1,792 MiB memory limit. Both restart unless explicitly stopped. Size both stacks together on a 12 GB host.

### Configuration names

| Purpose | Variables |
|---|---|
| Project, ports, data and release | `COMPOSE_PROJECT_NAME`, `SELFHOST_HTTP_PORT`, `SELFHOST_GATEWAY_PORT`, `SELFHOST_VOLUME`, `SELFHOST_RELEASE`, `SELFHOST_ENGINE_TAG`, `SELFHOST_SERVER_TARGET`, `SELFHOST_SERVER_ENV_FILE`, `SELFHOST_ENV_DIR` (initializer only) |
| Public origins and canonical issuer | `WLP_PUBLIC_URL`, `WLP_PUBLIC_ENDPOINT`, `SELFHOST_ENGINE_ORIGIN`, `SELFHOST_ISSUER_GENERATION` |
| Engine readiness | `SELFHOST_ENGINE_SETTLE_SECONDS`, `SELFHOST_ENGINE_READY_TIMEOUT` (backup only) |
| Credentials and node version | `WLP_SECRET`, `RIVET_ADMIN_TOKEN`, `RIVET_NODE_VERSION` |
| Application modes | `WLP_DEMO`, `WLP_SANDBOX`, `WLP_SIGNIN_RUNNER`, `WLP_REQUIRE_SIGNED_RUNNER` |
| Set by Compose for the server | `RIVET_ENDPOINT`, `RIVET_TOKEN`, `RIVET_NAMESPACE`, `RIVET_POOL`, `WLP_TOKEN_ENDPOINT`, `WLP_WEB_ORIGINS`, `WLP_MACHINES`, `WLP_HTTP_PORT` |
| Optional server settings | `WLP_SECRET_KEYS`, `WLP_SIGNIN_KEYS`, `WLP_SIGNIN_KEY`, `WLP_ALLOWED_EMAILS`, `WLP_ALLOWED_USERS`, `WLP_RUNNER_IMAGE`, `WLP_RUNNER_CAPABILITIES`, `WLP_PLATFORM_KEY`, `WLP_BUCKET_*` |

`SELFHOST_SERVER_ENV_FILE` selects the optional server env file. A stack initialized with `SELFHOST_ENV_DIR` sets it to `<that directory>/<compose-project>.server.env`; otherwise the default is `.data/selfhost/<compose-project>.server.env`. An explicit relative path is resolved from the Compose file's directory. Stack settings listed under `environment` in Compose take precedence over this file. Avoid printing expanded Compose configuration or unfiltered container inspections.

### Enable signed runner connections

Leave `WLP_REQUIRE_SIGNED_RUNNER=0` in the stack env file for the initial server deployment. This is the
default for existing stacks as well. Protocol-1 runners can keep their current image and pairing.
Switch every server node together when the owner is ready to update and re-pair the machines.

1. On the **owner's laptop**, in a checkout of this release with dependencies installed, run the following
   commands. Use a private directory on owner-controlled offline storage for the root. The output file
   for the certified **online** key is a deployment secret. The root command refuses to overwrite a file.

   ```sh
   umask 077
   root=/path/on/offline-storage/wlp-platform-root.pem
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts root --out "$root"
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts fingerprint --root "$root"
   pnpm --filter @windlass-platform/server exec tsx ../scripts/platform-key.ts certify --root "$root" --serial 1 --days 90 > /path/to/private-transfer/platform-online.env
   ```

2. Keep the root and its backup offline. Record its public fingerprint independently. Transfer only
   `platform-online.env` through the deployment's secret channel. Install its single `WLP_PLATFORM_KEY`
   line in the mode-600 optional server env file (`SELFHOST_SERVER_ENV_FILE`).
   Keep both the env file and generated key material outside Git, images, logs and chat.
3. Stage a runner of **0.3.13** or later (the oldest the server serves) at a new immutable digest. Keep the old setup command available until cutover. Set the new pinned `WLP_RUNNER_IMAGE` and matching
   `WLP_RUNNER_CAPABILITIES` in that server env file. To obtain the capabilities JSON, export the new
   `WLP_RUNNER_IMAGE` digest reference and run `docker run --rm --network none -e WLP_RUNNER_IMAGE "$WLP_RUNNER_IMAGE" capabilities`.
   Set `WLP_REQUIRE_SIGNED_RUNNER=1` in
   the live stack env file. Recreate the server and check health.

   ```sh
   docker compose --env-file "$stack" -f deploy/selfhost/compose.yaml up -d --no-deps --force-recreate --wait server
   curl -fsS http://127.0.0.1:26440/health
   ```

4. On each runner host, stop and remove the old runner container (`docker rm -f windlass-runner` for the
   default name), retaining its named state volume. On the Machines page choose **Add a machine**, run
   its setup command with the same volume and approve the new pairing. Compare the printed fingerprint
   with the offline fingerprint. Run the background command printed by setup and
   confirm it appears online and completes a turn. Each new pairing has a new machine id. Old pairings
   and their workspaces stay associated with their original ids.

Schedule renewal before the certificate expires. Expiry prevents new handshakes, including reconnects.

For renewal or a leaked online key, run `certify` again under the same root with the next unused serial.
Replace the online env line on every server and recreate the services. Reconnect each runner so it
records the higher serial. A disconnected runner can still accept its previous unexpired certificate
until it sees the newer serial. For a gateway move, also pass `--endpoint https://new-gateway.example`
to `certify` and update `WLP_PUBLIC_ENDPOINT` together with that certificate. Include the same gateway
origin on subsequent certificates until every runner has recorded the move. A lost root requires a new
root and a fresh pairing on every runner. Reverting the server switch restores protocol 1 for old runners.
Pinned runners require a signed platform on their next connection.

For the public origins, the owner should enable hardware-key 2FA and auditing on the Cloudflare account,
use scoped API tokens, enable DNSSEC for `parthg.dev` and restrict CAA to the CA used for the edge
certificate. Check `dig CAA parthg.dev` after edge certificate renewal. The deployment does not verify CAA.

### Move an existing owner to provider login

1. Keep the current Windlass browser session open. Record its UID from the account menu. Back up the actor data and retain the existing signing and sealing keys, key IDs, engine namespace and web origin throughout this rollout.
2. Register the exact `<web-origin>/signin` callback on the existing GitHub App, after its repository callback. If access is limited, add the owner UID to `WLP_ALLOWED_USERS` or configure verified-email admission.
3. Roll out authenticated Settings linking to existing sessions before withdrawing the old login entry point. In the owner's current session, open **Settings → Account → Link GitHub**, authorize the intended GitHub account on the configured instance, and return to Settings. In a separate browser profile, choose **Continue with GitHub** and verify the original UID and agents.
4. Deploy the release with GitHub and Google platform login and ChatGPT under **Settings → Model providers**. Existing platform sessions retain their normal expiry. An owner who has already lost their session needs [operator recovery](../../docs/operating.md#recover-a-platform-login) before their first provider login.

When upgrading from the email-matching preview, relink even if the preview previously recognized the owner. Those records cannot establish how the original UID was assigned.

### Rotate signing and sealing keys

Key rotation is a separate operation. Finish in-flight authorization before changing keys. When separating a deployment's sealing key from an existing `WLP_SECRET` fallback, preserve that exact sealing material in its protected configuration. Keep the originals with the corresponding backups.

In the mode-600 optional **server env file**, set `WLP_SECRET_KEYS` for platform signatures and `WLP_SIGNIN_KEYS` for encryption. Each is an ordered comma-separated list of `id:secret` entries. The first entry issues new material and every entry can read material bearing its id. Use a distinct `openssl rand -hex 32` value per root and keep its id for its lifetime. Ids permit 1–32 letters, digits, underscores or dashes. Each list overrides its single-key setting. Without a dedicated sealing setting, encryption follows the signing keyring, so retiring a signing root also retires its decryption capability.

1. Back up the actor data and its corresponding protected configuration. For the initial conversion from singleton settings, use `default` as the id of the exact existing `WLP_SECRET` to retain sessions issued by this release. Put the exact existing seal secret in the sealing ring under a stable id. Legacy ciphertext carries a derived id that the reader recognizes automatically. Switch all servers together for this first conversion, because a singleton seal reader only recognizes the derived id.
2. Before each subsequent rotation, distribute the old and new roots to every server with the **old entry first**. For example, the signing list has the form `default:<existing>,nov26:<new>`. Recreate the server with `dc up -d --no-deps --force-recreate --wait server` for each configuration change. Once all readers have both entries, promote the new root by reversing the order on each server. Signing and sealing can rotate independently.
3. For routine signing rotation, keep the old entry for 30 days after the last server stopped issuing with it. Removing it sooner ends any remaining sessions signed under that id. For a compromised root, remove it immediately across all servers and sign in again. Keep the required Compose `WLP_SECRET` and any singleton sealing fallback aligned with the current roots when retiring old material, to keep retired root material off the server. Keep the named rings configured so previously issued ids remain recognizable.
4. For sealing rotation, check the saved ChatGPT sign-in and use each account and repository secret after promotion. Reading stored material re-seals it with the current key. Opening a metadata-only secret list leaves the ciphertext untouched. Re-save dormant values individually or retain the previous key until every needed value has been migrated. Allow pending sign-in attempts to finish or expire. Verify a restored copy with only the new key before dropping the previous key from servers. Keep the old key protected alongside any historical backups that still require it.

### Revoke one user's platform sessions

**Settings → Sign-in → Sign out everywhere** ends the current browser session and the user's other platform sessions. To do the same as an operator, run the following inside the selected stack using its existing server configuration. Substitute the platform uid.

```sh
dc exec -T server node --import tsx src/revoke-user-tokens.ts u_example
```

The user's actor stores the new token generation durably and closes existing user and agent-session feeds. If a session actor is temporarily unreachable, the server retries its feed cleanup. Every subsequent user action checks the new generation. Their next login receives that generation. Running agents, saved credentials, paired machines and independently managed API tokens keep working. Restoring actor data also restores the generations in that backup. After a restore, revoke affected uids again before reopening the gateway if more recent sign-outs must be honored.

## Backup and restore

Use a Linux amd64 or arm64 host with curl, GNU tar and coreutils, `flock`, Python 3, gzip and the AWS CLI for S3. Grant the backup credentials list/get/put/delete access to the project's prefix. Provide the backup environment through the operator's secret store. The scripts use a separate set of names from the platform's sandbox bucket.

| Purpose | Variables |
|---|---|
| S3-compatible destination | `SELFHOST_BACKUP_ENDPOINT`, `SELFHOST_BACKUP_REGION`, `SELFHOST_BACKUP_BUCKET`, `SELFHOST_BACKUP_ACCESS_KEY_ID`, `SELFHOST_BACKUP_SECRET_ACCESS_KEY` |
| Encryption and recovery | `SELFHOST_BACKUP_AGE_RECIPIENT` (public key), `SELFHOST_BACKUP_AGE_IDENTITY` (identity file path at restore time) |
| Retention and local directory backend | `SELFHOST_BACKUP_KEEP`, `SELFHOST_BACKUP_DIR` |

Generate an age keypair on the recovery machine with `age-keygen -o windlass.agekey`. Keep the private identity off the platform host, with a protected recovery copy. Give the backup job only the public recipient (`age-keygen -y windlass.agekey`). The scripts download [age v1.3.2](https://github.com/FiloSottile/age/releases/tag/v1.3.2) for the host architecture and verify the release archive against its pinned SHA-256 before extracting the binary on each use. For offline operation, pre-stage the matching release tarball in `tools/` beside the stack env file. Protect temporary plaintext tar files and allow space for both the gzip and encrypted archive.

```sh
export SELFHOST_BACKUP_AGE_RECIPIENT='age1...'  # public recipient
archive=$(deploy/selfhost/backup.sh "$stack")
# On the recovery machine, with the same store configuration:
export SELFHOST_BACKUP_AGE_IDENTITY=/secure/recovery/windlass.agekey
fresh=$(deploy/selfhost/restore.sh "$stack" "$archive")
```

Both services must be running before a backup. The script stops the server first so actors can finish shutdown, stops the engine, checks both exit statuses and archives the whole mounted volume. The engine CLI exposes storage operations but no whole-engine online snapshot command. Stopping all writers gives the log and object store a common point in time. Right after the local tar copy the script starts the engine, waits until it reports ready (see [Engine readiness](#engine-readiness), up to `SELFHOST_ENGINE_READY_TIMEOUT`, default 1,500 s), starts the server, and then compresses, encrypts and publishes the archive. If the engine does not become ready, the server stays stopped, the archive is still published and the script exits with an error. An interrupted copy triggers the same restart. The lock, the age cache and the uncompressed tar go in the stack env file's directory, so allow space there for the tar and archive. Downtime depends on graceful shutdown, data size and disk throughput. Check `dc ps` after recovery.

Objects are stored at `<bucket>/<compose-project>/<archive-basename>`. After a successful upload, retention keeps the newest N timestamped snapshots for that project (default seven). Other object names and other projects' prefixes are preserved. On a versioned S3 bucket configure a bucket lifecycle for old versions and abandoned multipart uploads. For a local-only drill set `SELFHOST_BACKUP_DIR` to a private directory. It takes precedence over S3. Only a local directory accepts an explicit plaintext backup: unset the recipient and set `SELFHOST_BACKUP_PLAINTEXT=1`. Both backends can restore legacy `.tar.gz` objects. Retention counts those alongside `.tar.gz.age` snapshots. Existing plaintext objects and older bucket versions need a separate retirement decision after a verified encrypted restore.

Restore loads a named archive into a newly generated volume, prints its name and leaves the running stack alone. For a replacement host, build or load the matching engine image first. Restore the original stack secrets, project and canonical origin. To switch volumes during a maintenance window, stop the services, save the previous volume name, edit `SELFHOST_VOLUME` in the private stack env file to the printed name, and run `dc up -d --no-build --wait --wait-timeout 1500`. Verify a known user's session and timeline before retiring the previous volume. A smoke-test proof can be checked with the command below. These archives cover engine state. Runner workspaces, credentials on the runner, sandbox files, and optional bucket contents have independent backup requirements.

## Test the stack

Install workspace dependencies using `pnpm install --frozen-lockfile`. Run from the repository root against a local, demo-enabled stack with fake sandboxes.

```sh
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --sessions 4 --minutes 25 --burners --interval 10 --baseline 60 \
  --proof .data/selfhost/load-proof.json
# After restoring and switching to the new volume:
server/node_modules/.bin/tsx scripts/selfhost-load.ts \
  --origin http://127.0.0.1:16440 --project wlp-staging \
  --verify .data/selfhost/load-proof.json
```

The generator signs in as a new demo user, pairs an in-process runner, opens K independent sessions and sends each another short turn after its previous turn ends. The fixture spaces ACP thoughts, text, tool calls and plan updates 250 ms apart. The optional burners are isolated, networkless containers with the agent CPU and memory settings above. An idle baseline precedes load. The test lets in-flight turns finish, removes the burners and samples recovery. It retains the demo account and timeline on the test stack. The optional mode-600 proof contains a demo credential and a digest of the persisted timeline. Use a fresh proof filename for each run.

Every probe interval launches four concurrent reads, with a 30 s deadline per read. The page probe reads and checks the HTML. Actor probes use the browser's scoped token and read the user's session list, models and one rotating session's snapshot. The report prints successful-sample p50/p95/max in milliseconds (nearest rank), errors, completed turns, streamed updates, log severity and stall-signature counts, and engine/server restart deltas per run. Samples are grouped by request start time into idle, first 15 minutes, subsequent load and recovery. The load test can be interrupted with Ctrl-C.

The served page allows scripts and fonts from its own origin, inline styles, and HTTP and WebSocket connections to the configured `WLP_PUBLIC_ENDPOINT` origin. Set this endpoint at runtime when using a custom gateway. The page forbids framing. An HTTPS `WLP_PUBLIC_URL` enables one-year HSTS on web responses, including behind a tunnel that reaches the server over HTTP.

To check the built app on a loopback demo stack, run `node scripts/selfhost-csp-check.cjs http://127.0.0.1:16440` with Playwright and its Chromium available to Node. Set `CHROMIUM_EXECUTABLE` to use an installed Chromium. The check signs in to the demo, receives a user actor WebSocket frame, and attempts an inline script insertion in the rendered page.

## Logs, upgrade and rollback

```sh
dc ps
dc logs --since 10m engine server
dc logs -f server
```

Docker rotates the services' JSON logs at 32 MiB with up to three files per service. Inspect the node's health and gateway token availability after restarts. Restrict access to raw logs.

The platform and the runner name the log driver of every container they start, whatever the daemon's default. Session, relay, egress and helper containers use `--log-driver none`: nothing reads those logs, and an agent can write to its session container's main process output, so a default unbounded log would let it fill the host's disk. The runner's own container, started by setup's printed command or the Machines page, uses `--log-driver json-file --log-opt max-size=16m --log-opt max-file=3`, and `docker logs windlass-runner` still works. Containers created before that change keep the log settings they were created with until they are replaced.

### Releasing to a running stack

`release.sh <stack env file>` releases the checked-out commit. It builds the server image, then backs up first only when the newest backup is older than `SELFHOST_RELEASE_BACKUP_MAX_AGE_HOURS` (default 6; a backup restarts the engine). Then it replaces only the server. The engine is replaced only when its image or its Compose definition differs from the running container. In that case the server is stopped first, and it starts once the engine reports ready (see Engine readiness). On failure the previous env file is put back and the previous release started again. `SELFHOST_RELEASE_DRY_RUN=1` prints the plan and changes nothing. The script's header lists the other settings: history and log directories, minimum free disk, backup command and wait times.

```sh
SELFHOST_RELEASE_DRY_RUN=1 deploy/selfhost/release.sh "$ENV"
deploy/selfhost/release.sh "$ENV"
```

### Docker daemon settings

On a platform host, set `live-restore` and a bounded default log in `/etc/docker/daemon.json`, for the containers that set none themselves (a tunnel connector, for example):

```json
{ "live-restore": true, "log-driver": "json-file", "log-opts": { "max-size": "16m", "max-file": "3" } }
```

Validate the file before anything reads it, because dockerd refuses to start with a bad one: `sudo dockerd --validate --config-file /etc/docker/daemon.json`. `sudo systemctl reload docker` applies `live-restore`. Log options apply only after a dockerd restart, and only to containers created after it. The next reboot does that restart. To do it sooner:

1. Check `docker info --format '{{.LiveRestoreEnabled}}'` prints `true`. Without it the restart stops every container, and session containers (`restart=no`) do not come back.
2. Check no turn is running: `docker exec windlass-runner windlass-runner status` lists no sandbox as `running`, and `docker ps --filter label=dev.windlass-platform.session --filter status=running -q` prints nothing. Keep the restart short: containers block once their output buffer fills while the daemon is down.
3. Record `docker ps --format '{{.Names}} {{.RunningFor}}'`, run `sudo systemctl restart docker`, and run the same command again. Every container is still listed with the same age, which shows they kept running.
4. Check the stack: `dc ps` shows both services healthy, `curl -fsS http://127.0.0.1:26440/health` succeeds, the public origin answers, and `windlass-runner status` shows the runner online.
5. Check the new default on a container that is never started: `docker create --name wlp-log-default <any local image> true`, then `docker inspect -f '{{json .HostConfig.LogConfig}}' wlp-log-default` shows `json-file` with `max-size` 16m and `max-file` 3, then `docker rm wlp-log-default`.

Never set `"debug": true` on a platform host: debug output can carry the values of secret environment variables.

### Weekly conditional reboot

Unattended upgrades install security fixes daily but do not reboot. [`reboot-if-required.sh`](reboot-if-required.sh) reboots only when `/var/run/reboot-required` exists. It first waits up to `WLP_REBOOT_WAIT_MINUTES` (90) for the host to be idle: the runner (`WLP_RUNNER_CONTAINER`, default `windlass-runner`) lists no sandbox as `running`, no session container runs on the daemon, and apt is not upgrading. The runner's `status` reports container state, not turns, so a sandbox that has not yet been suspended after its last turn also counts as busy. Next it runs the backup command (`WLP_REBOOT_BACKUP`) as `WLP_REBOOT_BACKUP_USER`, checks again that the host is idle, and reboots. A runner that cannot report, a busy host after the wait, or a failed backup skips the reboot until the next week. `--dry-run` runs the checks and stops before the backup.

[`systemd/windlass-reboot.timer`](systemd/windlass-reboot.timer) runs it on Sundays at 04:00 UTC, and does not catch up on a missed run. The service runs a root-owned copy in `/usr/local/sbin`, never the file in a checkout that other users can write. `check-reboot.sh` exercises the script against stand-in commands. Install it from a checkout of the deployed release:

```sh
deploy/selfhost/check-reboot.sh
sudo install -o root -g root -m 755 deploy/selfhost/reboot-if-required.sh /usr/local/sbin/windlass-reboot-if-required
sudo install -o root -g root -m 644 deploy/selfhost/systemd/windlass-reboot.service deploy/selfhost/systemd/windlass-reboot.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now windlass-reboot.timer
systemctl list-timers windlass-reboot.timer
```

Edit the service's `Environment=` lines for another backup command or user first. Read its runs with `journalctl -u windlass-reboot.service`. Compose services, the runner and the tunnel restart by their `unless-stopped` policies after the reboot. Session containers do not: the platform replaces them on the next turn. The reboot's backup counts toward `SELFHOST_BACKUP_KEEP`.

### Keep live env files outside the checkout

The stack env file and the server env file hold every deployment secret. Keep a live stack's two files in a mode-700 directory outside every Git checkout, so that a process working in a checkout or one of its worktrees never finds them. `SELFHOST_ENV_DIR` tells `init-env.sh` where to create them; it also writes `SELFHOST_SERVER_ENV_FILE` into the stack env file. Run `deploy/selfhost/check-env-files.sh "$stack"` after any change. It checks that both files are regular mode-600 files of the current user, in directories no other user can enter, outside every checkout, and that a stack without demo sign-in resolves an allowlist. It prints only verdicts.

To move an existing stack, back it up, copy both files with `cp -p` into the new directory, set `SELFHOST_SERVER_ENV_FILE` in the copied stack env file to the copied server env file's absolute path, run the check, then recreate the server with the new `--env-file`. Update every job that names the old path, such as a backup cron entry. Delete the old copies only after the server is healthy. The server env file is optional to Compose, so a stack that silently loses it also loses its allowlist. The check refuses a missing one.

1. Record the current Git revision, engine and server image tags, private configuration and volume name. Take a backup at a quiet point.
2. Build the new revision under a new `SELFHOST_RELEASE` tag and increase `RIVET_NODE_VERSION`. Run `dc build` and test it in staging.
3. For a release that changes only the server, run `dc up -d --no-build --no-deps --wait server`. The engine keeps running. When the engine image or its service definition changed (`dc config --hash engine` differs from the engine container's `com.docker.compose.config-hash` label), use a maintenance window: `dc stop server`, then `dc up -d --no-build --no-deps --wait --wait-timeout 1500 engine`, then `dc up -d --no-build --no-deps --wait server`. Check the web page, token issuance and a known actor read.
4. To roll back, select the previous sources (including the bootstrap script), prior images and configuration. If the new engine or actor code migrated data, restore the pre-upgrade backup to a fresh volume and point `SELFHOST_VOLUME` there before restarting. Writes since that backup remain on the upgraded volume. Keep both volumes until verification is complete.

## Rivet 3.1.1 implementation references

The installed SDK reads the endpoint, token, namespace, pool and node version, then starts the serverful registry. The engine CLI resolver selects the static Linux binary for the architecture. The installed generated API declares namespace creation and the pool upsert. [SDK environment](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/utils/env-vars.ts) · [Registry configuration](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/registry/config/index.ts) · [Registry listener](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/registry/index.ts) · [Pool API](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/rivetkit/src/engine-client/api-endpoints.ts) · [CLI resolver](https://github.com/rivet-dev/rivet/blob/v3.1.1/rivetkit-typescript/packages/engine-cli/index.js)

The npm engine package contains the executable. The matching tagged Rust source defines the two persistent paths, automatic single-node partition provisioning, environment overrides, admin authentication and derivation of the JWT issuer from the leader's public URL. [Storage validation](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/mod.rs) · [Storage log and partitions](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/depot.rs) · [Filesystem object store](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/object_storage.rs) · [Configuration loader](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/lib.rs) · [Topology](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/topology.rs) · [Authentication](https://github.com/rivet-dev/rivet/blob/v3.1.1/engine/packages/config/src/config/auth.rs)
