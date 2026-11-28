/** TurnSandbox isolates process and credential handling behind provider operations. Stop tagged guest processes before detaching their client. */

import { randomBytes } from "node:crypto";
import { RUNNER_HTTP_PROXY } from "../runner/egress.js";
import type { CredentialRef, HarnessId } from "../contract.js";
import type { KeyWire } from "../../../sandbox/relay/wires.cjs";
import type { ExecResult, SandboxHandle } from "./api.js";
import type { LocalModelRelay, LocalPlanRelayOptions } from "./plan-relay.js";

export const DATA_DIR = "/home/agent/.local/share/windlass";
export const WORKSPACE = "/workspace";

export function randomId(bytes = 8): string {
	return randomBytes(bytes).toString("hex");
}

/** User IDs become volume names or E2B metadata. */
export const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface InternalExecResult extends ExecResult {
	/** SIGKILL had to be sent. */
	killed: boolean;
	/** Signals sent during a stop, in order, with ms since the stop began. */
	stopLog: string[];
	/** Processes of the run still alive after it ended and was reaped (should be 0). */
	leftovers: number;
}

// Apply these before the provider starts its shell. In particular E2B uses a login shell.
export const GIT_USER_ENV = { HOME: "/nonexistent", PATH: "/usr/bin:/bin", ENV: "/dev/null", BASH_ENV: "/dev/null" };

// Existing sandbox images have a single agent-owned wlp-run pid directory.
// Give the transport uid its own per-command directory and signal the entire Git process group.
export function gitProcess(tag: string, argv: string[]): string[] {
	return [
		"/bin/sh",
		"-ec",
		`export PATH=/usr/bin:/bin
umask 077
proxy=
if [ "\${https_proxy:-}" = '${RUNNER_HTTP_PROXY}' ]; then proxy='${RUNNER_HTTP_PROXY}'; fi
dir=/tmp/wlp-transport-process-$1
shift
mkdir -m 700 -- "$dir"
trap 'rm -rf -- "$dir"' EXIT
/usr/bin/env -i PATH=/usr/bin:/bin HOME=/nonexistent LANG=C.UTF-8 https_proxy="$proxy" setsid -w /bin/sh -ec 'echo $$ > "$0/pid"; exec "$@"' "$dir" "$@"`,
		"git-run",
		tag,
		...argv,
	];
}

export function signalGitProcess(tag: string, signal: string): string[] {
	return [
		"/bin/sh",
		"-ec",
		'dir=/tmp/wlp-transport-process-$1; [ ! -L "$dir" ] && [ -O "$dir" ] && read -r pid < "$dir/pid" && /bin/kill -s "$2" -- "-$pid"',
		"git-stop",
		tag,
		signal,
	];
}

export interface StartOptions {
	/** Run as the unprivileged transport user, outside the workspace. */
	gitUser?: true;
	cwd?: string;
	env?: Record<string, string>;
	/** Keep values off command lines. An explicit env entry takes precedence. */
	secretEnv?: Record<string, string>;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface ProcessEnd {
	/** The program's exit code; null when the client was ended by a signal, lost its connection or could not be started. */
	code: number | null;
	signal: string | null;
	/** Set when the program could not be run at all, or the connection to it broke. */
	error: Error | null;
}

/** The tag travels to descendants so signal and sweep can reach the whole run. */
export interface SandboxProcess {
	readonly tag: string;
	/** Writes to standard input, in the order of the calls. False once it is closed or the client is gone. */
	write(text: string): boolean;
	closeStdin(): void;
	/** Resolves when the client has ended and all its output was handed over. Never rejects. */
	readonly ended: Promise<ProcessEnd>;
	readonly hasEnded: boolean;
	/** Sends a signal inside the sandbox: to the program itself, or to every process that carries the tag. */
	signal(sig: "INT" | "TERM" | "KILL", who: "leader" | "all"): Promise<void>;
	/** Ends the client. It does not stop anything inside the sandbox. */
	killClient(): void;
	/** Runner process ID for adoption after server restart. Absent on non-durable providers. */
	readonly runnerProcess?: string | null;
}

export interface Answer {
	code: number | null;
	stdout: string;
	stderr: string;
}

const TURN_SANDBOX = Symbol.for("windlass-platform.turn-sandbox");

/** Supply only platform-generated paths and process tags to these operations. */
export interface TurnSandbox extends SandboxHandle {
	readonly uid: string;
	readonly approval: "auto" | "full";
	/** Starts argv with stdin open. Start failures resolve ended with an error. */
	start(argv: string[], options?: StartOptions): SandboxProcess;
	/** Adopt a surviving runner process and replay output after the server's checkpoint. Null if unavailable. */
	adopt?(process: string, tag: string, output: Pick<StartOptions, "onStdout" | "onStderr">): SandboxProcess | null;
	/** Runs plain argv with empty stdin. Env may appear in process arguments and must be free of secrets. Null if the sandbox is unavailable. */
	ask(argv: string[], options?: { env?: Record<string, string>; timeoutMs?: number }): Promise<Answer | null>;
	/** Stop prior tagged runs of this program, interrupting leaders before killing their groups. */
	stopLeftovers(program: string): Promise<number>;
	/** Wait for tagged processes, kill stragglers and remove files. Returns the number still alive. */
	sweep(tag: string, options?: { waitMs?: number; files?: string[] }): Promise<number>;
	/** Atomically replace a mode-0600 file with content supplied off the command line. Serialize writes per path. */
	writeSecretFile(path: string, content: string): Promise<void>;
	/** Removes files. A no-op for those that are gone, and when the sandbox is. */
	removeFiles(paths: string[]): Promise<void>;
	/** Keep the sandbox running until the returned release is called. May reject if the lease cannot be maintained. */
	holdForTurn(): Promise<() => Promise<void>>;
	readonly windlassKeyProblem?: string;
	modelKeyRelay?(
		sessionId: string,
		key: KeyReference,
		signal?: AbortSignal,
		takeRequest?: TakeRelayRequest,
	): Promise<KeyTurnRelay>;
	/**
	 * A plan's relay inside the sandbox, as another user than the agent's, so the plan's requests leave from the
	 * sandbox's own address (plan-relay.ts). Where a sandbox has it, a plan turn uses it instead of the platform
	 * relay. Rejects, with the relay stopped and nothing written, when it cannot start.
	 */
	localPlanRelay?(token: string, options: LocalPlanRelayOptions): Promise<LocalModelRelay>;
	/**
	 * Takes up a plan relay the runner kept on the machine through a server's restart (a durable link): its token is
	 * handed again with `hand`, and `close` ends it. `onSeen` gets what it saw of the plan from here on.
	 */
	resumePlanRelay?(relay: PlanRelayLease, onSeen?: LocalPlanRelayOptions["onSeen"]): LocalModelRelay;
}

export type TakeRelayRequest = () => Promise<boolean>;

/** What pays for a key-backed turn, and the harness whose routes its lease allows. */
export type KeyReference = CredentialRef & { harness: HarnessId };

export type KeyTurnRelay = TurnModelRelay;

/** A machine's plan relay as a turn's checkpoint records it, for a restarted server to take up (`resumePlanRelay`). No credential. */
export interface PlanRelayLease {
	lease: string;
	placeholder: string;
	env: Record<string, string>;
}

/** Only this scoped platform placeholder crosses to a Docker relay. */
export interface ForwardedKeyLease {
	/** Delivered only to the paired machine that signs requests for this turn. */
	proofKey?: string;
	/** The relay wire (`credentialWire`), not only a provider: `claude-plan` and `chatgpt-plan` forward a plan. Old runners read this name. */
	provider: KeyWire;
	host: string;
	placeholder: string;
	expiresAt: number;
}

export interface TurnModelRelay {
	/** Model URL and allowed origin for the sandbox process. These fields contain no secret. */
	readonly env: Record<string, string>;
	/** What the agent sends in place of the credential: a bearer only this relay takes, for this turn. */
	readonly placeholder: string;
	/** Ends the lease: the relay refuses its placeholder. Never rejects. */
	close(): Promise<void>;
	/** The lease's name where a restarted server can take it up again (a plan relay on a machine): no credential. */
	readonly lease?: string;
}

export function markTurnSandbox(handle: object): void {
	Object.defineProperty(handle, TURN_SANDBOX, { value: true });
}

export function isTurnSandbox(handle: SandboxHandle): handle is TurnSandbox {
	return (handle as unknown as Record<symbol, unknown>)[TURN_SANDBOX] === true;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throws for a name that is not an environment variable's: one with `=` in it would be read as a name and a value. */
export function assertEnvNames(env: Record<string, string> | undefined): void {
	for (const key of Object.keys(env ?? {}))
		if (!ENV_NAME.test(key)) throw new Error(`invalid environment variable name: ${key}`);
}

/** One argument of a command line, quoted for a POSIX shell: for providers whose command API takes a string. */
export function shellQuote(argument: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`;
}

/** Sweep the tag in $1 and remove only the supplied files. */
export const SWEEP_SCRIPT =
	'tag=$1; shift; if [ -n "$(wlp-run list "$tag")" ]; then wlp-run signal "$tag" KILL all; sleep 0.2; fi; [ $# -gt 0 ] && rm -f -- "$@"; wlp-run list "$tag" | wc -l';

// Runs directly via ask(), outside wlp-run, only at a turn boundary. A process can shed its
// run tag, session and parent, but remains visible in the container/guest's PID namespace.
const SWEEP_PROCESSES = `import os, signal, sys, time
from pathlib import Path

guest = sys.argv[1] == "hosted"
uid = os.getuid()
if uid != 1000:
    sys.exit("expected the sandbox agent")
keep = {1, os.getpid()}
if guest:
    # The E2B command launcher may wait for us in a login shell. Its ancestors belong
    # to this provider invocation, never to a previous turn.
    parent = os.getppid()
    while parent > 1:
        keep.add(parent)
        parent = int(Path(f"/proc/{parent}/stat").read_text().rsplit(")", 1)[1].split()[1])
else:
    mounts = Path("/proc/self/mountinfo").read_text().splitlines()
    if not any(line.split()[4] == "/dev/shm" and " - tmpfs " in line for line in mounts):
        sys.exit("missing private token tmpfs")
    init = Path("/proc/1/cmdline").read_bytes().split(b"\\0")
    if init[1:] != [b"--", b"sleep", b"infinity", b""]:
        sys.exit("unexpected container keepalive")
    # The init's original child precedes any orphans it adopted. A lookalike sleep is not exempt.
    keep.add(int(Path("/proc/1/task/1/children").read_text().split()[0]))

deadline = time.monotonic() + 10
while True:
    found = False
    processes = {entry for entry in Path("/proc").iterdir() if entry.name.isdecimal()}
    for proc in processes:
        if int(proc.name) in keep:
            continue
        try:
            status = dict(line.split(":", 1) for line in (proc / "status").read_text(errors="replace").splitlines() if ":" in line)
            if status["State"].split()[0] in ("Z", "X"):
                continue
            owner = int(status["Uid"].split()[0])
            if guest and owner != uid:
                continue
            if not guest and owner == 65534:
                sys.exit(75)
            os.kill(int(proc.name), signal.SIGKILL)
            found = True
        except (FileNotFoundError, ProcessLookupError):
            # It could have forked before exiting. Obtain a fresh process list.
            found = True
    # A process in the first snapshot may have forked and become a zombie before
    # we read its status. Inspect any new PID before reporting an empty sandbox.
    if not found and all(entry in processes for entry in Path("/proc").iterdir() if entry.name.isdecimal()):
        break
    if time.monotonic() >= deadline:
        sys.exit("processes still running")
    time.sleep(0.02)

if len(sys.argv) == 3:
    # A setup could have left a symlink here. Older paired runners reused the staging
    # filename without unlinking it before opening it for the first write.
    Path(sys.argv[2] + ".tmp").unlink(missing_ok=True)
`;

/** Fail closed if the provider cannot confirm that the session is clear for a new handoff. */
export async function sweepSessionProcesses(sandbox: TurnSandbox, tokenPath?: string): Promise<void> {
	const kind = sandbox.profile === "daytona" || sandbox.profile.startsWith("e2b") ? "hosted" : "docker";
	const scan = () =>
		sandbox.ask(["/usr/bin/python3", "-I", "-S", "-c", SWEEP_PROCESSES, kind, ...(tokenPath ? [tokenPath] : [])], {
			timeoutMs: 15_000,
		});
	let result = await scan();
	if (kind === "docker" && result?.code === 75) {
		// No CAP_KILL: only the Git transport UID can signal its own orphan. Spare the
		// provider shells awaiting pkill, then confirm the whole namespace is clear.
		await sandbox.run("exec /usr/bin/pkill -KILL --ignore-ancestors -u 65534", { gitUser: true, timeoutMs: 10_000 });
		result = await scan();
	}
	if (result?.code !== 0) throw new Error("Could not clear leftover sandbox processes.");
}

/** What `writeSecretFile` runs, the content on standard input: a file beside the path (`<path>.tmp`), mode 0600, renamed into place. `$1` is the path. */
export const SECRET_FILE_SCRIPT =
	'set -eu; umask 077; tmp="$1.tmp"; trap \'rm -f -- "$tmp"\' EXIT; rm -f -- "$tmp"; set -C; cat > "$tmp"; mv -fT -- "$tmp" "$1"';

export const RUN_TAG = /^[A-Za-z0-9_-]+$/;

/** Keep in sync with Windlass's bubblewrap startup probe. Providers test the actual sandbox before offering containment. */
export const BWRAP_PROBE = [
	"bwrap",
	"--die-with-parent",
	"--unshare-user-try",
	"--unshare-pid",
	"--unshare-ipc",
	"--unshare-uts",
	"--unshare-cgroup-try",
	"--unshare-net",
	"--ro-bind",
	"/",
	"/",
	"--dev",
	"/dev",
	"--proc",
	"/proc",
	"--tmpfs",
	"/tmp",
	"--",
	"true",
];
