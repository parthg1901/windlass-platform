/**
 * Checks of the copies of agent sessions a machine keeps (server/src/sandbox/machine-backups.ts and the
 * runner's runner/src/session-backups.ts). Run with:
 *
 *   cd server && npx tsx ../scripts/machine-backup-check.ts            no Docker: which machine sessions
 *                                                                     keep a copy, the capability on both
 *                                                                     sides, and the server's real copies
 *                                                                     through the runner's real store over a
 *                                                                     stand-in runner (a directory for the
 *                                                                     volume, local bash for the sandbox)
 *   cd server && npx tsx ../scripts/machine-backup-check.ts --docker[=claude,codex,opencode] [image]
 *                                                                     and the real Docker paths of the
 *                                                                     runner, one container at a time
 *
 * `--docker` needs no sign-in, no network and no runner. For each agent, in its local harness image (the
 * newest ghcr.io/windlassai/windlass-platform-<agent>, WLP_CHECK_<AGENT>_IMAGE, or the image given after
 * the flag for the first agent named): a real ACP turn in a container with no network makes the
 * session (as backup-check.ts `--agents-docker`), the server's real save through the runner's real
 * store and its real Docker transfer into a volume of this run's own, the container removed, a second
 * container where `session/resume` must first fail, the server's real restore into it the same way,
 * and `session/resume` of the same id, which must succeed. Containers and the volume are named
 * `wlp-check-<run>-*`, carry the label dev.windlass-platform=1 and a machine label of this run's own
 * (never a real pairing's), and are removed at the end.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessId, SandboxProfileId } from "../server/src/contract.js";
import type { ExecOptions, ExecResult, SandboxHandle, SandboxLayer } from "../server/src/sandbox/api.js";
import { BACKUP_ENV, PACK_PATH, restoreScript } from "../server/src/sandbox/backup-scripts.js";
import { capabilitiesOf } from "../server/src/sandbox/harnesses.js";
import { type MachineBackupSeam, MachineSessionBackups } from "../server/src/sandbox/machine-backups.js";
import { machineLayer, type RunnerLink } from "../server/src/sandbox/runner-layer.js";
import { privateSessionData } from "../server/src/sandbox/session-data.js";
import { sessionFilesOf } from "../server/src/sandbox/session-files.js";
import {
	SERVER_CAPABILITIES,
	parseRunnerFrame,
	parseServerFrame,
	reportFor,
	type Report,
} from "../server/src/runner/control.js";
import { validArgs, validValue } from "../server/src/runner/protocol.js";
import { BackupStore, type BackupIO, dockerBackupIO } from "../runner/src/session-backups.js";
import { Refusal } from "../runner/src/state.js";
import { Report as Tally } from "./check-report.js";

const tally = new Tally();
const { expect } = tally;
const run = randomBytes(3).toString("hex");
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const withDocker = process.argv.some(arg => arg === "--docker" || arg.startsWith("--docker="));

async function section(name: string, body: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		tally.fail(`${name}: ran to its end`, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
}

async function refused(work: () => Promise<unknown>): Promise<string> {
	try {
		await work();
		return "done";
	} catch (error) {
		return error instanceof Refusal ? "refused" : `threw ${error instanceof Error ? error.message : String(error)}`;
	}
}

// ---------------------------------------------------------------------------------------------
// Which machine sessions keep a copy
// ---------------------------------------------------------------------------------------------

async function decisions(): Promise<void> {
	// A machine's sandboxes, as the machine's layer has them (runner-layer.ts `RunnerSandboxes`).
	const machine = (sessionVolumes: boolean) => ({
		sessionsLiveInSandbox: false,
		privateSessionData: async (profile: SandboxProfileId) => profile === "docker-hardened" && sessionVolumes,
	});
	const rows: Array<{
		what: string;
		harness: HarnessId;
		profile: SandboxProfileId;
		ownDataSandbox?: string | null;
		reviewer?: boolean;
		copy: boolean;
	}> = [
		{ what: "Claude Code (hardened)", harness: "claude", profile: "docker-hardened", copy: true },
		{ what: "Codex (hardened)", harness: "codex", profile: "docker-hardened", copy: true },
		{ what: "Codex (Windlass sandbox profile)", harness: "codex", profile: "docker-windlass-sandbox", copy: true },
		{ what: "OpenCode (hardened)", harness: "opencode", profile: "docker-hardened", copy: true },
		{
			what: "Windlass on the machine's shared volume",
			harness: "windlass",
			profile: "docker-windlass-sandbox",
			copy: false,
		},
		{
			what: "Windlass, hardened, with a data volume of its own",
			harness: "windlass",
			profile: "docker-hardened",
			ownDataSandbox: "mm_0123456789abcdef-aaaaaaaaaaaa",
			copy: true,
		},
		{
			what: "Windlass, hardened, made by a runner without session-volumes (shared volume)",
			harness: "windlass",
			profile: "docker-hardened",
			ownDataSandbox: null,
			copy: false,
		},
		{
			what: "a Windlass reviewer (its data is always its own)",
			harness: "windlass",
			profile: "docker-windlass-sandbox",
			reviewer: true,
			copy: true,
		},
	];
	const sandbox = "mm_0123456789abcdef-aaaaaaaaaaaa";
	for (const row of rows) {
		const facts = {
			harness: row.harness,
			profile: row.profile,
			ownDataSandbox: row.ownDataSandbox ?? null,
			...(row.reviewer && { origin: { role: "reviewer" } }),
		};
		const kept = await privateSessionData(facts, machine(true), sandbox);
		expect(
			`${row.what}: ${row.copy ? "copied after each turn and restored into a replacement" : "not copied (its data outlives the sandbox)"}`,
			kept === row.copy && capabilitiesOf(row.harness).backups === true && sessionFilesOf(row.harness) !== null,
			`privateSessionData=${kept}`,
		);
	}
	// The restore guard on a replacement sandbox (agent-session/sandbox.ts): judged by what the new sandbox has.
	const hardened = { harness: "windlass" as const, profile: "docker-hardened" as const };
	expect(
		"a replacement of a hardened Windlass sandbox restores only when the new one has its own volume too",
		(await privateSessionData(
			{ ...hardened, ownDataSandbox: "mm_x-bbbbbbbbbbbb" },
			machine(true),
			"mm_x-bbbbbbbbbbbb",
		)) && !(await privateSessionData({ ...hardened, ownDataSandbox: null }, machine(false), "mm_x-bbbbbbbbbbbb")),
	);
}

// ---------------------------------------------------------------------------------------------
// The capability, on both sides
// ---------------------------------------------------------------------------------------------

async function capability(): Promise<void> {
	const report = { sessionBackups: true } as unknown as Report;
	expect(
		"the server names session-backups in its welcome; a runner reports sessionBackups only to a server that named it",
		SERVER_CAPABILITIES.includes("session-backups") &&
			reportFor(report, ["session-volumes"]).sessionBackups === undefined &&
			reportFor(report, ["session-backups"]).sessionBackups === true,
	);
	expect(
		"the control frames: forget-backup (actor to runner) and backup-forgotten (runner to actor), with a session id of the platform's form",
		parseServerFrame(JSON.stringify({ kind: "forget-backup", sessionId: "s_0123456789abcdef" })) !== null &&
			parseRunnerFrame(JSON.stringify({ kind: "backup-forgotten", sessionId: "s_0123456789abcdef" })) !== null &&
			parseServerFrame(JSON.stringify({ kind: "forget-backup", sessionId: "../x" })) === null &&
			parseRunnerFrame(JSON.stringify({ kind: "backup-forgotten", sessionId: "a b" })) === null,
	);
	const plain = { kind: "report", docker: { ok: true }, commandSandbox: { ok: true }, freeDiskBytes: 1, sandboxes: [] };
	expect(
		"a newer runner's report with sessionBackups is one the server reads (it is not refused as a bad frame)",
		parseRunnerFrame(JSON.stringify({ ...plain, sessionBackups: true })) !== null &&
			parseRunnerFrame(JSON.stringify(plain)) !== null,
	);
	const owner = { uid: "u_owner", sessionId: "s_0123456789abcdef" };
	const sha = "a".repeat(64);
	expect(
		"the operations' checks: a pack path of the platform's, an owner of the platform's form, a hash, a size",
		validArgs("backupSave", { id: "x", owner, pack: "/tmp/.wlp-backup-abc123.tgz", size: 1, sha256: sha, max: 10 }) &&
			!validArgs("backupSave", { id: "x", owner, pack: "/etc/passwd", size: 1, sha256: sha, max: 10 }) &&
			!validArgs("backupSave", {
				id: "x",
				owner: { uid: "../u", sessionId: "s_1" },
				pack: "/tmp/.wlp-backup-abc123.tgz",
				size: 1,
				sha256: sha,
				max: 10,
			}) &&
			!validArgs("backupRestore", { id: "x", owner, pack: "/tmp/.wlp-backup-abc123.tgz", size: 1, sha256: "zz" }) &&
			validArgs("backupCopy", { from: owner, to: { ...owner, sessionId: "s_fedcba9876543210" } }) &&
			validValue("backupSave", { outcome: "saved", size: 1, sha256: sha }) &&
			!validValue("backupRestore", "restored") &&
			validValue("backupRestore", "placed"),
	);

	// The machine's layer: its copies are there, and available only while the runner's report says so.
	const layerWith = (report: Partial<Report> | null, status = "online") => {
		const facts = { status, name: "m", publicKey: "", report };
		const link = {
			known: facts,
			who: { uid: "u_owner", sessionId: "s_0123456789abcdef", machineId: "m_0123456789abcdef" },
			facts: async () => facts,
		} as unknown as RunnerLink;
		const hosted = { tokens: {}, logins: {}, windlass: { problem: () => null } } as unknown as SandboxLayer;
		return machineLayer(link, hosted);
	};
	const older = layerWith({});
	const newer = layerWith({ sessionBackups: true });
	const removed = layerWith({ sessionBackups: true }, "removed");
	expect(
		"an older runner (no sessionBackups in its report): the machine's layer has copies that are not available, so none is saved or restored",
		older.backups instanceof MachineSessionBackups &&
			(await older.backups.available?.()) === false &&
			(await newer.backups?.available?.()) === true &&
			(await removed.backups?.available?.()) === false,
	);
}

// ---------------------------------------------------------------------------------------------
// The server's copies through the runner's store, over a stand-in runner
// ---------------------------------------------------------------------------------------------

/** A sandbox that runs the scripts with local bash: its /tmp and the agent's data directory are directories of its own. */
class LocalSandbox implements SandboxHandle {
	readonly cwd = "/workspace";
	readonly profile = "docker-hardened" as const;
	readonly tmp: string;
	readonly data: string;
	constructor(
		readonly id: string,
		readonly dir: string,
	) {
		this.tmp = join(dir, "tmp");
		this.data = join(dir, "data");
		mkdirSync(this.tmp, { recursive: true });
	}
	/** Where a path of the sandbox's /tmp is here. */
	local(pack: string): string {
		return join(this.tmp, pack.replace(/^\/tmp\//, ""));
	}
	async run(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		const env = { ...options.env };
		if (env[BACKUP_ENV.pack]) env[BACKUP_ENV.pack] = this.local(env[BACKUP_ENV.pack]);
		if (env[BACKUP_ENV.data]) env[BACKUP_ENV.data] = this.data;
		const local = command.replaceAll("rm -f /tmp/.wlp-backup-*", `rm -f ${this.tmp}/.wlp-backup-*`);
		const result = spawnSync("bash", ["-c", local], {
			env: { PATH: process.env.PATH ?? "", ...env },
			encoding: "utf8",
		});
		return { exitCode: result.status, timedOut: false, aborted: false, stdout: result.stdout, stderr: result.stderr };
	}
	async readTextFile(): Promise<string> {
		throw new Error("not used");
	}
	async writeTextFile(): Promise<void> {
		throw new Error("not used");
	}
}

/** The runner's Docker transfer, played on directories: the volume is one, each sandbox another. */
function directoryIO(volume: string, sandboxes: Map<string, LocalSandbox>): BackupIO {
	const box = (container: string) => {
		const found = sandboxes.get(container);
		if (!found) throw new Error(`no sandbox ${container}`);
		return found;
	};
	const used = () =>
		existsSync(volume)
			? readdirSync(volume, { recursive: true, withFileTypes: true })
					.filter(entry => entry.isFile())
					.reduce((sum, entry) => sum + readFileSync(join(entry.parentPath, entry.name)).length, 0)
			: 0;
	const file = (uid: string, session: string) => join(volume, uid, `${session}.tgz`);
	const size = (path: string) => (existsSync(path) ? readFileSync(path).length : 0);
	return {
		async readPack(container, pack, limit) {
			const path = box(container).local(pack);
			if (!existsSync(path)) return null;
			const data = readFileSync(path);
			return data.length > limit ? "too_large" : data;
		},
		async dropPack(container, pack) {
			rmSync(box(container).local(pack), { force: true });
		},
		async putPack(container, pack, data) {
			writeFileSync(box(container).local(pack), data, { mode: 0o600 });
			return true;
		},
		async read(uid, session, limit) {
			const path = file(uid, session);
			if (!existsSync(path)) return null;
			const data = readFileSync(path);
			return data.length > limit ? "too_large" : data;
		},
		async write(uid, session, data, total) {
			const path = file(uid, session);
			if (used() - size(path) + data.length > total) return "full";
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, data, { mode: 0o600 });
			return "ok";
		},
		async copy(uid, from, to, total) {
			const source = file(uid, from);
			if (!existsSync(source)) return "missing";
			if (used() - size(file(uid, to)) + size(source) > total) return "full";
			writeFileSync(file(uid, to), readFileSync(source), { mode: 0o600 });
			return "ok";
		},
		async remove(uid, session) {
			rmSync(file(uid, session), { force: true });
		},
	};
}

/** The real link's part, played for one session: the runner's store asked as that session's socket would. */
function standInRunner(store: BackupStore, session: string, available = true): MachineBackupSeam {
	return {
		available: async () => available,
		save: args => store.save(session, args.id, args),
		restore: args => store.restore(session, args.id, args),
		copy: args => store.copy(session, args),
		remove: sessionId => store.remove(sessionId),
	};
}

const CLAUDE_ID = "0b9c6a52-3f5e-4b8f-9b1c-2d6c4f1e7a10";

async function standIn(): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "wlp-machine-backup-"));
	try {
		const uid = "u_owner";
		const sessionA = "s_0123456789abcdef";
		const sessionB = "s_fedcba9876543210";
		const owner = { uid, sessionId: sessionA };
		const claude = { harness: "claude", sessionId: CLAUDE_ID } as const;
		const volume = join(scratch, "volume");
		const sandboxes = new Map<string, LocalSandbox>();
		const make = (id: string) => {
			const sandbox = new LocalSandbox(id, join(scratch, id));
			sandboxes.set(id, sandbox);
			return sandbox;
		};
		const store = new BackupStore(uid, directoryIO(volume, sandboxes), 200_000);
		const backups = new MachineSessionBackups(100_000, standInRunner(store, sessionA));
		const old = make("old");
		const transcript = join(old.data, "projects", "-workspace", `${CLAUDE_ID}.jsonl`);
		mkdirSync(dirname(transcript), { recursive: true });
		writeFileSync(transcript, `${JSON.stringify({ type: "user", text: "hello" })}\n`);
		writeFileSync(join(old.data, ".credentials.json"), "a sign-in");

		const saved = await backups.save(old, owner, claude);
		const kept = join(volume, uid, `${sessionA}.tgz`);
		const keptBytes = existsSync(kept) ? readFileSync(kept) : Buffer.alloc(0);
		expect(
			"a save packs in the sandbox with the real script, and the runner keeps the archive in its volume, recording what it measured",
			saved.outcome === "saved" &&
				saved.backup.size === keptBytes.length &&
				saved.backup.sha256 === sha256(keptBytes) &&
				readdirSync(old.tmp).length === 0,
			JSON.stringify(saved),
		);
		const listed = spawnSync("tar", ["-tzf", kept], { encoding: "utf8" }).stdout.trim().split("\n");
		expect(
			"the copy holds the session's transcript and nothing named for a sign-in",
			listed.length === 1 && listed[0] === `projects/-workspace/${CLAUDE_ID}.jsonl`,
			listed.join(","),
		);
		if (saved.outcome !== "saved") return;
		const record = saved.backup;

		// The sandbox is lost: a new one, which has never seen the session.
		const fresh = make("new");
		const restored = await backups.restore(fresh, owner, record, claude);
		const back = join(fresh.data, "projects", "-workspace", `${CLAUDE_ID}.jsonl`);
		expect(
			"a restore: the runner checks the copy against the recorded size and hash, puts it in the new sandbox, and the real script unpacks it",
			restored.outcome === "restored" &&
				existsSync(back) &&
				readFileSync(back, "utf8") === readFileSync(transcript, "utf8") &&
				!existsSync(join(fresh.data, ".credentials.json")) &&
				readdirSync(fresh.tmp).length === 0,
			JSON.stringify(restored),
		);

		// A copy in the volume that is not the one recorded: same size, other bytes.
		const tampered = Buffer.from(keptBytes);
		tampered[tampered.length - 1] ^= 0xff;
		writeFileSync(kept, tampered);
		const third = make("third");
		const wrongHash = await backups.restore(third, owner, record, claude);
		expect(
			"a copy whose hash is not the recorded one is never put in the sandbox, and nothing is unpacked",
			wrongHash.outcome === "failed" &&
				/hash differs/.test(wrongHash.reason) &&
				!existsSync(third.data) &&
				readdirSync(third.tmp).length === 0,
			JSON.stringify(wrongHash),
		);
		writeFileSync(kept, keptBytes);

		// An archive with a name a copy never holds, recorded as if this session had saved it: the restore script refuses it.
		const evilDir = join(scratch, "evil");
		mkdirSync(join(evilDir, "projects", "-workspace"), { recursive: true });
		writeFileSync(join(evilDir, "projects", "-workspace", `${CLAUDE_ID}.jsonl`), "{}\n");
		writeFileSync(join(evilDir, "settings.json"), '{"hooks":{}}');
		const evil = spawnSync("tar", [
			"-czf",
			"-",
			"-C",
			evilDir,
			`projects/-workspace/${CLAUDE_ID}.jsonl`,
			"settings.json",
		]).stdout;
		writeFileSync(kept, evil);
		const fourth = make("fourth");
		const disallowed = await backups.restore(fourth, owner, { size: evil.length, sha256: sha256(evil), at: 0 }, claude);
		expect(
			"a copy holding a name the agent's description does not allow is not unpacked at all",
			disallowed.outcome === "failed" && /never holds/.test(disallowed.reason) && !existsSync(fourth.data),
			JSON.stringify(disallowed),
		);
		writeFileSync(kept, keptBytes);

		// The runner's own refusals, whatever the server asks.
		const args = { id: "old", owner, pack: "/tmp/.wlp-backup-abcdef.tgz", size: 1, sha256: "a".repeat(64), max: 10 };
		const refusals = [
			await refused(() => store.save(sessionA, "old", { ...args, owner: { uid: "u_other", sessionId: sessionA } })),
			await refused(() => store.save(sessionB, "old", args)),
			await refused(() => store.save(sessionA, "old", { ...args, pack: "/etc/passwd" })),
			await refused(() => store.save(sessionA, "old", { ...args, owner: { uid, sessionId: "../../x" } })),
			await refused(() => store.restore(sessionB, "new", { ...args, owner })),
			await refused(() => store.copy(sessionA, { from: owner, to: { uid, sessionId: sessionB } })),
			await refused(() =>
				store.copy(sessionB, { from: { uid: "u_other", sessionId: sessionA }, to: { uid, sessionId: sessionB } }),
			),
			await refused(() => store.remove("../x")),
		];
		expect(
			"the runner refuses another user's copy, another session's, a path not of the platform's, a name that is not one, and a copy to a session that did not ask",
			refusals.every(answer => answer === "refused"),
			refusals.join(","),
		);
		const keyRefused = await backups.save(old, { uid, sessionId: "../x" }, claude);
		expect(
			"the server refuses a copy named by anything but a user id and a session id before asking anything",
			keyRefused.outcome === "failed",
		);

		// A sandbox that lies about what it packed.
		const liar: SandboxHandle = {
			id: "old",
			cwd: old.cwd,
			profile: old.profile,
			readTextFile: () => old.readTextFile(),
			writeTextFile: () => old.writeTextFile(),
			run: async (command, options) => {
				const result = await old.run(command, options);
				return result.stdout.includes("packed ")
					? { ...result, stdout: result.stdout.replace(/[0-9a-f]{64}/, "b".repeat(64)) }
					: result;
			},
		};
		const lied = await backups.save(liar, owner, claude);
		expect(
			"an archive that is not what the sandbox printed is not kept, and the session's earlier copy stays",
			lied.outcome === "failed" &&
				/not the one the sandbox packed/.test(lied.reason) &&
				sha256(readFileSync(kept)) === record.sha256 &&
				readdirSync(old.tmp).length === 0,
			JSON.stringify(lied),
		);

		// The limits.
		const small = new MachineSessionBackups(10, standInRunner(store, sessionA));
		const tooLarge = await small.save(old, owner, claude);
		const fullStore = new BackupStore(uid, directoryIO(volume, sandboxes), 10);
		const full = await new MachineSessionBackups(100_000, standInRunner(fullStore, sessionA)).save(old, owner, claude);
		expect(
			"over the per-session limit: too_large; past the volume's total: refused as full; the earlier copy stays either way",
			tooLarge.outcome === "too_large" &&
				full.outcome === "failed" &&
				/no room/.test(full.reason) &&
				sha256(readFileSync(kept)) === record.sha256,
			`${JSON.stringify(tooLarge)} ${JSON.stringify(full)}`,
		);

		// Continuing in a new session: asked over the new session's socket.
		const forB = new MachineSessionBackups(100_000, standInRunner(store, sessionB));
		const copied = await forB.copy(owner, { uid, sessionId: sessionB });
		const none = await forB.copy({ uid, sessionId: "s_none" }, { uid, sessionId: sessionB });
		const fifth = make("fifth");
		const restoredB = await forB.restore(fifth, { uid, sessionId: sessionB }, record, claude);
		expect(
			"a session's copy is copied to a new session's name by the new session's socket, and restores there with the same record; a copy of nothing is false",
			copied && !none && restoredB.outcome === "restored",
			JSON.stringify(restoredB),
		);

		await backups.remove(owner);
		const sixth = make("sixth");
		const gone = await backups.restore(sixth, owner, record, claude);
		expect(
			"remove takes the copy away, a restore then finds none, and removing it again is no error",
			!existsSync(kept) && gone.outcome === "missing" && (await refused(() => backups.remove(owner))) === "done",
			JSON.stringify(gone),
		);
		expect(
			"the restore script for a machine fetches nothing: no curl, and a pack that is not a plain file is missing",
			!restoreScript(sessionFilesOf("claude")!, "file").includes("curl") &&
				restoreScript(sessionFilesOf("claude")!, "file").includes("echo missing") &&
				PACK_PATH.test("/tmp/.wlp-backup-abc123.tgz") &&
				!PACK_PATH.test("/tmp/.wlp-backup-../x.tgz"),
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------
// Real Docker: the runner's real transfer, real agents
// ---------------------------------------------------------------------------------------------

/** backup-check.ts's ACP driver (its `--agents-docker` turns), read from its source: its template's escapes undone. */
const ACP_DRIVE = readFileSync(new URL("./backup-check.ts", import.meta.url), "utf8")
	.match(/const ACP_DRIVE = `([\s\S]*?)`;/)?.[1]
	?.replaceAll("\\\\", "\\");

const PLACEHOLDER = `wlp-check-placeholder-${randomBytes(6).toString("hex")}`;
const MODEL_STUB_PORT = 17999;
const MODEL_STUB = `require("http").createServer((q, r) => { if (q.method === "GET" && /\\/models$/.test(q.url.split("?")[0])) { r.setHeader("content-type", "application/json"); r.end(JSON.stringify({ object: "list", data: [{ id: "gpt-5.1-codex", object: "model", created: 0, owned_by: "openai" }] })); } else { r.statusCode = 500; r.end("{}"); } }).listen(${MODEL_STUB_PORT}, "127.0.0.1");`;
const AGENT_TURNS: Record<
	"claude" | "codex" | "opencode",
	{ command: string; env: Record<string, string>; setup?: [string, unknown]; caps?: object; modelList?: boolean }
> = {
	claude: {
		command: "wlp-claude-acp",
		env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_API_KEY: PLACEHOLDER },
	},
	codex: {
		caps: { auth: { _meta: { gateway: true } } },
		command: "wlp-codex-acp",
		env: { WLP_CODEX_BASE_URL: `http://127.0.0.1:${MODEL_STUB_PORT}/v1`, WLP_SESSION_BEARER: PLACEHOLDER },
		modelList: true,
		setup: [
			"providers/set",
			{ providerId: "openai", apiType: "openai", baseUrl: "http://127.0.0.1:17892/codex/v1", headers: {} },
		],
	},
	opencode: {
		command: "wlp-opencode-acp",
		env: {
			OPENCODE_AUTH_CONTENT: JSON.stringify({ anthropic: { type: "api", key: PLACEHOLDER } }),
			OPENCODE_CONFIG_CONTENT: JSON.stringify({
				enabled_providers: ["anthropic"],
				provider: { anthropic: { options: { baseURL: "http://127.0.0.1:9/v1" } } },
			}),
		},
	},
};

function dockerExec(
	container: string,
	argv: string[],
	options: { env?: Record<string, string>; stdin?: string; cwd?: string; timeoutMs?: number } = {},
) {
	const env = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
	const result = spawnSync("docker", ["exec", "-i", "-w", options.cwd ?? "/", ...env, container, ...argv], {
		input: options.stdin ?? "",
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
		timeout: options.timeoutMs ?? 240_000,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** A sandbox handle over `docker exec`, as the runner's `run` gives one: the container's user, cwd /. */
function containerHandle(container: string): SandboxHandle {
	return {
		id: container,
		cwd: "/workspace",
		profile: "docker-hardened",
		async run(command, options = {}) {
			const done = dockerExec(container, ["bash", "-c", command], {
				env: options.env,
				stdin: options.stdin,
				timeoutMs: options.timeoutMs,
			});
			return { exitCode: done.status, timedOut: false, aborted: false, stdout: done.stdout, stderr: done.stderr };
		},
		readTextFile: async () => "",
		writeTextFile: async () => undefined,
	};
}

function harnessImage(harness: string, given?: string): string | null {
	if (given) return given;
	const named = process.env[`WLP_CHECK_${harness.toUpperCase()}_IMAGE`];
	if (named) return named;
	const listed = spawnSync(
		"docker",
		["images", "--format", "{{.ID}}", `ghcr.io/windlassai/windlass-platform-${harness}`],
		{
			encoding: "utf8",
		},
	);
	return listed.stdout.trim().split("\n")[0] || null;
}

async function realDocker(): Promise<void> {
	if (!ACP_DRIVE) throw new Error("backup-check.ts's ACP driver could not be read");
	const flag = process.argv.find(arg => arg === "--docker" || arg.startsWith("--docker="))!;
	const only = flag.includes("=") ? flag.split("=")[1].split(",") : ["claude", "codex", "opencode"];
	const given = process.argv[process.argv.indexOf(flag) + 1];
	const machineLabel = `wlp-check-${run}`;
	const volume = `wlp-check-${run}-backups`;
	const labels = { "dev.windlass-platform.machine": machineLabel, "dev.windlass-platform.uid": "u_check" };
	const containers: string[] = [];
	const volumeLabels = () =>
		JSON.parse(spawnSync("docker", ["volume", "inspect", volume], { encoding: "utf8" }).stdout || "[]")[0]?.Labels ??
		{};
	try {
		for (const [index, harness] of (only as Array<"claude" | "codex" | "opencode">).entries()) {
			const image = harnessImage(harness, index === 0 && given && !given.startsWith("--") ? given : undefined);
			if (!image) {
				tally.skip(`${harness}: real containers`, `no local ghcr.io/windlassai/windlass-platform-${harness} image`);
				continue;
			}
			console.log(`      ${harness}: image ${image}`);
			const turn = AGENT_TURNS[harness];
			const files = sessionFilesOf(harness)!;
			// The runner's real store and Docker transfer, against this run's own volume; the helper runs the harness image (built on the base).
			const store = new BackupStore(
				"u_check",
				dockerBackupIO({
					volume,
					labels,
					image,
					ownedVolume: async create => {
						const exists = spawnSync("docker", ["volume", "inspect", volume]).status === 0;
						if (!exists) {
							if (!create) return false;
							spawnSync("docker", [
								"volume",
								"create",
								"--label",
								"dev.windlass-platform=1",
								...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
								volume,
							]);
						}
						const found = volumeLabels();
						if (found["dev.windlass-platform"] !== "1" || found["dev.windlass-platform.machine"] !== machineLabel)
							throw new Refusal("not this run's volume");
						return true;
					},
				}),
			);
			const session = `s_check${run}${index}`;
			const owner = { uid: "u_check", sessionId: session };
			const start = (name: string) => {
				containers.push(name);
				return (
					spawnSync("docker", [
						"run",
						"-d",
						"--name",
						name,
						"--network",
						"none",
						"--label",
						"dev.windlass-platform=1",
						"--label",
						`dev.windlass-platform.machine=${machineLabel}`,
						image,
						"sleep",
						"1200",
					]).status === 0
				);
			};
			const prepare = (name: string) => {
				dockerExec(name, [
					"sh",
					"-c",
					"cd /workspace && git init -q && git -c user.email=c@example.invalid -c user.name=check commit -q --allow-empty -m init",
				]);
				if (turn.modelList) spawnSync("docker", ["exec", "-d", name, "node", "-e", MODEL_STUB]);
				dockerExec(name, ["sh", "-c", "cat > /tmp/wlp-acp-drive.mjs"], { stdin: ACP_DRIVE });
			};
			const drive = (name: string, steps: unknown[]) =>
				dockerExec(name, ["node", "/tmp/wlp-acp-drive.mjs", turn.command, JSON.stringify(steps)], {
					env: turn.env,
					cwd: "/workspace",
					timeoutMs: 300_000,
				})
					.stdout.trim()
					.split("\n")
					.flatMap(line => {
						try {
							return [JSON.parse(line) as { method: string; result?: { sessionId?: string }; error?: unknown }];
						} catch {
							return [];
						}
					});
			const init: unknown[] = [
				[
					"initialize",
					{
						protocolVersion: 1,
						clientCapabilities: { ...turn.caps, fs: { readTextFile: false, writeTextFile: false }, terminal: false },
					},
				],
				...(turn.setup ? [turn.setup] : []),
			];
			const [oldName, newName] = [`wlp-check-${run}-${harness}-old`, `wlp-check-${run}-${harness}-new`];

			// One container at a time: the old sandbox, its turn, its save; then it is removed.
			if (!start(oldName)) throw new Error("the old container could not be started");
			prepare(oldName);
			if (turn.modelList) await new Promise(done => setTimeout(done, 1000));
			const made = drive(oldName, [
				...init,
				["session/new", { cwd: "/workspace", mcpServers: [] }],
				["session/prompt", { sessionId: "$SESSION", prompt: [{ type: "text", text: "Say hi." }] }, 45_000],
			]);
			const agentSession = made.find(answer => answer.method === "session/new")?.result?.sessionId ?? "";
			if (
				!expect(
					`${harness}: a real turn makes a session`,
					new RegExp(files.id).test(agentSession),
					agentSession || JSON.stringify(made),
				)
			)
				continue;
			const agent = { harness, sessionId: agentSession } as const;
			const saveAs = (name: string) =>
				new MachineSessionBackups(64 * 1024 * 1024, {
					available: async () => true,
					save: args => store.save(session, name, { ...args, id: name }),
					restore: args => store.restore(session, name, { ...args, id: name }),
					copy: args => store.copy(session, args),
					remove: id => store.remove(id),
				});
			const saved = await saveAs(oldName).save(containerHandle(oldName), owner, agent);
			const leftover = dockerExec(oldName, ["sh", "-c", "ls -A /tmp | grep -c '^.wlp-backup-' || true"]).stdout.trim();
			expect(
				`${harness}: the real save: packed in the sandbox, moved by the runner's Docker transfer into the volume, the pack removed`,
				saved.outcome === "saved" &&
					leftover === "0" &&
					volumeLabels()["dev.windlass-platform.machine"] === machineLabel,
				JSON.stringify(saved),
			);
			spawnSync("docker", ["rm", "-f", oldName]);
			if (saved.outcome !== "saved") continue;

			// The replacement: it cannot resume the session before the restore.
			if (!start(newName)) throw new Error("the new container could not be started");
			prepare(newName);
			if (turn.modelList) await new Promise(done => setTimeout(done, 1000));
			const resume = ["session/resume", { sessionId: agentSession, cwd: "/workspace", mcpServers: [] }];
			const before = drive(newName, [...init, resume]).find(answer => answer.method === "session/resume");
			expect(
				`${harness}: the new sandbox cannot resume the session before the restore (so the check below means something)`,
				before?.error !== undefined,
				JSON.stringify(before),
			);
			const wrong = await saveAs(newName).restore(
				containerHandle(newName),
				owner,
				{ ...saved.backup, sha256: "0".repeat(64) },
				agent,
			);
			expect(
				`${harness}: a record whose hash is not the copy's: nothing is put in the sandbox`,
				wrong.outcome === "failed" &&
					dockerExec(newName, ["sh", "-c", "ls -A /tmp | grep -c '^.wlp-backup-' || true"]).stdout.trim() === "0",
				JSON.stringify(wrong),
			);
			const restored = await saveAs(newName).restore(containerHandle(newName), owner, saved.backup, agent);
			expect(
				`${harness}: the real restore into the new sandbox`,
				restored.outcome === "restored",
				JSON.stringify(restored),
			);
			const after = drive(newName, [...init, resume]).find(answer => answer.method === "session/resume");
			expect(
				`${harness}: after the restore, the agent resumes the same session in the new sandbox`,
				after?.result !== undefined && after.error === undefined,
				JSON.stringify(after),
			);
			await store.remove(session);
			const read = await store.restore(session, newName, {
				id: newName,
				owner,
				pack: "/tmp/.wlp-backup-check01.tgz",
				size: saved.backup.size,
				sha256: saved.backup.sha256,
			});
			expect(`${harness}: the copy is removed from the volume`, read === "missing", read);
			spawnSync("docker", ["rm", "-f", newName]);
		}
	} finally {
		if (containers.length) spawnSync("docker", ["rm", "-f", ...containers]);
		// Only this run's volume, by its own name and label.
		if (volumeLabels()["dev.windlass-platform.machine"] === machineLabel)
			spawnSync("docker", ["volume", "rm", "-f", volume]);
		const left = spawnSync("docker", ["ps", "-aq", "--filter", `label=dev.windlass-platform.machine=${machineLabel}`], {
			encoding: "utf8",
		}).stdout.trim();
		expect(
			"nothing of this run is left in Docker",
			left === "" && spawnSync("docker", ["volume", "inspect", volume]).status !== 0,
			left,
		);
	}
}

async function main(): Promise<number> {
	await section("which machine sessions keep a copy", decisions);
	await section("the session-backups capability, on both sides", capability);
	await section("the server's copies through the runner's store, over a stand-in runner", standIn);
	if (withDocker) await section("the runner's real Docker transfer, real agents, one container at a time", realDocker);
	else console.log("\n== real Docker\n      skipped: run with --docker");
	return tally.summary(true);
}

process.exitCode = await main();
