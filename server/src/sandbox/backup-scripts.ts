/**
 * What a copy of an agent's session is made and checked with, wherever it is kept: the scripts a
 * sandbox runs to pack and to restore it, the names they are told and the one answer line each
 * prints, and the checks of a copy's name. Used by the bucket's copies (backup.ts, whose header is the
 * spec) and by a machine's (machine-backups.ts, and the runner's side of them in
 * runner/src/session-backups.ts). It imports no server configuration, so the runner can import it.
 */

import type { BackupAgentSession, SandboxHandle } from "./api.js";
import { shellQuote } from "./provider.js";
import { type FileRule, type SessionFiles, sessionFilesOf } from "./session-files.js";
import { errorText } from "../util.js";
import { PACK_PATH, SESSION, validOwner } from "./backup-names.js";

// Kept apart so the runner can use them without the agents' descriptions (session-files.ts) in its bundle.
export { PACK_PATH, SESSION, validOwner };

/** How long packing may take in the sandbox. */
export const PACK_TIMEOUT_MS = 2 * 60 * 1000;

export const SHA256 = /^[0-9a-f]{64}$/;
/** A folder a `FileRule` searches: plain names, none of them `.`, `..` or one that `find` would read as an option. */
const FOLDER = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/**
 * The environment a step is given (never a secret), and what each step answers with. The fake sandbox
 * layer has no shell: it reads `WLP_BACKUP_STEP` and plays the step by these same names (sandbox-fake.ts).
 */
export const BACKUP_ENV = {
	step: "WLP_BACKUP_STEP",
	data: "WLP_BACKUP_DATA",
	pack: "WLP_BACKUP_PACK",
	max: "WLP_BACKUP_MAX",
	size: "WLP_BACKUP_SIZE",
	sha256: "WLP_BACKUP_SHA256",
	session: "WLP_BACKUP_SESSION",
	seconds: "WLP_BACKUP_SECONDS",
	/** `SessionFiles.id`: the script checks the session's id against it before using it. */
	id: "WLP_BACKUP_ID",
	/** `SessionFiles.present`, with the id put in. */
	present: "WLP_BACKUP_PRESENT",
	/** `SessionFiles.held`, with the id put in. */
	held: "WLP_BACKUP_HELD",
	/** `SessionFiles.proof`, with the id put in. */
	proof: "WLP_BACKUP_PROOF",
} as const;

/** A pattern of a `FileRule` as one shell word: quoted, with each `<id>` the checked session id from the environment. */
function patternWord(pattern: string): string {
	return pattern
		.split("<id>")
		.map(part => (part === "" ? "" : shellQuote(part)))
		.join(`"$${BACKUP_ENV.session}"`);
}

/** One `find` of a copy's files, printing their paths from the data directory, each ended by a NUL. */
export function findCommand(rule: FileRule): string {
	if (!FOLDER.test(rule.under) || rule.under.split("/").includes(".."))
		throw new Error("a rule of an agent's session files searches a folder that is not a plain name");
	const words = ["find", rule.under];
	if (rule.minDepth !== undefined) words.push("-mindepth", String(Math.trunc(rule.minDepth)));
	if (rule.maxDepth !== undefined) words.push("-maxdepth", String(Math.trunc(rule.maxDepth)));
	words.push("-type", "f");
	if (rule.path !== undefined) words.push("-path", patternWord(rule.path));
	const names = rule.names ?? [];
	const [only] = names;
	if (names.length === 1 && only !== undefined) words.push("-name", patternWord(only));
	if (names.length > 1) words.push("\\(", names.map(name => `-name ${patternWord(name)}`).join(" -o "), "\\)");
	if (rule.noDotNames) words.push("!", "-name", "'.*'");
	words.push("-print0");
	return `if [ -d ${rule.under} ]; then ${words.join(" ")}; fi`;
}

/** The first line of the scripts that use the session's id: none but one of the agent's own goes further. */
const CHECK_SESSION = `[[ "$${BACKUP_ENV.session}" =~ $${BACKUP_ENV.id} ]] || exit 2`;

/**
 * Packs what a copy holds into `$WLP_BACKUP_PACK`. Prints `packed <bytes> <sha256>`, `empty` when the
 * agent has no session here (`present`, or no data directory where the agent says that means none),
 * `export` when its `beforePack` failed, or `too_large <bytes>`: of the archive, or of the files
 * themselves when they are more than ten times the limit, which no compression makes up for and which
 * is then not even tried. The names are sorted and gzip is told to leave out the time, so the same
 * files give the same archive.
 */
export function packScript(files: SessionFiles): string {
	return [
		"set -euo pipefail",
		"umask 077",
		CHECK_SESSION,
		...(files.missingRootIsEmpty ? ['if [ ! -d "$WLP_BACKUP_DATA" ]; then echo empty; exit 0; fi'] : []),
		'cd "$WLP_BACKUP_DATA"',
		"rm -f /tmp/.wlp-backup-*",
		...(files.beforePack === undefined
			? []
			: [`if ! { ${files.beforePack}; } >/dev/null 2>&1; then echo export; exit 0; fi`]),
		'list="$WLP_BACKUP_PACK.list"',
		"{",
		...files.copied.map(rule => `  ${findCommand(rule)}`),
		'} | LC_ALL=C sort -z > "$list"',
		'if ! grep -qzE "$WLP_BACKUP_PRESENT" "$list"; then rm -f "$list"; echo empty; exit 0; fi',
		'raw=$(xargs -0 -r stat -c %s < "$list" | awk \'{ sum += $1 } END { printf "%.0f", sum }\')',
		'if [ "$raw" -gt $((WLP_BACKUP_MAX * 10)) ]; then rm -f "$list"; echo "too_large $raw"; exit 0; fi',
		'tar --null --no-recursion -T "$list" -cf - | gzip -n > "$WLP_BACKUP_PACK"',
		'rm -f "$list"',
		'size=$(stat -c %s "$WLP_BACKUP_PACK")',
		'if [ "$size" -gt "$WLP_BACKUP_MAX" ]; then rm -f "$WLP_BACKUP_PACK"; echo "too_large $size"; exit 0; fi',
		'echo "packed $size $(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)"',
	].join("\n");
}

/**
 * Sends the archive to the link on standard input and removes it. Prints `http <status>`, `curl <exit
 * code>` when curl could not get an answer (it tries again twice by itself when the failure is one
 * that passes), or `changed` when the archive is not the one that was packed.
 */
export const UPLOAD_SCRIPT = [
	"set -u",
	`trap 'rm -f -- "$WLP_BACKUP_PACK"' EXIT`,
	'if [ ! -f "$WLP_BACKUP_PACK" ] || [ "$(stat -c %s "$WLP_BACKUP_PACK")" != "$WLP_BACKUP_SIZE" ]; then echo changed; exit 0; fi',
	`code=$(curl -q -s -K - -T "$WLP_BACKUP_PACK" -o /dev/null -w '%{http_code}' --connect-timeout 15 --max-time "$WLP_BACKUP_SECONDS" --retry 2 --retry-delay 1 --retry-max-time "$WLP_BACKUP_SECONDS" 2>/dev/null) || { echo "curl $?"; exit 0; }`,
	'echo "http $code"',
].join("\n");

/**
 * Fetches the archive from the link on standard input and unpacks it into the agent's data directory,
 * which in a sandbox that was just made holds no session. Prints `restored`, or why not: `http
 * <status>` (404: there is no copy), `curl <exit code>`, `size <bytes>` or `hash <sha256>` (it is not
 * the archive that was saved), `contents` (it holds a file a copy never holds: `held`), `unpack`, or
 * `no_session` (the session is not in it: `proof`), or `import` (the agent's `afterUnpack` failed).
 * Nothing is unpacked before the checks have passed.
 *
 * `from: "file"` is a machine's (machine-backups.ts): the runner has put the archive at
 * `$WLP_BACKUP_PACK` already, after checking its size and hash itself, and nothing is fetched. A path
 * that is not a plain file there answers `missing`. Every check after that is the same, the size and
 * the hash again among them.
 */
export function restoreScript(files: SessionFiles, from: "link" | "file" = "link"): string {
	return [
		"set -u",
		"umask 077",
		CHECK_SESSION,
		`trap 'rm -f -- "$WLP_BACKUP_PACK"' EXIT`,
		...(from === "link"
			? [
					`code=$(curl -q -s -K - -o "$WLP_BACKUP_PACK" -w '%{http_code}' --connect-timeout 15 --max-time "$WLP_BACKUP_SECONDS" --retry 2 --retry-delay 1 --retry-max-time "$WLP_BACKUP_SECONDS" 2>/dev/null) || { echo "curl $?"; exit 0; }`,
					'if [ "$code" != 200 ]; then echo "http $code"; exit 0; fi',
				]
			: ['if [ -L "$WLP_BACKUP_PACK" ] || [ ! -f "$WLP_BACKUP_PACK" ]; then echo missing; exit 0; fi']),
		'size=$(stat -c %s "$WLP_BACKUP_PACK")',
		'if [ "$size" != "$WLP_BACKUP_SIZE" ]; then echo "size $size"; exit 0; fi',
		'hash=$(sha256sum < "$WLP_BACKUP_PACK" | cut -d" " -f1)',
		'if [ "$hash" != "$WLP_BACKUP_SHA256" ]; then echo "hash $hash"; exit 0; fi',
		`names=$(tar -tzf "$WLP_BACKUP_PACK" 2>/dev/null) || { echo unpack; exit 0; }`,
		`if printf '%s\\n' "$names" | grep -qvE "$WLP_BACKUP_HELD"; then echo contents; exit 0; fi`,
		'mkdir -p "$WLP_BACKUP_DATA" && tar -xzf "$WLP_BACKUP_PACK" -C "$WLP_BACKUP_DATA" --no-same-owner --no-same-permissions 2>/dev/null || { echo unpack; exit 0; }',
		// The proof is a glob of the agent's, without spaces: it is expanded here, and only here.
		"shopt -s nullglob",
		"proof=no",
		`for found in "$WLP_BACKUP_DATA"/$WLP_BACKUP_PROOF; do if [ -f "$found" ]${files.proofNotEmpty ? ' && [ -s "$found" ]' : ""}; then proof=yes; break; fi; done`,
		'if [ "$proof" != yes ]; then echo no_session; exit 0; fi',
		...(files.afterUnpack === undefined
			? []
			: [`(cd "$WLP_BACKUP_DATA" && ${files.afterUnpack}) >/dev/null 2>&1 || { echo import; exit 0; }`]),
		"echo restored",
	].join("\n");
}

/** The last line a step printed, when it is one of the answers the step can give; null for anything else. */
export function answerOf(stdout: string): string | null {
	const line = stdout.trim().split("\n").pop()?.trim() ?? "";
	return /^(packed \d+ [0-9a-f]{64}|empty|export|too_large \d+|changed|http \d{3}|curl \d+|size \d+|hash [0-9a-f]{64}|contents|unpack|no_session|import|restored|missing)$/.test(
		line,
	)
		? line
		: null;
}

export const messageOf = (error: unknown) => errorText(error).replace(/\s+/g, " ").trim().slice(0, 300);

/** The agent's description and what a script is told of it for this session; null when the session is not one to copy. */
export function sessionFilesEnv(
	session: BackupAgentSession,
): { files: SessionFiles; env: Record<string, string> } | null {
	const files = sessionFilesOf(session.harness);
	const id = session.sessionId;
	if (files === null || typeof id !== "string" || !SESSION.test(id) || !new RegExp(files.id).test(id)) return null;
	const withId = (pattern: string) => pattern.replaceAll("<id>", id);
	return {
		files,
		env: {
			[BACKUP_ENV.data]: files.root,
			[BACKUP_ENV.session]: id,
			[BACKUP_ENV.id]: files.id,
			[BACKUP_ENV.present]: withId(files.present),
			[BACKUP_ENV.held]: withId(files.held),
			[BACKUP_ENV.proof]: withId(files.proof),
		},
	};
}

/**
 * Runs one script in the sandbox and returns its answer. Whatever else it printed is dropped here:
 * the standard input may hold a link, and no error of this layer repeats a sandbox's output.
 */
export async function backupStep(
	sandbox: SandboxHandle,
	name: string,
	script: string,
	env: Record<string, string>,
	stdin: string | undefined,
	timeoutMs: number,
): Promise<string> {
	let result: Awaited<ReturnType<SandboxHandle["run"]>>;
	try {
		result = await sandbox.run(script, { env: { ...env, [BACKUP_ENV.step]: name }, stdin, timeoutMs, cwd: "/" });
	} catch {
		// A provider's error may quote the command; the command's input is the link.
		throw new Error(`the ${name} step could not be run in the sandbox`);
	}
	if (result.timedOut)
		throw new Error(`the ${name} step took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`);
	const answer = answerOf(result.stdout);
	if (answer === null) throw new Error(`the ${name} step ended with exit code ${result.exitCode} and no answer`);
	return answer;
}
