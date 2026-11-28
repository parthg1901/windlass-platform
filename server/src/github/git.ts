import { mirrorStage } from "../sandbox/git-mirrors.js";
import { MIRROR_BYTES, MIRROR_CONFIG, MIRROR_ROOT } from "../sandbox/store-limits.js";
import { RUNNER_HTTP_PROXY } from "../runner/egress.js";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type { ExecResult, SandboxHandle } from "../sandbox/api.js";
import type { WorkDiff } from "../verified.js";
import { GithubProblem } from "./problem.js";
import { redact } from "./redact.js";
import { SAFE_FLAGS, TRANSPORT_FLAGS } from "./git-flags.js";
import { errorText, shellQuote } from "../util.js";

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
// A reference clone that receives nothing for this long is abandoned for a plain clone.
// Local work (the dissociating repack, checkout, checks) is not on this clock.
const MIRROR_STALL_SECONDS = 8;
// A push is one action of the session's actor, which may take two minutes in all: the commit and the push fit in it together.
const COMMIT_TIMEOUT_MS = 30 * 1000;
const PUSH_TIMEOUT_MS = 70 * 1000;
const PROBE_TIMEOUT_MS = 20 * 1000;

const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** A branch name git and GitHub would accept, as far as it matters for a command line. */
export function isBranchName(name: unknown): name is string {
	return (
		typeof name === "string" &&
		name.length > 0 &&
		name.length <= 250 &&
		!name.startsWith("-") &&
		!name.startsWith("/") &&
		!name.endsWith("/") &&
		!name.endsWith(".lock") &&
		!name.includes("..") &&
		!/[\u0000- ~^:?*[\\\u007f]/.test(name)
	);
}

/** `https://github.com`: what the credential helper answers for, and nothing else. */
function hostOf(url: string): string {
	const parsed = new URL(url);
	return `${parsed.protocol}//${parsed.host}`;
}

// Keep env -i for platform Git. Only the known runner endpoint may enter its clean environment.
const GIT_PROXY = `wlp_proxy=''
if [ "\${https_proxy:-}" = '${RUNNER_HTTP_PROXY}' ]; then wlp_proxy='${RUNNER_HTTP_PROXY}'; fi`;
const PROXY_ENV = 'http_proxy="$wlp_proxy" https_proxy="$wlp_proxy"';

/**
 * Use stdin and fd 3 so the token never reaches argv, the exported environment or disk.
 */
type GitUsername = "oauth2" | "x-access-token";

function tokenGit(host: string, username: GitUsername = "x-access-token"): string {
	const transportFlags = [
		'-c http.proxy="$wlp_proxy"',
		"-c http.sslVerify=true",
		"-c http.sslCAInfo=/etc/ssl/certs/ca-certificates.crt",
		"-c http.followRedirects=false",
		"-c core.sshCommand=/bin/false",
		"-c core.askPass=/bin/false",
		"-c push.followTags=false",
		"-c push.recurseSubmodules=no",
	].join(" ");
	const helper = `!f() { test "$1" = get || exit 0; echo username=${username}; printf password=; cat <&3; echo; }; f`;
	return [
		GIT_PROXY,
		"wlp_git() {",
		`	printf '%s' "$WLP_T" | {`,
		`		env -i ${PROXY_ENV} PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 \\`,
		"			GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false SSH_ASKPASS=/bin/false GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CEILING_DIRECTORIES=/tmp GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=http:https GIT_SSH=/bin/false \\",
		"			GIT_CONFIG_COUNT=2 \\",
		"			GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \\",
		`			GIT_CONFIG_KEY_1=${shellQuote(`credential.${host}.helper`)} GIT_CONFIG_VALUE_1=${shellQuote(helper)} \\`,
		`			git ${TRANSPORT_FLAGS} ${transportFlags} "$@" 3<&0 0</dev/null`,
		"	}",
		"}",
	].join("\n");
}

/** Git with an empty environment and no configuration but its own, for the steps of a token script that need no token. */
const GIT_ENV = `env -i PATH=${SYSTEM_PATH} HOME=/nonexistent LANG=C.UTF-8 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1`;
const PLAIN_GIT = `plain_git() { ${GIT_ENV} git ${SAFE_FLAGS} "$@" </dev/null; }`;

/** Defense in depth: refuse repository-defined programs, redirects and included configuration
 * even though Git only uses the platform's private config. The guard reads keys as inert data. */
const UNSAFE_KEYS = String.raw`^(filter\.|diff\.external$|diff\..+\.(command|textconv)$|merge\..+\.driver$|core\.(sshcommand|pager|editor|worktree|gitproxy|askpass|alternaterefscommand)$|include\.|includeif\.|credential\.|gpg\.|url\.|protocol\.|remote\..+\.(uploadpack|receivepack|vcs)$|uploadpack\.|submodule\..+\.update$|ssh\.)`;

// This helper is shipped with the server and passed as script text to the sandbox. -I keeps
// workspace modules and Python's user site out of its imports.
declare const PRIVATE_GIT_SOURCE: string;
const BRIDGE = `bridge() { local action="$1"; shift; python3 -I -c ${shellQuote(typeof PRIVATE_GIT_SOURCE === "string" ? PRIVATE_GIT_SOURCE : readFileSync(new URL("./private-git.py", import.meta.url), "utf8"))} "$action" "$private" "$@"; }`;

const WORKSPACE_GUARD = [
	"wlp_guard() {",
	`  git config --no-includes --file "$private/guard-config" --list --name-only > "$private/keys"`,
	`  bad=$(grep -iE ${shellQuote(UNSAFE_KEYS)} "$private/keys" | head -1)`,
	`  if [ -n "$bad" ]; then echo "wlp:unsafe $bad"; exit 3; fi`,
	`  links=$(set -o pipefail; git ls-files --stage | awk '/^160000 / {found=1} END {print found+0}') || { echo "wlp:unsafe unreadable"; exit 3; }`,
	`  if [ "$links" != 0 ]; then echo "wlp:unsafe gitlink"; exit 3; fi`,
	// The find child gets the same private git directory and clean config as the parent.
	`  nested=$(${GIT_ENV} GIT_DIR="$private/repo" GIT_WORK_TREE="$tree" timeout 4s find . -path ./.git -prune -o -type d -name node_modules -exec git ${SAFE_FLAGS} check-ignore -q -- {} \\; -prune -o -name .git -printf x -quit) || { echo "wlp:unsafe unreadable"; exit 3; }`,
	`  if [ -n "$nested" ]; then echo "wlp:unsafe nested"; exit 3; fi`,
	"}",
].join("\n");

const READ_TOKEN = `PATH=${SYSTEM_PATH}\nexport PATH\nIFS= read -r WLP_T || true`;

// Workspace staging has a temporary repo, index and config. Direct agent commands share
// this uid. Only a verified object pack crosses into the transport user's repository.
function privateStart(options: { refs?: string[]; missing?: "nothing" | "norepo"; fetch?: boolean } = {}): string {
	const refs = (options.refs ?? []).map(shellQuote).join(" ");
	const missing = options.missing
		? ` || { rc=$?; if [ "$rc" = 2 ]; then echo "wlp:${options.missing}"; exit 0; fi; exit "$rc"; }`
		: "";
	return [
		"set -eu",
		`export PATH=${SYSTEM_PATH}`,
		"umask 077",
		PLAIN_GIT,
		BRIDGE,
		"private=$(mktemp -d /tmp/wlp-git.XXXXXXXX)",
		`trap 'rm -rf -- "$private"' EXIT`,
		"tree=$(pwd -P)",
		'plain_git -C "$private" init --quiet --bare --template= "$private/repo"',
		`bridge ${options.fetch ? "fetch" : "import"} ${refs}${missing}`,
		'git() { plain_git -C "$tree" --git-dir="$private/repo" --work-tree="$tree" "$@"; }',
		WORKSPACE_GUARD,
		"wlp_guard",
	].join("\n");
}

const COMMIT_PATHS = ". ':(exclude,top).wlp-shots'";
const VERIFY_OBJECTS = "git fsck --full --no-reflogs --no-dangling --no-progress >/dev/null";

function capture(paths = "."): string {
	return [
		`git ls-files -z --cached --others --exclude-standard -- ${paths} > "$private/paths"`,
		"bridge capture",
		'tree="$private/tree"',
	].join("\n");
}

export const WORKSPACE_HEAD_COMMAND = privateStart() + "\ngit rev-parse --verify 'HEAD^{commit}'";
export const WORKSPACE_GIT_START = privateStart() + "\n" + capture();

/** Plain clones run during initial sandbox setup. */
export const CLONE_GIT_START = [
	`export PATH=${SYSTEM_PATH}`,
	`if [ -e .git ] || [ -L .git ]; then (\n${privateStart()}\n); fi`,
	GIT_PROXY,
	`git() { ${GIT_ENV} ${PROXY_ENV} git ${SAFE_FLAGS} -C / "$@" </dev/null; }`,
].join("\n");

/**
 * Clones into the workspace. A new sandbox's workspace holds an empty repository and nothing else, which
 * the clone replaces; if anything else is there, the clone goes into a directory of its own.
 */
export function cloneCommand(repoUrl: string): string {
	const url = shellQuote(repoUrl);
	const name =
		(repoUrl.replace(/\/+$/, "").split("/").pop() ?? "repo").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-") ||
		"repo";
	return [
		"set -e",
		CLONE_GIT_START,
		`if [ -z "$(ls -A | grep -v '^\\.git$' || true)" ]; then`,
		"  rm -rf .git",
		`  git clone --quiet -- ${url} "$(pwd -P)"`,
		"else",
		`  git clone --quiet -- ${url} "$(pwd -P)"/${shellQuote(name)}`,
		"fi",
	].join("\n");
}

/** The sentence for a workspace `wlp_guard` refused: `what` is the key or ".git". */
export function unsafeWorkspace(what: string): string {
	if (what === "gitlink" || what === "nested")
		return "The workspace contains a submodule or a nested git repository. Remove the gitlink or move the nested repository outside the workspace before retrying.";
	if (what === "unreadable")
		return "The platform could not finish checking the workspace for nested git repositories. The git operation was stopped.";
	const named =
		what === ".git"
			? "its .git is not the repository's own directory (a file, a link, or one that borrows another repository's configuration)"
			: `its git configuration sets ${what}`;
	return `The workspace's git settings were changed in a way the platform does not run: ${named}, under which git would start a program of the repository's outside the agent's sandbox. Nothing was pushed or read. Undo that change in the workspace (git config --unset, or put .git back), or start a new agent.`;
}

function transportDirectory(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Git transport directory identifier.");
	return `/tmp/wlp-transport-${id}`;
}

function startTransport(id: string): string {
	return `set -eu
export PATH=${SYSTEM_PATH}
umask 077
private=${shellQuote(transportDirectory(id))}
mkdir -m 700 -- "$private"
cd -- "$private"`;
}

async function removeTransport(sandbox: SandboxHandle, id: string, keepStage = false): Promise<void> {
	const paths = [transportDirectory(id), ...(keepStage ? [] : [transportDirectory(id) + ".mirror"])]
		.map(shellQuote)
		.join(" ");
	await sandbox
		.run(`/bin/rm -rf -- ${paths}`, { gitUser: true, cwd: "/", timeoutMs: PROBE_TIMEOUT_MS })
		.catch(() => undefined);
}

/**
 * Stage what a mirror would be built from, in a directory private to the transport uid: the
 * clone's remote refs as branches, its HEAD, and hard links to its objects. No second network
 * fetch, workspace file, remote config or credential. Nothing here writes the slot, which the
 * session sees read-only: a helper container outside the session verifies the stage with a full
 * fsck and installs it (git-mirrors.ts, `saveSessionMirror`). A stage whose refs match the
 * slot's mirror is not made unless `repair`, which marks the stage (`seed/repair`) so the helper
 * replaces the mirror anyway. The helper compares the refs again under the slot's save lock, since
 * another clone's save may have landed since. `partial` (a single-branch clone) only seeds an empty slot.
 */
function stageMirror(partial: boolean, repair: boolean): string {
	const stage = [
		"set -euo pipefail",
		PLAIN_GIT,
		'mkdir -m 700 -- "$3"',
		'cd -- "$3"',
		...(partial ? ['[ ! -e "$2/repo.git" ] || exit 1'] : []),
		"plain_git init -q --bare --template= seed",
		'if ref=$(plain_git -C "$1/repo" symbolic-ref -q refs/remotes/origin/HEAD); then head="refs/heads/${ref#refs/remotes/origin/}"; else head=$(plain_git -C "$1/repo" symbolic-ref HEAD); fi',
		'plain_git --git-dir=seed symbolic-ref HEAD "$head"',
		`plain_git -C "$1/repo" for-each-ref --format='%(objectname) %(refname) %(symref)' refs/remotes/origin refs/tags |`,
		`  awk 'NF == 2 { sub(/^refs\\/remotes\\/origin\\//, "refs/heads/", $2); print $1, $2 }' | LC_ALL=C sort -k2 > seed/packed-refs`,
		// The same refs as the slot's mirror: nothing to save. The helper compares again under its lock.
		...(repair
			? [": > seed/repair"]
			: [
					'if cmp -s seed/packed-refs "$2/repo.git/packed-refs" && cmp -s seed/HEAD "$2/repo.git/HEAD"; then exit 1; fi',
				]),
		"rm -r seed/objects",
		'cp -al "$1/repo/.git/objects" seed/objects',
		`[ "$(du -s -B1 seed | cut -f1)" -le ${MIRROR_BYTES - 65536} ]`,
		`[ "$(du -sb seed | cut -f1)" -le ${MIRROR_BYTES - 65536} ]`,
	].join("\n");
	return [
		`if mirror_ok && timeout -k 1s 10s /bin/bash -c ${shellQuote(stage)} mirror "$private" "$mirror" "$save" </dev/null >/dev/null 2>&1; then`,
		'	echo "wlp:mirrorsave"',
		'else rm -rf -- "$save"; fi',
	].join("\n");
}

/** `repair`: the reference attempt just failed on the mirror, so a plain clone replaces it even with the same refs. */
type MirrorAttempt = { owner: string; reference: boolean; repair?: boolean };

function mirrorPath(owner: string): string {
	if (!/^[0-9a-f]{64}$/.test(owner)) throw new Error("Invalid Git mirror owner.");
	return shellQuote(MIRROR_ROOT + "/" + owner);
}

/** Check before minting a token. The authenticated operation rechecks under its directory lock. */
export async function hasMirror(sandbox: SandboxHandle, owner: string, signal?: AbortSignal) {
	const path = mirrorPath(owner);
	const result = await sandbox
		.run(`mountpoint -q -- ${path} && test -d ${path}/repo.git/objects`, {
			gitUser: true,
			cwd: "/",
			timeoutMs: PROBE_TIMEOUT_MS,
			signal,
		})
		.catch(() => null);
	return result?.exitCode === 0;
}

/**
 * Clones `url` at `branch` into a new transport directory. Only the clone's files are made
 * readable to the workspace user after the authenticated operation finishes.
 *
 * With `work`, the branch the platform pushed the session's work to: the clone is of a sandbox made in
 * place of a lost one, and what was pushed is all that is left of the work. The clone has that branch
 * too (it fetches every branch), and says at which commit: `wlp:haswork <commit>`, or `wlp:nowork`
 * when GitHub no longer has it (deleted, say, after its pull request was merged). The workspace stays
 * on `branch` all the same: the repository's setup command runs there first, on what the session was
 * launched from. For a subtask, setup runs on the pinned feature seed and the saved publishing base
 * is the fetched feature tip. Setup never runs on what a session pushed (the command runs with
 * the network and every secret saved for the repository). `workCheckoutScript` puts it on the branch
 * afterwards. Neither step needs a token, and neither gets one.
 */
export function cloneScript(
	url: string,
	branch: string,
	id: string,
	work?: string,
	pinnedBase?: string,
	mirror?: MirrorAttempt,
	username?: GitUsername,
): string {
	if (pinnedBase !== undefined && !/^[0-9a-f]{40}$/.test(pinnedBase)) throw new Error("Invalid setup base SHA.");
	// Review clones need only the base ref. A pinned subtask also restores its feature or published branch.
	const cloneFlags = pinnedBase ? (work ? "--no-checkout " : "--single-branch --no-checkout ") : "";
	const featureRef = shellQuote("refs/remotes/origin/" + branch);
	const lines = [
		startTransport(id),
		READ_TOKEN,
		tokenGit(hostOf(url), username),
		"target=repo",
		...(mirror
			? [
					`mirror=${mirrorPath(mirror.owner)}`,
					`save=${shellQuote(mirrorStage(id))}`,
					// A stage left by a save that never ran (an interrupted turn, a lost server) goes now.
					'find /tmp -mindepth 1 -maxdepth 1 -user 65534 -name "wlp-transport-*.mirror" -exec rm -rf -- {} + 2>/dev/null || true',
					// The mount and its ancestors are platform-created, and read-only here. Older runners have no mount.
					'mirror_ok() { mountpoint -q -- "$mirror" && [ "$(stat -c %u:%a -- "$mirror")" = 65534:700 ]; }',
					// Readers share the slot lock; the helper's install swap and eviction take it exclusively.
					'lock_mirror() { mirror_ok && exec 9<"$mirror" && flock -s "$@" 9; }',
					// Only these failures are the mirror's: the clone is tried again without it.
					'mirror_fail() { echo "wlp:mirrorfail"; exit 4; }',
				]
			: []),
		...(mirror?.reference
			? [
					'lock_mirror -w 3 && [ -d "$mirror/repo.git/objects" ] || mirror_fail',
					`printf '%s\\n' ${shellQuote(MIRROR_CONFIG)} | cmp -s - "$mirror/repo.git/config" || mirror_fail`,
					'for f in alternates http-alternates; do p="$mirror/repo.git/objects/info/$f"; [ ! -e "$p" ] && [ ! -L "$p" ] || mirror_fail; done',
					// A reference clone that stalls is the mirror's failure; any other is GitHub's or the network's.
					`if ! wlp_git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=${MIRROR_STALL_SECONDS} clone --quiet --reference-if-able "$mirror/repo.git" --dissociate ${cloneFlags}--branch ${shellQuote(branch)} -- ${shellQuote(url)} "$target" 2>"$private/clone.err"; then`,
					'	cat -- "$private/clone.err" >&2',
					'	if grep -q "Operation too slow" -- "$private/clone.err"; then echo "wlp:mirrorfail"; fi',
					"	exit 1",
					"fi",
				]
			: [`wlp_git clone --quiet ${cloneFlags}--branch ${shellQuote(branch)} -- ${shellQuote(url)} "$target"`]),
		"WLP_T=",
		PLAIN_GIT,
		...(mirror
			? [
					`for f in alternates http-alternates; do p="$target/.git/objects/info/$f"; [ ! -e "$p" ] && [ ! -L "$p" ] || ${mirror.reference ? "mirror_fail" : "exit 4"}; done`,
					...(mirror.reference
						? [
								// Connectivity, not a rehash of every blob: every object in a slot was rehashed by
								// the helper's full fsck before it was installed, and sessions mount the slot
								// read-only. --dissociate copied what was used, and no alternates remain.
								'plain_git -C "$target" fsck --connectivity-only --no-reflogs --no-dangling --no-progress >/dev/null || mirror_fail',
								'echo "wlp:mirror reference"',
							]
						: []),
					stageMirror(cloneFlags.includes("--single-branch"), !!mirror.repair && !mirror.reference),
				]
			: []),
		...(pinnedBase ? [`plain_git -C "$target" checkout -q --detach ${pinnedBase}`] : []),
		`base_sha=$(plain_git -C "$target" rev-parse --verify ${work && pinnedBase ? featureRef : "HEAD"})`,
		'echo "wlp:base $base_sha"',
	];
	if (work !== undefined) {
		lines.push(
			`if at=$(plain_git -C "$target" rev-parse -q --verify ${shellQuote(`refs/remotes/origin/${work}^{commit}`)} 2>/dev/null); then`,
			`	echo "wlp:haswork $at"`,
			"else",
			...(pinnedBase
				? [`	at=$(plain_git -C "$target" rev-parse --verify ${featureRef})`, '\techo "wlp:haswork $at"']
				: []),
			`	echo "wlp:nowork"`,
			"fi",
		);
	}
	lines.push('chmod -R a+rX -- "$target"', 'chmod 711 -- "$private"');
	return lines.join("\n");
}

/**
 * Puts the clone in `directory` on the session's branch `work`, at the commit the clone fetched, once
 * the setup command has run on the base (`cloneScript`). Git uses the private repository. `-f` on purpose: what the setup did to tracked files (a
 * lockfile an install rewrote) goes, since the workspace must hold what the session pushed and nothing
 * else; what it made beside them (`node_modules`) stays. `wlp:work <commit>`.
 */
export function workCheckoutScript(directory: string, work: string, start?: string): string {
	if (start !== undefined && !/^[a-f0-9]{40}$/.test(start)) throw new Error("Invalid child start commit.");
	return [
		"set -eu",
		// Check the platform's clone itself, also when it was made under a nonempty workspace.
		`cd ${shellQuote(directory)}`,
		privateStart({ refs: [`refs/heads/${work}`] }),
		`git checkout --quiet -f -B ${shellQuote(work)} ${shellQuote(start ?? `refs/remotes/origin/${work}`)}`,
		`bridge export HEAD index ${shellQuote(`refs/heads/${work}`)}`,
		`echo "wlp:work $(git rev-parse HEAD)"`,
	].join("\n");
}

/** Merge the confirmed base without invoking workspace config or leaving conflict markers.
 * A deterministic commit lets a retry recognize its own checkout or push after a lost reply. */
export function mergeBaseForCi(
	sandbox: SandboxHandle,
	branch: string,
	base: string,
	baseSha: string,
	head: string,
	at: number,
	author: CommitInput["author"],
) {
	const date = shellQuote(new Date(at).toISOString());
	const ref = shellQuote("refs/heads/" + branch);
	const script = [
		privateStart({ refs: ["refs/heads/" + branch] }),
		`[ "$(git symbolic-ref HEAD)" = ${ref} ] || { echo "The workspace is on another branch." >&2; exit 1; }`,
		`original=${commitId(head)}; base=${commitId(baseSha)}; local_head=$(git rev-parse HEAD); remote=$(git rev-parse ${shellQuote("refs/remotes/origin/" + branch)})`,
		// On a retry the base may have advanced again. Reconstruct the merge already prepared for this answer.
		'candidate="$local_head"; if [ "$candidate" = "$original" ]; then candidate="$remote"; fi',
		'if [ "$candidate" != "$original" ]; then',
		'  prior=$(git rev-parse --verify "$candidate^2") && git merge-base --is-ancestor "$prior" "$base" || { echo "The item branch moved since CI." >&2; exit 1; }',
		'  base="$prior"',
		"fi",
		'if git merge-base --is-ancestor "$base" "$original"; then echo "The base no longer has new commits." >&2; exit 1; fi',
		'rc=0; git merge-tree --write-tree "$original" "$base" > "$private/merge" || rc=$?',
		'if [ "$rc" = 1 ] && [ "$candidate" = "$original" ]; then echo wlp:conflict; exit 0; fi',
		'[ "$rc" = 0 ] || exit "$rc"',
		`merged=$(${GIT_ENV} GIT_AUTHOR_DATE=${date} GIT_COMMITTER_DATE=${date} git ${SAFE_FLAGS} --git-dir="$private/repo" -c user.name=${shellQuote(author.name)} -c user.email=${shellQuote(author.email)} commit-tree "$(head -1 "$private/merge")" -p "$original" -p "$base" -m ${shellQuote("Merge " + base + " into " + branch)})`,
		'for tip in "$remote" "$local_head"; do [ "$tip" = "$original" ] || [ "$tip" = "$merged" ] || { echo "The item branch moved since CI." >&2; exit 1; }; done',
		'if [ "$local_head" != "$merged" ]; then',
		'  git diff --quiet HEAD -- || { echo "The workspace has uncommitted changes." >&2; exit 1; }',
		`  git checkout --quiet --no-overwrite-ignore -B ${shellQuote(branch)} "$merged"`,
		`  bridge export HEAD index ${ref}`,
		"fi",
		'echo "wlp:head $merged"',
	].join("\n");
	return run(sandbox, script, { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS });
}

/** Runs `workCheckoutScript`. */
export function checkoutWork(
	sandbox: SandboxHandle,
	directory: string,
	work: string,
	start?: string,
): Promise<GitOutcome> {
	return run(sandbox, workCheckoutScript(directory, work, start), { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS });
}

/** A prepared reviewer's setup belongs to the pinned base, which can predate the freshly fetched branch tip. */
export function checkoutPreparedReviewBase(sandbox: SandboxHandle, base: string, sha: string): Promise<GitOutcome> {
	if (!isBranchName(base) || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid review base");
	const script = [
		privateStart(),
		`git merge-base --is-ancestor ${sha} ${shellQuote("refs/remotes/origin/" + base)}`,
		`git checkout -q -f --detach ${sha}`,
		"bridge export HEAD index",
		'echo "wlp:work $(git rev-parse HEAD)"',
	].join("\n");
	return run(sandbox, script, { stdin: "", timeoutMs: COMMIT_TIMEOUT_MS });
}

/** Record the original workspace refs before fetching. Only the transport uid opens the token. */
async function fetchRefs(
	sandbox: SandboxHandle,
	token: string,
	url: string,
	directory: string,
	refs: Array<{ source: string; destination: string; optional?: boolean }>,
	signal?: AbortSignal,
	username?: GitUsername,
): Promise<GitOutcome> {
	const id = randomBytes(16).toString("hex");
	const stage = shellQuote(handoverDirectory(id));
	const transport = shellQuote(transportDirectory(id));
	const local = { stdin: "", timeoutMs: PROBE_TIMEOUT_MS, signal };
	const cd = `cd -- ${shellQuote(directory)}`;
	const prepare = await run(
		sandbox,
		[
			cd + " || exit 1",
			privateStart({ refs: refs.map(r => r.destination), fetch: true }),
			`mv -T "$private" ${stage}`,
		].join("\n"),
		local,
	);
	if (!prepare.ok) return prepare;
	try {
		const commands = [
			startTransport(id),
			READ_TOKEN,
			PLAIN_GIT,
			tokenGit(hostOf(url), username),
			"plain_git init --bare --quiet --template= repo",
		];
		for (const ref of refs) {
			const fetch = `wlp_git --git-dir="$private/repo" fetch --quiet --no-tags -- ${shellQuote(url)} ${shellQuote("+" + ref.source + ":" + ref.destination)}`;
			commands.push(ref.optional ? `if ${fetch}; then echo wlp:fetchedwork; fi` : fetch);
		}
		const base = refs[0]!;
		commands.push(
			"WLP_T=",
			`base_sha=$(plain_git --git-dir=repo rev-parse --verify ${shellQuote(base.destination + "^{commit}")})`,
			'echo "wlp:base $base_sha"',
			"chmod -R a+rX repo",
			'chmod 711 "$private"',
		);
		const fetched = await run(sandbox, commands.join("\n"), {
			gitUser: true,
			stdin: token + "\n",
			secrets: [token],
			timeoutMs: PUSH_TIMEOUT_MS,
			signal,
		});
		if (!fetched.ok) return fetched;
		const destinations = refs
			.filter(ref => !ref.optional || fetched.marks.has("fetchedwork"))
			.map(ref => shellQuote(ref.destination));
		const install = await run(
			sandbox,
			[
				"set -eu",
				cd,
				`private=${stage}`,
				BRIDGE,
				'rm -rf "$private/repo"',
				`cp -R -- ${transport}/repo "$private/repo"`,
				`bridge export ${destinations.join(" ")}`,
				"echo wlp:fetched",
			].join("\n"),
			local,
		);
		if (install.ok) for (const [key, value] of fetched.marks) install.marks.set(key, value);
		return install;
	} finally {
		await removeTransport(sandbox, id);
		await sandbox.run(`/bin/rm -rf -- ${stage}`, { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => undefined);
	}
}

export function reviewCheckoutScript(directory: string, head: string): string {
	if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("Invalid review head SHA.");
	// Setup has run here, and a retry can reuse a workspace where the reviewer ran commands.
	return [
		"set -eu",
		`cd ${shellQuote(directory)}`,
		privateStart({ refs: ["refs/wlp/review"] }),
		VERIFY_OBJECTS,
		`[ "$(git rev-parse --verify 'refs/wlp/review^{commit}')" = ${head} ] && git cat-file -e '${head}^{commit}' || { echo wlp:missing; exit 1; }`,
		`git checkout -q -f --detach ${head}`,
		`git reset -q --hard ${head}`,
		"git clean -q -fd",
		"rm -rf -- .wlp-shots",
		"bridge export HEAD index",
		'echo "wlp:review $(git rev-parse --verify HEAD)"',
	].join("\n");
}

/** A PR comment requests a source inspection. The transport user owns both the checkout and its
 * parent under sticky /tmp, so even an unattended agent with a shell cannot edit the reviewed tree. */
export async function readOnlyReview(
	sandbox: SandboxHandle,
	url: string,
	token: string,
	head: string,
	base: string,
	signal: AbortSignal,
	setupNotes?: { id: string; text: string }[],
	draft?: ReadonlyMap<string, string>,
): Promise<string> {
	if (![head, base].every(sha => /^[0-9a-f]{40}$/.test(sha))) throw new Error("Invalid review target.");
	const id = randomBytes(16).toString("hex");
	if (setupNotes?.some(n => !/^[a-f0-9]{20}$/.test(n.id))) throw Error("Invalid setup note id.");
	const inputs = (setupNotes ?? []).map(n => ({ path: "notes/" + n.id + ".md", text: n.text }));
	for (const [path, text] of draft ?? []) {
		if (path.split("/").some(s => !/^[\w.-]+$/.test(s) || [".", ".."].includes(s))) throw Error("Invalid draft path.");
		inputs.push({ path: "draft/" + path, text });
	}
	const script = [
		startTransport(id),
		READ_TOKEN,
		tokenGit(hostOf(url)),
		PLAIN_GIT,
		...inputs.map(({ path }) => {
			const file = ".windlass-inputs/" + path;
			return `mkdir -p -- '${file.slice(0, file.lastIndexOf("/"))}'; IFS= read -r encoded; printf %s "$encoded" | base64 -d > '${file}'; chmod 444 '${file}'`;
		}),
		...(inputs.length ? ["chmod -R a+rX,a-w .windlass-inputs"] : []),
		"plain_git init -q --template= repo",
		`wlp_git -C repo fetch --quiet --no-tags -- ${shellQuote(url)} ${base} ${head}`,
		"WLP_T=",
		`plain_git -C repo checkout -q --detach ${head}`,
		// Project hooks and agent definitions must stay inert during setup checks.
		...(setupNotes ? ["rm -rf -- repo/.git", "find repo -type l -delete"] : []),
		"chmod -R a+rX repo",
		setupNotes ? 'chmod 755 "$private"' : 'chmod 711 "$private"',
	].join("\n");
	const result = await run(sandbox, script, {
		gitUser: true,
		stdin: [token, ...inputs.map(n => Buffer.from(n.text).toString("base64"))].join("\n") + "\n",
		secrets: [token],
		timeoutMs: CLONE_TIMEOUT_MS,
		signal,
	});
	if (!result.ok)
		throw new GithubProblem("github_gone", "Could not open the requested pull request at its pinned commit.");
	return setupNotes ? transportDirectory(id) : transportDirectory(id) + "/repo";
}

export async function checkoutReview(
	sandbox: SandboxHandle,
	url: string,
	token: string,
	directory: string,
	pr: number,
	head: string,
	signal?: AbortSignal,
) {
	if (!Number.isSafeInteger(pr) || pr < 1) throw new Error("Invalid pull request number.");
	const fetch = await fetchRefs(
		sandbox,
		token,
		url,
		directory,
		[{ source: `refs/pull/${pr}/head`, destination: "refs/wlp/review" }],
		signal,
	);
	if (!fetch.ok) {
		if (fetch.marks.has("unsafe"))
			throw new GithubProblem("github_denied", unsafeWorkspace(fetch.marks.get("unsafe")!));
		if (
			fetch.failure === "denied" ||
			fetch.failure === "gone" ||
			(fetch.failure === "other" && /couldn't find remote ref/i.test(fetch.said))
		) {
			throw new GithubProblem(
				fetch.failure === "denied" ? "github_denied" : "github_gone",
				"the pull request head is unavailable",
			);
		}
		throw new Error("the pull request head could not be fetched");
	}
	const checkout = await run(sandbox, reviewCheckoutScript(directory, head), {
		stdin: "",
		timeoutMs: COMMIT_TIMEOUT_MS,
		signal,
	});
	if (
		checkout.marks.has("missing") &&
		!checkout.ok &&
		checkout.failure !== "aborted" &&
		checkout.failure !== "timeout"
	) {
		throw new GithubProblem("github_gone", "the pull ref does not identify the expected commit");
	}
	if (!checkout.ok || checkout.marks.get("review") !== head) throw new Error("the checkout of the pull request failed");
}

export async function changedReviewPaths(
	sandbox: SandboxHandle,
	directory: string,
	base: string,
	head: string,
	readOnly = false,
): Promise<string[]> {
	if (![base, head].every(sha => /^[0-9a-f]{40}$/.test(sha))) throw new Error("Invalid review SHA.");
	const script = [
		`cd ${shellQuote(directory)} || exit 1`,
		// The requested checkout and its Git configuration belong to the transport user.
		...(readOnly
			? [PLAIN_GIT, 'git() { plain_git -c safe.directory="$PWD" "$@"; }']
			: [privateStart(), VERIFY_OBJECTS]),
		`git diff --no-ext-diff --no-renames --name-only -z ${base}...${head} --`,
	].join("\n");
	const result = await sandbox.run(script, { timeoutMs: COMMIT_TIMEOUT_MS });
	if (result.exitCode !== 0 || result.timedOut || result.aborted || (result.stdout && !result.stdout.endsWith("\0")))
		throw new Error("could not read the changed paths");
	return result.stdout.split("\0").filter(Boolean);
}

/** Fetches the base branch with `token`, which is given to the command on its standard input and to nothing else. */
export function fetchWithToken(
	sandbox: SandboxHandle,
	token: string,
	input: { url: string; base: string; work?: string | null; username?: GitUsername },
): Promise<GitOutcome> {
	const ref = (name: string, optional = false) => ({
		source: "refs/heads/" + name,
		destination: "refs/remotes/origin/" + name,
		optional,
	});
	return fetchRefs(
		sandbox,
		token,
		input.url,
		".",
		[ref(input.base), ...(input.work ? [ref(input.work, true)] : [])],
		undefined,
		input.username,
	);
}

/** Workspace-side staging and the exchange pack, separate from the protected scan. */
function handoverDirectory(attempt: string): string {
	return `/tmp/wlp-git-attempt-${attempt.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function commitId(sha: string): string {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid GitHub commit SHA.");
	return sha;
}

/**
 * Whether the workspace has anything GitHub does not: `wlp:nothing` when its HEAD is the commit last
 * pushed, or, before the first push, a commit the base branch already had when it was cloned.
 */
function nothingNew(baseSha: string | null, pushed: string | null): string[] {
	const said = 'nothing=1; echo "wlp:nothing"';
	const lines = ["nothing=0"];
	if (pushed) lines.push(`if [ "$head" = ${commitId(pushed)} ]; then ${said}; fi`);
	else if (baseSha) lines.push(`if git merge-base --is-ancestor "$head" ${commitId(baseSha)}; then ${said}; fi`);
	return lines;
}

/** Require a confirmed lower bound. A previous push can also exclude history if present. */
function outgoingBoundaries(baseSha: string | null, pushed: string | null, head: string): string[] {
	const missing = 'echo "Call fetch_base to refresh the missing publishing base." >&2; exit 9';
	const lines = ["set --"];
	if (baseSha) {
		lines.push(`git cat-file -e '${commitId(baseSha)}^{commit}' 2>/dev/null || { ${missing}; }`, `set -- ${baseSha}`);
	}
	if (pushed)
		lines.push(`if git cat-file -e '${commitId(pushed)}^{commit}' 2>/dev/null; then set -- "$@" ${pushed}; fi`);
	lines.push(
		`[ "$#" -gt 0 ] || { ${missing}; }`,
		`git merge-base ${head} "$@" >/dev/null || { echo "Call fetch_base and reconcile the workspace with its publishing base." >&2; exit 9; }`,
	);
	return lines;
}

export interface CommitInput {
	sessionId: string;
	/** The branch the work goes on. */
	branch: string;
	/** The base commit the platform observed at GitHub. */
	baseSha: string | null;
	/** The commit the platform last pushed, if it pushed before. */
	pushed: string | null;
	author: { name: string; email: string };
}

/** Stage a stable copy of the files against the agent's history; retain the private repo for this push. */
export function commitScript(input: CommitInput, attempt = input.sessionId): string {
	const destination = shellQuote(handoverDirectory(attempt));
	return [
		"set -eu",
		privateStart({ refs: [`refs/heads/${input.branch}`], missing: "norepo" }),
		'cat > "$private/message"',
		"exec </dev/null",
		capture(COMMIT_PATHS),
		// Changing the branch here only changes private refs. Checking out could rewrite the files.
		`if git rev-parse --verify HEAD >/dev/null 2>&1; then git update-ref --no-deref ${shellQuote(`refs/heads/${input.branch}`)} "$(git rev-parse HEAD)"; fi`,
		`git symbolic-ref HEAD ${shellQuote(`refs/heads/${input.branch}`)}`,
		// Keep staged paths (including force-added ignored files), discard workspace stat cache
		// and assume-unchanged/skip-worktree bits. Only captured bytes may supply new blobs.
		'git ls-files --stage -z > "$private/staged"',
		'rm -f "$private/repo/index"',
		`${GIT_ENV} git ${SAFE_FLAGS} --git-dir="$private/repo" --work-tree="$tree" update-index -z --index-info < "$private/staged"`,
		`git add -A -- ${COMMIT_PATHS}`,
		"git rm -r -q -f --cached --ignore-unmatch -- .wlp-shots",
		'if git diff --cached --quiet && [ ! -f "$private/repo/MERGE_HEAD" ]; then',
		"	committed=0",
		"else",
		`	git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgSign=false -c user.name=${shellQuote(input.author.name)} -c user.email=${shellQuote(input.author.email)} commit --quiet --no-verify -F "$private/message"`,
		"	committed=$(git diff-tree --root --no-commit-id --diff-merges=first-parent --name-only -r HEAD | grep -c . || true)",
		"fi",
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}'); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:committed $committed"`,
		`echo "wlp:head $head"`,
		VERIFY_OBJECTS,
		...nothingNew(input.baseSha, input.pushed),
		'[ "$nothing" = 0 ] || exit 0',
		...outgoingBoundaries(input.baseSha, input.pushed, '"$head"'),
		// An earlier agent commit could contain a screenshot already removed from HEAD.
		// Look up the root entry of each outgoing tree, including either side of a merge.
		"set -o pipefail",
		`git rev-list --no-commit-header --format='%T:.wlp-shots' "$head" --not "$@" | ${GIT_ENV} git ${SAFE_FLAGS} --git-dir="$private/repo" cat-file --batch-check > "$private/shots"`,
		'if grep -qv " missing$" "$private/shots"; then echo "An outgoing commit contains .wlp-shots. Remove it from the commits to push." >&2; exit 1; fi',
		// The transport user accepts only a pack. Metadata, paths, refs and config stay here.
		`printf '%s\\n' "$head" "$@" | ${GIT_ENV} git ${SAFE_FLAGS} --git-dir="$private/repo" pack-objects --stdout --revs > "$private/transfer.pack"`,
		'chmod 444 "$private/transfer.pack"; chmod 711 "$private"',
		`rm -rf "$private/tree" "$private/message"; mv -T "$private" ${destination}`,
	].join("\n");
}

/** Reads the workspace's HEAD and whether GitHub lacks anything, without changing it. No token. */
export function probeScript(baseSha: string | null, pushed: string | null): string {
	return [
		"set -eu",
		privateStart({ missing: "nothing" }),
		capture(),
		`if ! head=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null); then echo "wlp:nothing"; exit 0; fi`,
		`echo "wlp:head $head"`,
		'git status --porcelain=v1 --untracked-files=normal --ignore-submodules=all > "$private/status"',
		'if [ -s "$private/status" ]; then echo "wlp:dirty"; fi',
		VERIFY_OBJECTS,
		...nothingNew(baseSha, pushed),
	].join("\n");
}

interface PushAttempt {
	id: string;
	head: string;
	baseSha: string | null;
	pushed: string | null;
	objects?: string;
}

const rangeDigest = 'git rev-list --objects --no-object-names "$sha" --not "$@" -- | sha256sum';

/**
 * Push exactly the commit and object database that the platform staged and scanned. After the
 * transport reports its result, install the branch and index if the workspace still matches.
 *
 * With `lease`, the commit the platform itself last pushed to the branch: a push that is refused as no
 * fast-forward is tried once more with `--force-with-lease` on it, so that it may replace that commit and
 * nothing else. A branch the agent rebased goes (`wlp:forced`); a commit anyone else pushed to the branch
 * since makes GitHub refuse it (`wlp:stale`). The plain push comes first, so that a fast-forward over
 * someone else's commit (one the agent merged) is never taken for a rebase.
 */
function pushScript(
	range: PushAttempt,
	url: string,
	branch: string,
	lease: string | null,
	username?: GitUsername,
): string {
	if (!range.objects || !/^[0-9a-f]{64}$/.test(range.objects)) throw new Error("Invalid scanned object digest.");
	if (lease !== null) commitId(lease);
	const target = shellQuote(`refs/heads/${branch}`);
	return [
		"set -eu -o pipefail",
		READ_TOKEN,
		tokenGit(hostOf(url), username),
		PLAIN_GIT,
		`private=${shellQuote(transportDirectory(range.id))}`,
		'cd -- "$private" || { echo wlp:nohandover; exit 4; }',
		'git() { plain_git --git-dir="$private/repo" "$@"; }',
		`sha=${commitId(range.head)}`,
		"verify_range() {",
		...outgoingBoundaries(range.baseSha, range.pushed, '"$sha"'),
		`actual=$(${rangeDigest}); [ "\${actual%% *}" = ${range.objects} ] || { echo wlp:changedrange; exit 4; }`,
		"}",
		"verify_range",
		`send() { wlp_git --git-dir="$private/repo" push --porcelain "$@"; }`,
		// One refspec means exactly one porcelain status. "=" is also possible when the lease retry races another push.
		"pushed() {",
		`	status=$(printf '%s\\n' "$said" | awk -F '\\t' 'NF >= 3 {print $1}')`,
		`	case "$status" in`,
		`		'=') echo "wlp:uptodate $sha" ;;`,
		`		'+') echo "wlp:forced"; echo "wlp:pushed $sha" ;;`,
		`		' '|'*') echo "wlp:pushed $sha" ;;`,
		`		*) exit 1 ;;`,
		"	esac",
		"}",
		// A plain push first: a fast-forward goes, whoever else pushed to the branch before.
		`if said=$(send -- ${shellQuote(url)} "$sha:"${target} 2>&1); then pushed; exit 0; fi`,
		...(lease === null
			? []
			: [
					// Refused as no fast-forward (a branch the agent rebased): once more, now replacing the platform's own last push and nothing else.
					`if printf '%s\\n' "$said" | grep -qE 'non-fast-forward|fetch first|\\[rejected\\]'; then`,
					"	verify_range",
					`	if said=$(send ${shellQuote(`--force-with-lease=refs/heads/${branch}:${lease}`)} -- ${shellQuote(url)} "$sha:"${target} 2>&1); then pushed; exit 0; fi`,
					// The lease refused it: what is at GitHub is not the platform's last push.
					`	if printf '%s\\n' "$said" | grep -q 'stale info'; then echo "wlp:stale"; fi`,
					"fi",
				]),
		`printf '%s\\n' "$said" >&2`,
		"exit 1",
	].join("\n");
}

/** The `wlp:` lines of a script's output: name -> what follows it. */
export function markers(output: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const line of output.split("\n")) {
		const match = /^wlp:([a-z]+)(?: (.*))?$/.exec(line.trim());
		if (match?.[1]) found.set(match[1], match[2] ?? "");
	}
	return found;
}

/** The end of what git said, with no credential in it. */
function said(result: ExecResult, secrets: string[]): string {
	const lines = `${result.stderr}\n${result.stdout}`
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && !line.startsWith("wlp:"));
	return redact(lines.slice(-4).join(" ").slice(-400), secrets);
}

export type GitFailure =
	/** The bounded reference clone failed before any workspace files were installed. */
	| "mirror"
	/** GitHub did not accept the token, or the app may not do this in the repository. */
	| "denied"
	/** The repository is not there (any more), or the app cannot see it. */
	| "gone"
	/** A rule of the repository's refused the branch. */
	| "protected"
	/** The push changes a workflow file, which the app's permissions do not cover. */
	| "workflow"
	/** GitHub's branch has commits the workspace lacks. */
	| "diverged"
	/** The branch to clone does not exist. */
	| "no_branch"
	| "unreachable"
	| "timeout"
	| "aborted"
	| "other";

export interface GitOutcome {
	ok: boolean;
	failure: GitFailure | null;
	/** What git said, redacted; empty when it succeeded. */
	said: string;
	marks: Map<string, string>;
}

/** What a failed clone or push means, from git's own words and GitHub's `remote:` lines. */
function classify(text: string): GitFailure {
	if (/GH006|GH013|protected branch|rule violations/i.test(text)) return "protected";
	if (/without `?workflows?`? permission/i.test(text)) return "workflow";
	if (/non-fast-forward|fetch first|\[rejected\]/i.test(text)) return "diverged";
	if (/Remote branch .* not found/i.test(text)) return "no_branch";
	if (/Repository not found|returned error: 404|not found\b/i.test(text)) return "gone";
	if (
		/returned error: 40[13]|Permission to .* denied|Authentication failed|Invalid username or (?:token|password)|could not read (?:Username|Password)|Write access to repository not granted/i.test(
			text,
		)
	)
		return "denied";
	if (
		/Could not resolve host|Failed to connect|Connection (?:refused|timed out|reset)|unable to access|network is unreachable|returned error: 5\d\d/i.test(
			text,
		)
	)
		return "unreachable";
	return "other";
}

async function run(
	sandbox: SandboxHandle,
	script: string,
	options: { gitUser?: true; stdin: string; timeoutMs: number; signal?: AbortSignal; secrets?: string[] },
): Promise<GitOutcome> {
	const secrets = options.secrets ?? [];
	let result: ExecResult;
	try {
		result = await sandbox.run(script, {
			...(options.gitUser ? ({ gitUser: true, cwd: "/" } as const) : {}),
			stdin: options.stdin,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	} catch (error) {
		// Whatever the sandbox layer says of a command it could not run, it does not say with the token in it.
		throw new Error(redact(errorText(error), secrets));
	}
	const marks = markers(result.stdout);
	if (result.aborted) return { ok: false, failure: "aborted", said: "", marks };
	if (result.timedOut) return { ok: false, failure: "timeout", said: "", marks };
	if (result.exitCode === 0) return { ok: true, failure: null, said: "", marks };
	const text = said(result, secrets);
	return { ok: false, failure: classify(`${result.stderr}\n${result.stdout}`), said: text, marks };
}

/** The most a planning input may take: each file its fetch and checkout write (the pack included), and its whole tree. */
export const INPUT_LIMITS = { fileMiB: 512, treeMiB: 1024 };

/** The file the platform leaves in its planning inputs' directory: what it removes is only ever its own. */
const INPUTS_MARK = ".windlass-platform-inputs";

const INPUT_REFUSALS: Record<string, (directory: string) => string> = {
	symlink: d => `${d} in the workspace is a symbolic link`,
	tracked: d => `${d} is tracked in the repository`,
	committed: d => `${d} is in the repository's commit`,
	present: d => `${d} is already in the workspace, and the platform did not put it there`,
	exclude: d => `${d} could not be kept out of the repository (.git/info/exclude)`,
};

function inputPaths(directory: string, alias?: string): void {
	if (!/^\.[a-z-]+$/.test(directory) || (alias !== undefined && !/^[a-z][a-z0-9-]{0,15}$/.test(alias)))
		throw new Error("invalid input path");
}

/**
 * Makes the workspace's `directory` the platform's planning inputs' own, or refuses, naming why: never a
 * symbolic link, never a path the repository tracks or commits, never one already there that the platform
 * did not make. Inside the workspace's repository it is listed in `.git/info/exclude`, so nothing the
 * platform commits from the workspace can take it.
 */
function inputsGuard(directory: string): string {
	const d = shellQuote(directory),
		mark = shellQuote(`${directory}/${INPUTS_MARK}`),
		line = shellQuote(`/${directory}/`);
	return [
		"set -eu",
		`export PATH=${SYSTEM_PATH}`,
		PLAIN_GIT,
		`refuse() { echo "wlp:refuse $1"; exit 3; }`,
		`if [ -L ${d} ]; then refuse symlink; fi`,
		"if [ -e .git ]; then",
		`	if [ -n "$(plain_git ls-files -- ${d} | head -1)" ]; then refuse tracked; fi`,
		`	if plain_git rev-parse -q --verify ${shellQuote(`HEAD:${directory}`)} >/dev/null 2>&1; then refuse committed; fi`,
		"	exclude=$(plain_git rev-parse --git-path info/exclude) || refuse exclude",
		'	mkdir -p -- "$(dirname -- "$exclude")" || refuse exclude',
		`	grep -qxF -- ${line} "$exclude" 2>/dev/null || printf '%s\\n' ${line} >> "$exclude" || refuse exclude`,
		"fi",
		`if [ -e ${d} ] && { [ ! -f ${mark} ] || [ -L ${mark} ]; }; then refuse present; fi`,
		`mkdir -p -- ${d}`,
		`[ -f ${mark} ] || : > ${mark}`,
	].join("\n");
}

async function guardInputs(sandbox: SandboxHandle, directory: string, signal?: AbortSignal): Promise<void> {
	const guarded = await sandbox.run(inputsGuard(directory), { timeoutMs: PROBE_TIMEOUT_MS, signal });
	if (guarded.exitCode === 0) return;
	const reason = /wlp:refuse (\w+)/.exec(guarded.stdout)?.[1];
	throw new Error(
		reason && INPUT_REFUSALS[reason] ? INPUT_REFUSALS[reason](directory) : "the workspace has no room for it",
	);
}

/** The transport's fetch of one commit, alone (`--depth 1`), as the transport user, under `INPUT_LIMITS`; its git directory is gone before anything reaches the workspace. */
function inputFetchScript(url: string, sha: string, id: string, limits = INPUT_LIMITS): string {
	if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Invalid input SHA.");
	return [
		startTransport(id),
		READ_TOKEN,
		tokenGit(hostOf(url)),
		// bash counts the limit in KiB, a POSIX shell in 512-byte blocks.
		`blocks=${limits.fileMiB * 1024}; [ -n "\${BASH_VERSION:-}" ] || blocks=$((blocks * 2)); ulimit -f "$blocks"`,
		"wlp_git init --quiet --template= repo",
		`if ! wlp_git -C repo fetch --quiet --depth=1 --no-tags -- ${shellQuote(url)} ${sha} 2>"$private/fetch.err"; then`,
		'	cat -- "$private/fetch.err" >&2',
		`	if [ "$(du -sk repo | cut -f1)" -ge ${limits.fileMiB * 1024} ] || grep -qi "file size limit" -- "$private/fetch.err"; then echo "wlp:toolarge"; fi`,
		"	exit 1",
		"fi",
		"WLP_T=",
		PLAIN_GIT,
		`plain_git -C repo checkout -q --detach FETCH_HEAD || { echo "wlp:toolarge"; exit 1; }`,
		`[ "$(plain_git -C repo rev-parse HEAD)" = ${sha} ] || { echo "wlp:wrongbase"; exit 1; }`,
		"rm -rf -- repo/.git",
		`[ "$(du -sk repo | cut -f1)" -le ${limits.treeMiB * 1024} ] || { echo "wlp:toolarge"; exit 1; }`,
	].join("\n");
}

/**
 * A cross-repo feature's planning input: `url`'s tree at `sha`, alone (a fetch of that one commit, `--depth 1`,
 * under `INPUT_LIMITS`), in `directory/alias` of the workspace, its files read-only, with no git directory: no
 * remote, no credential, nothing to push with. The token reaches only the fetch's standard input. The directory
 * is the platform's own (`inputsGuard`). Throws, naming why, when the tree cannot be had.
 */
export async function materializeInput(
	sandbox: SandboxHandle,
	token: string,
	input: {
		url: string;
		branch: string;
		sha: string;
		directory: string;
		alias: string;
		signal?: AbortSignal;
		limits?: typeof INPUT_LIMITS;
	},
): Promise<void> {
	if (!/^[0-9a-f]{40}$/.test(input.sha)) throw new Error("the planning base is not a recorded commit");
	inputPaths(input.directory, input.alias);
	await guardInputs(sandbox, input.directory, input.signal);
	const target = shellQuote(`${input.directory}/${input.alias}`);
	const clear = await sandbox.run(
		`set -eu\nif [ -L ${target} ]; then exit 3; fi\nif [ -e ${target} ]; then chmod -R u+w -- ${target}; rm -rf -- ${target}; fi\n[ ! -e ${target} ]`,
		{ timeoutMs: COMMIT_TIMEOUT_MS, signal: input.signal },
	);
	if (clear.exitCode !== 0)
		throw new Error(`the earlier copy at ${input.directory}/${input.alias} could not be removed`);
	const stage = randomBytes(16).toString("hex");
	try {
		const fetched = await run(sandbox, inputFetchScript(input.url, input.sha, stage, input.limits), {
			gitUser: true,
			stdin: token + "\n",
			timeoutMs: CLONE_TIMEOUT_MS,
			signal: input.signal,
			secrets: [token],
		});
		if (!fetched.ok) {
			const limits = input.limits ?? INPUT_LIMITS;
			if (fetched.marks.has("toolarge"))
				throw new Error(
					`it is larger than a planning input may be (${limits.fileMiB} MiB a file, ${limits.treeMiB} MiB in all)`,
				);
			if (fetched.marks.has("wrongbase")) throw new Error(`it is not at ${input.sha.slice(0, 7)}`);
			throw new Error(
				fetched.failure === "denied"
					? "GitHub refused to let the platform read it"
					: fetched.failure === "gone"
						? "GitHub no longer has it"
						: `the fetch failed${fetched.said ? ": " + fetched.said : ""}`,
			);
		}
		const copy = await sandbox.run(
			`set -eu\nexport PATH=${SYSTEM_PATH}\nmkdir -- ${target}\ncp -R -- ${shellQuote(transportDirectory(stage))}/repo/. ${target}/\nfind ${target} -type f -exec chmod a-w -- {} +`,
			{ timeoutMs: CLONE_TIMEOUT_MS, signal: input.signal },
		);
		if (copy.exitCode !== 0) throw new Error("it could not be copied into the workspace read-only");
	} finally {
		await removeTransport(sandbox, stage);
	}
}

/**
 * Takes every planning input out of the workspace: a builder's turn never sees another repository's tree.
 * Only the platform's own directory goes (`inputsGuard`'s mark), never through a symbolic link. Throws
 * when it is still there.
 */
export async function removeInputs(sandbox: SandboxHandle, directory: string): Promise<void> {
	inputPaths(directory);
	const d = shellQuote(directory),
		mark = shellQuote(`${directory}/${INPUTS_MARK}`);
	const removed = await sandbox.run(
		[
			"set -eu",
			`export PATH=${SYSTEM_PATH}`,
			`if [ -L ${d} ]; then echo "wlp:refuse symlink"; exit 3; fi`,
			`[ -e ${d} ] || exit 0`,
			`if [ ! -f ${mark} ] || [ -L ${mark} ]; then echo "wlp:refuse present"; exit 3; fi`,
			`chmod -R u+w -- ${d}`,
			`rm -rf -- ${d}`,
			`[ ! -e ${d} ]`,
		].join("\n"),
		{ timeoutMs: COMMIT_TIMEOUT_MS },
	);
	if (removed.exitCode === 0) return;
	const reason = /wlp:refuse (\w+)/.exec(removed.stdout)?.[1];
	throw new Error(
		`the planner's copy of the other repositories at ${directory} could not be removed${reason && INPUT_REFUSALS[reason] ? `: ${INPUT_REFUSALS[reason](directory)}` : removed.stderr.trim() ? `: ${removed.stderr.trim().slice(0, 200)}` : ""}`,
	);
}

async function installClone(sandbox: SandboxHandle, stage: string, directory: string, signal?: AbortSignal) {
	return run(
		sandbox,
		[
			"set -eu",
			`export PATH=${SYSTEM_PATH}`,
			'if [ -z "$(ls -A | grep -vxF .git || true)" ]; then rm -rf -- .git; target=.; else',
			`target=${shellQuote(directory)}; if [ -d "$target" ] && [ ! -L "$target" ]; then [ -z "$(ls -A -- "$target")" ]; else mkdir -- "$target"; fi; fi`,
			`cp -R -- ${shellQuote(transportDirectory(stage))}/repo/. "$target/"`,
			'echo "wlp:dir $target"',
		].join("\n"),
		{ stdin: "", timeoutMs: CLONE_TIMEOUT_MS, signal },
	);
}

/** Seed a fresh workspace without ever handing the spare a GitHub credential. Only a
 * full, fsck-checked mirror of this pairing and repository may be used as a remote. */
export async function cloneReadyBase(
	sandbox: SandboxHandle,
	url: string,
	branch: string,
	commit: string,
	owner: string,
	signal: AbortSignal,
) {
	if (!isBranchName(branch) || !/^[a-f0-9]{40}$/.test(commit)) return false;
	const stage = randomBytes(16).toString("hex");
	try {
		const script = [
			startTransport(stage),
			GIT_PROXY,
			PLAIN_GIT,
			`mirror=${mirrorPath(owner)}`,
			'if mountpoint -q -- "$mirror" && exec 9<"$mirror" && flock -s -w 3 9 && [ -d "$mirror/repo.git/objects" ]; then',
			`  printf '%s\\n' ${shellQuote(MIRROR_CONFIG)} | cmp -s - "$mirror/repo.git/config"`,
			`  plain_git -c protocol.file.allow=always clone --quiet --no-local --branch ${shellQuote(branch)} -- "$mirror/repo.git" repo`,
			`  plain_git -C repo remote set-url origin ${shellQuote(url)}`,
			"else",
			`  ${GIT_ENV} ${PROXY_ENV} git ${SAFE_FLAGS} clone --quiet --branch ${shellQuote(branch)} -- ${shellQuote(url)} repo`,
			"fi",
			`test "$(plain_git -C repo rev-parse HEAD)" = ${commit}`,
			"chmod -R a+rX repo",
			'chmod 711 "$private"',
		].join("\n");
		const cloned = await run(sandbox, script, { gitUser: true, stdin: "", timeoutMs: CLONE_TIMEOUT_MS, signal });
		return cloned.ok && (await installClone(sandbox, stage, "repo", signal)).marks.get("dir") === ".";
	} finally {
		await removeTransport(sandbox, stage);
	}
}

/** Only for a freshly cloned workspace which has never run setup. A changed default
 * branch, force push, dirty checkout or unavailable remote is a cold miss. */
export function refreshReadyClone(url: string, branch?: string, commit?: string) {
	return [
		"set -eu",
		CLONE_GIT_START,
		"tree=$(pwd -P)",
		'branch=$(git -C "$tree" symbolic-ref --short HEAD)',
		branch
			? `test "$branch" = ${shellQuote(branch)}`
			: `test "$(git ls-remote --symref -- ${shellQuote(url)} HEAD | head -1 | cut -f1)" = "ref: refs/heads/$branch"`,
		'status=$(git -C "$tree" status --porcelain)',
		'test -z "$status"',
		`git -C "$tree" fetch --quiet -- ${shellQuote(url)} "+refs/heads/$branch:refs/remotes/origin/$branch"`,
		'git -C "$tree" merge --quiet --ff-only "refs/remotes/origin/$branch"',
		`test "$(git -C "$tree" rev-parse HEAD)" = "${commit || '$(git -C "$tree" rev-parse "refs/remotes/origin/$branch")'}"`,
	].join("\n");
}

/** Clones with `token`, which is given to the command on its standard input and to nothing else. */
export async function cloneWithToken(
	sandbox: SandboxHandle,
	token: string,
	input: {
		url: string;
		branch: string;
		directory: string;
		work?: string;
		pinnedBase?: string;
		signal?: AbortSignal;
		mirror?: MirrorAttempt;
		username?: GitUsername;
	},
): Promise<GitOutcome> {
	const stage = randomBytes(16).toString("hex");
	let saved = false;
	try {
		const cloned = await run(
			sandbox,
			cloneScript(input.url, input.branch, stage, input.work, input.pinnedBase, input.mirror, input.username),
			{ gitUser: true, stdin: token + "\n", timeoutMs: CLONE_TIMEOUT_MS, signal: input.signal, secrets: [token] },
		);
		if (!cloned.ok) {
			if (input.mirror?.reference && cloned.failure !== "aborted" && cloned.marks.has("mirrorfail"))
				return { ...cloned, failure: "mirror" };
			return cloned;
		}
		const copy = await installClone(sandbox, stage, input.directory, input.signal);
		if (copy.ok) for (const [key, value] of cloned.marks) copy.marks.set(key, value);
		// The stage is named by this call, never by what the script printed.
		if (copy.ok && copy.marks.has("mirrorsave")) {
			copy.marks.set("mirrorsave", stage);
			if (input.pinnedBase && !input.work) copy.marks.set("mirrorpartial", "");
		} else copy.marks.delete("mirrorsave");
		saved = copy.marks.has("mirrorsave");
		return copy;
	} finally {
		await removeTransport(sandbox, stage, saved);
	}
}

/**
 * After a clone GitHub confirmed: have the sandbox layer install the clone's staged objects in the
 * slot, off the clone's path (the promise is not awaited). A clone that is not kept loses its stage.
 */
export function saveMirrorAfterClone(sandbox: SandboxHandle, outcome: GitOutcome): void {
	const stage = outcome.marks.get("mirrorsave");
	if (!stage) return;
	if (outcome.ok && sandbox.saveMirror)
		void sandbox.saveMirror(stage, outcome.marks.has("mirrorpartial")).catch(() => false);
	else
		void sandbox
			.run(`/bin/rm -rf -- ${shellQuote(mirrorStage(stage))}`, { gitUser: true, cwd: "/", timeoutMs: PROBE_TIMEOUT_MS })
			.catch(() => undefined);
}

// Only the remote receipt is shared. Each publisher carries its own attempt through all three steps.
const receipts = new WeakMap<SandboxHandle, string>();

/** Commits the workspace's changes on the session's branch. `message` is the commit's whole message. */
export async function commitWork(
	sandbox: SandboxHandle,
	input: CommitInput,
	message: string,
): Promise<GitOutcome & { attempt?: PushAttempt }> {
	receipts.delete(sandbox);
	const id = randomBytes(16).toString("hex");
	const result = await run(sandbox, commitScript(input, id), {
		stdin: message.endsWith("\n") ? message : `${message}\n`,
		timeoutMs: COMMIT_TIMEOUT_MS,
	});
	const head = result.marks.get("head");
	if (result.ok && head && !result.marks.has("nothing")) {
		return { ...result, attempt: { head: commitId(head), baseSha: input.baseSha, pushed: input.pushed, id } };
	}
	return result;
}

/** Read the commit handed to the push, excluding only commits the platform observed at GitHub. */
export async function outgoingPatch(sandbox: SandboxHandle, pending?: PushAttempt): Promise<string | null> {
	const limit = 8_000_000;
	const script = [
		"set -eu",
		...(pending ? [] : ["exit 1"]), // A real scan requires the commit step's pinned head.
		startTransport(pending?.id ?? "missing"),
		PLAIN_GIT,
		"plain_git init --bare --quiet --template= repo",
		'git() { plain_git --git-dir="$private/repo" "$@"; }',
		"set -o pipefail",
		// Open the exchange file without following agent-owned symlinks. index-pack verifies
		// object IDs and rebuilds the index inside a directory only the transport uid can write.
		BRIDGE,
		`(private=${shellQuote(handoverDirectory(pending?.id ?? "missing"))}; bridge pack) | ${GIT_ENV} git ${SAFE_FLAGS} --git-dir=repo index-pack --stdin --strict >/dev/null`,
		`sha=${pending ? commitId(pending.head) : "missing"}`,
		...outgoingBoundaries(pending?.baseSha ?? null, pending?.pushed ?? null, '"$sha"'),
		'git fsck --full --no-reflogs --no-dangling --no-progress "$sha" "$@" >/dev/null',
		`git rev-list --no-commit-header --format='%T:.wlp-shots' "$sha" --not "$@" | ${GIT_ENV} git ${SAFE_FLAGS} --git-dir=repo cat-file --batch-check > shots`,
		'if grep -qv " missing$" shots; then exit 1; fi',
		`objects=$(${rangeDigest})`,
		'patch="$private/patch"',
		"status=0",
		`GIT_NO_REPLACE_OBJECTS=1 git -c core.quotePath=false log -p -m --text --no-color --no-ext-diff --no-textconv --format='%H%n%B%x00' ${shellQuote(pending?.head ?? "")} --not "$@" -- 2>/dev/null | head -c ${limit} > "$patch" || status=$?`,
		'bytes=$(wc -c < "$patch")',
		`[ "$bytes" -lt ${limit} ] || exit 8`,
		'[ "$status" = 0 ] || exit 1',
		'echo "$bytes ${objects%% *}"',
		// Preserve arbitrary bytes across UTF-8 chunks. The runner caps buffered stdout but streams it all.
		'base64 -w0 "$patch"',
	].join("\n");
	const chunks: string[] = [];
	const result = await sandbox
		.run(script, { gitUser: true, cwd: "/", timeoutMs: PUSH_TIMEOUT_MS, onStdout: chunk => chunks.push(chunk) })
		.catch(() => null);
	const output = chunks.length ? chunks.join("") : (result?.stdout ?? "");
	if (result?.exitCode === 9) {
		await discardHandover(sandbox, pending);
		throw new GithubProblem("github_failed", "Call fetch_base to refresh the missing publishing base before pushing.");
	}
	if (result?.exitCode === 8 || (!pending && Buffer.byteLength(output) >= limit)) {
		await discardHandover(sandbox, pending);
		throw new GithubProblem(
			"github_failed",
			"Nothing was pushed. The change is too large to check for saved secrets (8 MB limit).",
		);
	}
	if (!result || result.exitCode !== 0 || result.timedOut || result.aborted) return null;
	// The fake interpreter executes no shell or Git and gives redaction its synthetic diff directly.
	if (!pending) return output;
	const newline = output.indexOf("\n");
	const [length, objects] = output.slice(0, newline).split(" ");
	const encoded = output.slice(newline + 1);
	if (
		newline < 1 ||
		!length ||
		!/^\d+$/.test(length) ||
		!objects ||
		!/^[0-9a-f]{64}$/.test(objects) ||
		encoded.length !== 4 * Math.ceil(Number(length) / 3)
	)
		return null;
	pending.objects = objects;
	return Buffer.from(encoded, "base64").toString("utf8");
}

export function probeWork(sandbox: SandboxHandle, baseSha: string | null, pushed: string | null): Promise<GitOutcome> {
	return run(sandbox, probeScript(baseSha, pushed), { stdin: "", timeoutMs: PROBE_TIMEOUT_MS });
}

/**
 * Reads the workspace's commit against the branch it started from, without changing anything, for
 * what a pull request says of its changes (verified.ts, `workFlags`): which files changed and how,
 * the changed lines, and the repository's `.windlass/config.json` and `package.json` as they were
 * and as they are. Each part ends with a line only this call knows. No token, and no program of the
 * repository's choosing is run for it: no external diff, no text conversion.
 */
export function workScript(baseSha: string, mark: string): string {
	const diff = "git -c core.quotePath=false -c core.fsmonitor=false diff --no-ext-diff --no-textconv --no-color -M";
	return [
		"set -eu",
		privateStart(),
		"if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then exit 0; fi",
		VERIFY_OBJECTS,
		`base=$(git merge-base HEAD ${commitId(baseSha)} 2>/dev/null) || exit 0`,
		`end() { printf '\\n%s\\n' ${shellQuote(mark)}; }`,
		`${diff} --name-status -z "$base" HEAD | head -c 400000; end`,
		`${diff} -U0 "$base" HEAD | head -c 2000000; end`,
		`for at in "$base" HEAD; do for file in .windlass/config.json package.json; do if git cat-file -e "$at:$file" 2>/dev/null; then echo file; git cat-file blob "$at:$file" | head -c 200000; else echo absent; fi; end; done; done`,
	].join("\n");
}

/** `workScript`'s answer, or null when git did not give one (no repository, no such base, a sandbox that is not running). Never throws. */
export async function readWork(sandbox: SandboxHandle, baseSha: string | null): Promise<WorkDiff | null> {
	if (!baseSha) return null;
	const mark = `wlp-${randomBytes(9).toString("hex")}`;
	const result = await sandbox.run(workScript(baseSha, mark), { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
	if (result === null || result.exitCode !== 0) return null;
	const parts = result.stdout.split(`\n${mark}\n`);
	if (parts.length < 7) return null;
	const names = (parts[0] as string).split("\0");
	const files: WorkDiff["files"] = [];
	for (let index = 0; index + 1 < names.length; index += 2) {
		const status = names[index] as string;
		const path = names[index + 1] as string;
		// A rename or a copy names two paths: where it was, and where it is.
		if (/^[RC]/.test(status)) files.push({ status, path, to: names[(index += 1) + 1] });
		else files.push({ status, path });
	}
	const file = (part: string): string | null => (part.startsWith("file\n") ? part.slice(5) : null);
	return {
		files,
		patch: parts[1] as string,
		config: { before: file(parts[2] as string), after: file(parts[4] as string) },
		packageJson: { before: file(parts[3] as string), after: file(parts[5] as string) },
	};
}

/** Removes what `commitWork` left for a push that is not going to run. Never throws. */
export async function discardHandover(sandbox: SandboxHandle, attempt?: PushAttempt): Promise<void> {
	if (!attempt) return;
	delete attempt.objects;
	await removeTransport(sandbox, attempt.id);
	await sandbox
		.run(`/bin/rm -rf -- ${shellQuote(handoverDirectory(attempt.id))}`, { timeoutMs: PROBE_TIMEOUT_MS })
		.catch(() => undefined);
}

/** The receipt for the current serialized publish, including when a later PR operation failed. */
export function actuallyPushed(sandbox: SandboxHandle, head: string): boolean {
	return receipts.get(sandbox) === head;
}

/** Pushes what `commitWork` left, with `token` on the command's standard input; `lease` as `pushScript` takes it. */
export async function pushWithToken(
	sandbox: SandboxHandle,
	token: string,
	input: { attempt?: PushAttempt; url: string; branch: string; lease?: string | null; username?: GitUsername },
): Promise<GitOutcome> {
	const { attempt } = input;
	// The in-memory sandbox interpreter has no shell or Git and simulates a push with empty output.
	// A real shell with no scanned range exits before it receives a credential.
	if (!attempt?.objects) return run(sandbox, "echo wlp:nohandover; exit 4", { stdin: "", timeoutMs: PROBE_TIMEOUT_MS });
	let result: GitOutcome;
	try {
		result = await run(sandbox, pushScript(attempt, input.url, input.branch, input.lease ?? null, input.username), {
			gitUser: true,
			stdin: token + "\n",
			timeoutMs: PUSH_TIMEOUT_MS,
			secrets: [token],
		});
	} finally {
		await removeTransport(sandbox, attempt.id);
	}
	if (result.ok && result.marks.get("pushed") === attempt.head) receipts.set(sandbox, attempt.head);
	if (result.ok) {
		// Keep the remote receipt even when a competing command moved the workspace refs.
		// The token process has exited. This step has its own timeout and invokes no Git.
		const sync = [
			"set -eu",
			`export PATH=${SYSTEM_PATH}`,
			`private=${shellQuote(handoverDirectory(attempt.id))}`,
			`trap 'rm -rf -- "$private"' EXIT`,
			BRIDGE,
			`bridge export HEAD index MERGE_HEAD ${shellQuote(`refs/heads/${input.branch}`)}`,
		].join("\n");
		const local = await run(sandbox, sync, { stdin: "", timeoutMs: PROBE_TIMEOUT_MS }).catch(() => null);
		if (!local?.ok) result.marks.set("workspacechanged", "");
	} else {
		await discardHandover(sandbox, attempt);
	}
	return result;
}

export const CLONE_MINUTES = CLONE_TIMEOUT_MS / 60_000;
