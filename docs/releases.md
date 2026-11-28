# Runner image releases

A runner release contains six Linux image indexes in GHCR. Each index contains native amd64 and arm64 manifests. The runner embeds the five sibling index digests. Docker selects the matching manifest and verifies the digest on pull. The egress proxy, forward helpers and Claude, OpenCode and Codex relays use the base sandbox with scripts shipped in the runner.

| Entry in `release.json` | GHCR package under `ghcr.io/windlassai/` |
| --- | --- |
| `runner` | `windlass-runner` |
| `sandbox` | `windlass-platform-sandbox` |
| `sandbox-shots` | `windlass-platform-sandbox-shots` |
| `claude` | `windlass-platform-claude` |
| `codex` | `windlass-platform-codex` |
| `opencode` | `windlass-platform-opencode` |

## Verify before setup

Choose the published runner tag on the [release page](https://github.com/WindlassAI/windlass-platform/releases). Use cosign v3 and set `tag` to that exact tag. Both commands check the same GitHub Actions workflow identity and issuer.

```sh
tag=runner-v0.3.10  # replace with the chosen release
repo=WindlassAI/windlass-platform
gh release download "$tag" --repo "$repo" -p release.json -p release.json.sigstore.json
signer="https://github.com/$repo/.github/workflows/release-images.yml@refs/tags/$tag"
issuer=https://token.actions.githubusercontent.com

cosign verify-blob --bundle release.json.sigstore.json \
  --certificate-identity "$signer" --certificate-oidc-issuer "$issuer" release.json

runner=$(jq -er '.images.runner | .ref + "@" + .index' release.json)
cosign verify --certificate-identity "$signer" --certificate-oidc-issuer "$issuer" "$runner"
printf '%s\n' "$runner"
```

Compare the full reference printed above with the runner digest in the Machines setup command. Start setup with that verified reference. It checks the daemon architecture, pulls the base sandbox and each selected harness, and displays Docker's progress before pairing. Add `--screenshots` to fetch and enable the screenshots variant. The service command printed after pairing reuses the verified reference. A locally built runner started by tag or ID prints its local immutable ID.

## Cut a release

1. Update the version in `runner/package.json` for the release and merge the reviewed change into `main`. The runner at this revision reports `0.3.10`.
2. Dispatch a dry build from reviewed `main` using the runner package's version. Use an unpublished version for a new release.

   ```sh
   repo=WindlassAI/windlass-platform
   version=$(node -p "require('./runner/package.json').version")
   tag=runner-v$version
   gh workflow run release-images.yml --repo "$repo" --ref main -f version="$version" -f push=false
   ```

3. Open that dispatch in Actions. Check that the base sandbox, screenshots sandbox, Claude, OpenCode and Codex jobs succeeded on **both** amd64 and arm64. The harness jobs use the dry run's native base OCI archive. On the first release, the runner job records a skip because there is no previously published manifest with all five sibling pins. Once the dry run succeeds, copy its run ID into the commands below. Tagging that run's exact commit keeps a later merge to main out of the release.

   ```sh
   run_id=123456789  # replace with the successful dry run ID
   commit=$(gh run view "$run_id" --repo "$repo" --json headSha --jq .headSha)
   git fetch origin main
   git tag "$tag" "$commit" &&
     git push git@github.com:WindlassAI/windlass-platform.git "refs/tags/$tag"
   ```

4. Wait for the tag workflow. It publishes the six indexes under `runner-v<version>` and `sha-<12 commit characters>`, with BuildKit provenance, SBOMs and keyless cosign signatures. It signs the manifest and verifies the runner's embedded pins and all six index signatures before creating the draft. To retry a failed run, use **Re-run failed jobs** on that tag run or dispatch the workflow at the same tag with its version and **push** enabled.
5. As the owner, download both draft assets into an empty directory and verify the manifest signature using **Verify before setup**. Compare its version and commit with the tag and dry-run commit. Review the Windlass and harness versions and both platform digests for each image. Check all six GHCR packages. If one is private, open its **Package settings → Change visibility → Public**. GitHub makes that change permanent. Verify the runner signature at the digest in that manifest.
6. On a clean Docker host, test anonymous pulls of every verified index with empty registry credentials. Publish the draft after all six pulls succeed.

```sh
(
  set -eu
  docker_config=$(mktemp -d)
  trap 'rm -rf "$docker_config"' EXIT
  export DOCKER_CONFIG="$docker_config"
  jq -er '.images[] | .ref + "@" + .index' release.json > "$docker_config/refs"
  while IFS= read -r ref; do docker pull "$ref"; done < "$docker_config/refs"
)
```

Publish the reviewed draft in GitHub Releases. For deployment, upgrade all server nodes first, leaving their existing runner settings in place. Signed runner connections use protocol 2. At cutover, install the certified online platform key, set `WLP_REQUIRE_SIGNED_RUNNER=1` on every server, and advertise the verified `WLP_RUNNER_IMAGE` together with the `WLP_RUNNER_CAPABILITIES` read from that image. Recreate the servers, check health, and re-pair each machine. Compare the root fingerprint printed during pairing with the owner's offline copy. [Self-hosted cutover commands](../deploy/selfhost/README.md#enable-signed-runner-connections)

## A release with session copies on machines

The first runner release after 0.3.11 carries the `session-backups` capability: the runner keeps copies of
its Claude Code, Codex, OpenCode and own-volume Windlass sessions in `wlp-machine-<machine id>-backups` on
the machine ([architecture.md](architecture.md#on-a-machine-the-copy-stays-on-the-machine)). As for every
capability, deploy the server first, then publish the runner. A server of this revision names the
capability to every runner; an older runner ignores the name and keeps no copies, with no error. A newer
runner on an older server is not asked for it, sends no `sessionBackups` field and no `backup-forgotten`
frame, and keeps no copies. Bump `runner/package.json` for that release, refresh `WLP_RUNNER_CAPABILITIES`
from the new image (its `capabilities` command lists `session-backups`), and after the swap check one
machine session: a turn logs `[wlp] backup.saved`, `docker volume ls` shows the backups volume, and
removing the session's container then sending a prompt logs `[wlp] backup.restored`.

## Developer checks

From the workspace root, `pnpm check:release` checks workflow permissions, action pins, build arguments, bundle scanning and the release gate. The setup and architecture regressions run with `node --test scripts/runner-setup-check.mjs`. Run `actionlint .github/workflows/ci.yml .github/workflows/release-images.yml` to check Actions syntax and expressions.

`sandbox/build.sh --context <empty-dir>` stages the checksum-pinned native binary and Dockerfile. Set `WLP_SANDBOX_VARIANT=shots` for the screenshots context. `scripts/runner-build.sh --screenshots <sandbox-pin> <shots-pin>` accepts `WLP_RUNNER_HARNESSES="claude=<ref>@<digest> opencode=<ref>@<digest> codex=<ref>@<digest>"`. Local builds print the image ID. `WLP_RUNNER_PLATFORMS` and `WLP_RUNNER_ARCHIVE` select OCI export. The release workflow uses `WLP_RUNNER_PUSH=ghcr.io/windlassai/windlass-runner:runner-v<version>` and captures the pushed index digest.

## Verify on Docker Desktop

On Apple silicon, enable the default Docker socket and the containerd image store. Record `docker version`, `docker info --format '{{.Driver}} {{.DriverStatus}}'` and `docker run --rm alpine uname -r`. Set `platform_url` to your platform’s public origin, verify the release above, then start setup with the selected harnesses and restricted egress.

```sh
docker run -it --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v windlass-runner:/var/lib/windlass-runner "$runner" setup \
  --platform "$platform_url" --name MacBook \
  --harness claude --harness opencode --harness codex --egress restricted
```

Approve pairing, compare the displayed platform fingerprint with the offline copy, sign in, and start the printed service command. Record the pulls, service restart policy, internal session network, egress helpers and relay socket volumes. Check that each relay uses its Unix socket and has no published host port. Complete a Claude turn, an OpenCode public-model turn and a Codex API-key turn. See [Codex device-login validation](codex.md) for the separate owner check. From a restricted Claude session, check that unlisted public sites, the host, LAN gateway and cloud metadata addresses are refused. Confirm the session sees only the relay placeholder and record the Machines page's command-sandbox probe on LinuxKit.

Restart Docker Desktop, then test sleep and wake with an idle session. Confirm reconnection and that logging Claude out makes the next Claude turn report signed out. Record the results with the release checks.
