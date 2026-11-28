import { revokeMachineLeases } from "../sandbox/relay-leases.js";
import { randomBytes } from "node:crypto";
import {
	authFailure,
	FrameAuthError,
	machineStatement,
	platformWelcome,
	type FrameAuth,
} from "../runner/frame-auth.js";
import { NAME } from "../sandbox/provider.js";
import { compactReport, optionsDigest, type CatalogFrame, type CatalogId } from "../runner/catalog.js";
import { actor, UserError } from "rivetkit";
import { db, type RawAccess } from "rivetkit/db";
import { assertOrigin, requireServiceFor, serviceParams } from "../auth.js";
import { config } from "../config.js";
import {
	isMachineIdName,
	machineLabel,
	sandboxSlots,
	type MachineSummary,
	MACHINE_EXPIRY_MS,
	type HarnessOptions,
	type MachineClaim,
	type MachineStatus,
	type MachineWarning,
} from "../contract.js";
import { MINUTE_MS } from "../http-limits.js";
import { machineError, signed } from "../runner-keys.js";
import {
	ControlQueue,
	CLOCK_TOLERANCE_MS,
	CONTROL_DEAD_MS,
	CONTROL_HEARTBEAT_MS,
	MACHINE_ID,
	MAX_REPORT_BYTES,
	MIN_RUNNER_VERSION,
	REFUSED_RETRY_MS,
	controlProof,
	parseRunnerFrame,
	refuse,
	secondHello,
	versionAtLeast,
	welcomeCapabilities,
	type Refusal,
	type Report,
	type ServerFrame,
} from "../runner/control.js";
import { grantIsValid, isSessionGone, sessionActor, type ActorClient } from "./internal.js";

const SEEN_INTERVAL = 3 * 60_000;
// A refused copy has no open socket. Give it time to retry before retiring the warning.
const KEY_WARNING_MS = REFUSED_RETRY_MS + CONTROL_DEAD_MS;
/**
 * How long a control socket may stay open without a hello. The runner sends it as soon as the challenge
 * arrives; a socket that never does would otherwise keep the actor awake until CONTROL_DEAD_MS.
 */
const HELLO_WAIT_MS = 10_000;
interface Socket {
	send(frame: ServerFrame): boolean;
	close(code: number, reason: string): void;
}
interface Live {
	slots?: Report["slots"];
	maxTurns?: number;
	offset: number;
	ws: Socket;
	epoch: string;
	heardAt: number;
	connected: number;
	savedAt: number;
	/** Its report said it keeps copies of agent sessions (`sessionBackups`): it is told of the removals pending. */
	backups?: boolean;
}
/** `greeting` is the one control socket that has yet to say hello: a newer one replaces it. */
interface Vars {
	system?: { os: string; arch: string };
	retryOnFrame: boolean;
	nextSlotCheck: number;
	live: Live | null;
	work: Promise<void>;
	greeting: Socket | null;
	/** The `internalForgetClaudeLogin` calls waiting for the runner's `claude-login-forgotten`. */
	loginRemovals: Set<(answer: ClaudeLoginRemoval) => void>;
}
/** How a request to remove the machine's own Claude login ended: removed, refused by Docker, or no runner to ask. */
export type ClaudeLoginRemoval = "removed" | "failed" | "offline";
/** How long the runner has to remove the login and answer: a helper container and a relay to stop. */
const LOGIN_REMOVAL_MS = 45_000;
interface Ctx {
	db: RawAccess;
	vars: Vars;
	key: string[];
	schedule: {
		at(timestamp: number, action: string, ...args: number[]): Promise<string>;
		list(): Promise<Array<{ action: string; runAt: number }>>;
	};
	// Actor references are resolved through this node's registry.
	client(): ActorClient;
}
interface Input {
	grant: string;
	details: MachineClaim;
	publicKey: string;
	expires: number;
}
type Row = {
	protocol: number;
	name: string;
	version: string;
	public_key: string;
	created: number;
	seen: number | null;
	removed_at: number | null;
	remove_sandboxes: number;
	offset: number;
	duplicate: number | null;
	report: string | null;
	host: string | null;
};
export interface MachineUpdate {
	slots?: MachineSummary["slots"];
	host?: Report["host"];
	name?: string;
	turns?: { running: number; max: number | null; queued: number };
	status: MachineStatus;
	since: number;
	runnerVersion: string;
	warnings: MachineWarning[];
	report: Report | null;
}
/** `publicKey` is the machine's Ed25519 key, SPKI in base64; it never changes (pairing again makes a new machine). */
export interface MachineFacts {
	status: MachineStatus | "removed";
	name: string;
	publicKey: string;
	report: Report | null;
}
export type TurnSlot =
	| { state: "granted" | "reconnecting" | "offline" | "removed" | "unsupported" }
	| { state: "waiting"; size: number; busy: number; max: number | null; behind: boolean };
type SlotRow = { session: string; turn: number; running: number; size: number };
export type Attachment = { ok: true } | { ok: false; reason: "offline" | "removed" | "unknown" };

const controlPath = (r?: Request) => !!r && new URL(r.url).pathname === "/websocket/control";
function reject(ws: Socket, frame: Refusal) {
	ws.send(frame);
	ws.close(1008, frame.reason);
}

// A socket and a SQL write cannot be updated in one SQL statement. Order those transitions,
// including delivery to the user's index, so an old close can never overtake a new welcome.
function ordered<T>(c: Ctx, step: () => Promise<T>): Promise<T> {
	const result = c.vars.work.then(step);
	c.vars.work = result.then(
		() => {},
		() => {},
	);
	return result;
}

// The FIFO belongs to the machine, across control sockets and actor sleeps. Only a new
// request, a grant or a release writes SQLite. Polls of a full queue are read-only.
async function requestSlot(c: Ctx, session: string, turn: number, requested: number): Promise<TurnSlot> {
	const rows = await c.db.execute<SlotRow>("SELECT session, turn, running, size FROM turn_slots ORDER BY rowid");
	const own = rows.find(row => row.session === session && row.turn === turn);
	if (!c.vars.live) {
		const machine = await record(c);
		if (!machine || machine.removed_at !== null) return { state: "removed" };
		return { state: own ? "reconnecting" : "offline" };
	}
	if (own?.running) return { state: "granted" };
	if (requested > 1 && !c.vars.live.slots) return { state: "unsupported" };
	const max = c.vars.live.slots?.max ?? c.vars.live.maxTurns;
	const size = sandboxSlots(requested, c.vars.live.slots?.max ?? 1);
	const busy = rows.reduce((total, row) => total + (row.running ? row.size : 0), 0);
	// Strict FIFO: keep a smaller turn behind the head so large turns cannot starve.
	const first = rows.find(row => !row.running);
	const behind = first !== undefined && first !== own;
	const grant = !behind && (max === undefined || busy + size <= max);
	if (!own)
		await c.db.execute(
			"INSERT INTO turn_slots (session, turn, running, size) VALUES (?, ?, ?, ?)",
			session,
			turn,
			Number(grant),
			size,
		);
	else if (grant || own.size !== size)
		await c.db.execute(
			"UPDATE turn_slots SET running = ?, size = ? WHERE session = ? AND turn = ?",
			Number(grant),
			size,
			session,
			turn,
		);
	if (!own || grant || own.size !== size) await tell(c, await record(c));
	return grant ? { state: "granted" } : { state: "waiting", size, busy, max: max ?? null, behind };
}

// A session node can die before its release arrives. Reconcile by turn number, outside
// the machine's control queue, so a sleeping session can call back during recovery.
async function reapSlots(c: Ctx) {
	const rows = await c.db.execute<SlotRow>("SELECT session, turn, running, size FROM turn_slots");
	await Promise.all(
		rows.map(async row => {
			try {
				const summary = await sessionActor(c, c.key[0]!, row.session).internalSummary();
				if (summary.turns === row.turn && summary.status !== "idle") return;
			} catch (error) {
				if (!isSessionGone(error)) return;
			}
			await ordered(c, async () => {
				await c.db.execute("DELETE FROM turn_slots WHERE session = ? AND turn = ?", row.session, row.turn);
				await tell(c, await record(c));
			});
		}),
	);
}

async function record(c: Ctx) {
	return (await c.db.execute<Row>("SELECT * FROM machine"))[0];
}
const user = (c: Pick<Ctx, "key" | "client">) => c.client().user.get([c.key[0]], { params: serviceParams() });
function update(c: Ctx, row: Row): MachineUpdate {
	const report: Report | null = row.report ? JSON.parse(row.report) : null;
	const warnings: MachineWarning[] = [];
	if (!config.machines?.identity && row.protocol === 2) warnings.push({ kind: "signing-disabled" });
	if ((config.machines?.identity && row.protocol === 1) || !versionAtLeast(row.version, MIN_RUNNER_VERSION))
		warnings.push({ kind: "outdated" });
	if (report && !report.docker.ok) warnings.push({ kind: "docker", reason: report.docker.reason });
	if (Math.abs(row.offset) > CLOCK_TOLERANCE_MS)
		warnings.push({ kind: "clock", offsetSeconds: Math.round(row.offset / 1000) });
	if (row.duplicate !== null && Date.now() < row.duplicate + KEY_WARNING_MS)
		warnings.push({ kind: "key", at: row.duplicate });
	return {
		host: row.host ? JSON.parse(row.host) : undefined,
		name: row.name,
		status: c.vars.live ? "online" : row.seen === null ? "waiting" : "offline",
		since: c.vars.live?.connected ?? row.seen ?? row.created,
		runnerVersion: row.version,
		warnings,
		report,
	};
}
async function publish(c: Ctx, row: Row) {
	const facts = row.removed_at === null ? update(c, row) : null;
	if (facts) {
		const [counts] = await c.db.execute<{ running: number; waiting: number; busy: number; queued: number }>(`SELECT
			count(*) FILTER (WHERE running=1) AS running, count(*) FILTER (WHERE running=0) AS waiting,
			coalesce(sum(size) FILTER (WHERE running=1), 0) AS busy, coalesce(sum(size) FILTER (WHERE running=0), 0) AS queued FROM turn_slots`);
		const capacity = c.vars.live ? c.vars.live.slots : facts.report?.slots;
		facts.turns = {
			running: counts.running,
			queued: counts.waiting,
			max: c.vars.live?.slots?.max ?? c.vars.live?.maxTurns ?? null,
		};
		if (capacity) facts.slots = { ...capacity, busy: counts.busy, queued: counts.queued };
	}
	const conflict = facts?.warnings.find(w => w.kind === "key");
	if (conflict) {
		// An earlier alarm rereads the last refusal. One alarm also covers repeated attempts and actor sleeps.
		const alarms = await c.schedule.list();
		if (!alarms.some(alarm => alarm.action === "expireKeyWarning" && alarm.runAt > Date.now())) {
			await c.schedule.at(conflict.at + KEY_WARNING_MS, "expireKeyWarning");
		}
	}
	await user(c).internalMachineChanged(c.key[1], facts);
}
// Keep the socket when the account index is unavailable. A retry reads current facts
// under the same ordering as hello and disconnect; a delayed retry cannot undo either.
async function tell(c: Ctx, row: Row | undefined, delay = 1000): Promise<void> {
	if (!row) return;
	try {
		await publish(c, row);
		c.vars.retryOnFrame = false;
	} catch (error) {
		machineError("publish machine change", error);
		try {
			const alarms = await c.schedule.list();
			if (!alarms.some(a => a.action === "retryPublish" && a.runAt > Date.now()))
				await c.schedule.at(Date.now() + delay, "retryPublish", Math.min(60_000, delay * 2));
			c.vars.retryOnFrame = false;
		} catch (error) {
			// The scheduler can be down with the index. The next heartbeat or wake retries.
			c.vars.retryOnFrame = true;
			machineError("schedule machine publish", error);
		}
	}
}

function answerLoginRemovals(c: Ctx, answer: ClaudeLoginRemoval) {
	for (const resolve of c.vars.loginRemovals) resolve(answer);
	c.vars.loginRemovals.clear();
}

async function disconnected(c: Ctx, ws: Socket) {
	if (c.vars.live?.ws !== ws) return;
	c.vars.live = null;
	answerLoginRemovals(c, "offline");
	const [row] = await c.db.execute<Row>("UPDATE machine SET seen = ? WHERE removed_at IS NULL RETURNING *", Date.now());
	await tell(c, row);
}

async function revoke(c: Ctx, removeSandboxes: boolean, idle: boolean): Promise<void> {
	await ordered(c, async () => {
		const [row] = await c.db.execute<Row>(
			`UPDATE machine SET removed_at = ?, remove_sandboxes = ?
			WHERE removed_at IS NULL AND (? = 0 OR COALESCE(seen, created) <= ?) RETURNING *`,
			Date.now(),
			Number(removeSandboxes),
			Number(idle),
			Date.now() - MACHINE_EXPIRY_MS,
		);
		if (!row) {
			// A previous removal may have committed just before its index notification failed.
			if (!idle) {
				const tombstone = await record(c);
				if (tombstone?.removed_at != null) await publish(c, tombstone);
			}
			return;
		}
		revokeMachineLeases(c.key[0], c.key[1]);
		const live = c.vars.live;
		c.vars.live = null;
		answerLoginRemovals(c, "offline");
		if (live) reject(live.ws, refuse("removed", { removeSandboxes }));
		await publish(c, row);
		// A turn paused while the machine was away cannot resume on it now: its session ends it.
		wakePaused(c);
	});
}

/** Wakes the sessions whose turn is paused while this machine was away (`internalPausedSession`): it is back, or removed. */
function wakePaused(c: Ctx): void {
	void c.db.execute<{ session: string }>("SELECT session FROM paused_sessions").then(
		rows => {
			for (const { session } of rows)
				void sessionActor(c, c.key[0], session)
					.internalMachineBack()
					.catch(error => machineError("wake a paused session", error));
		},
		error => machineError("read the paused sessions", error),
	);
}

async function storeHost(db: RawAccess, sample: string | null) {
	const [changed] = await db.execute<Row>(
		"UPDATE machine SET host = ? WHERE removed_at IS NULL AND host IS NOT ? RETURNING *",
		sample,
		sample,
	);
	return changed;
}

export async function saveReport(db: RawAccess, frame: Report, staged: Map<CatalogId, CatalogFrame>, offset: number) {
	const { host, ...rest } = frame;
	const report = compactReport(rest, (id, options) => staged.set(id, { kind: "catalog", id, options }));
	report.sandboxes = report.sandboxes.map(s => ({ ...s, usedAt: Math.max(0, s.usedAt - offset) }));
	const metadata = JSON.stringify(report);
	const sample = host ? JSON.stringify(host) : null;
	return db.transaction(async tx => {
		const stored = await tx.execute<{ id: CatalogId; digest: string }>("SELECT id, digest FROM catalogs");
		for (const entry of report.harnesses ?? []) {
			if (!entry.optionsDigest || stored.some(row => row.id === entry.id && row.digest === entry.optionsDigest))
				continue;
			const options = staged.get(entry.id)?.options;
			if (!options || optionsDigest(options) !== entry.optionsDigest) throw new Error("Missing harness catalog");
			await tx.execute(
				"INSERT OR REPLACE INTO catalogs VALUES (?, ?, ?)",
				entry.id,
				entry.optionsDigest,
				JSON.stringify(options),
			);
		}
		for (const row of stored)
			if (!report.harnesses?.some(h => h.id === row.id && h.optionsDigest))
				await tx.execute("DELETE FROM catalogs WHERE id = ?", row.id);
		const [inventory] = await tx.execute<Row>(
			"UPDATE machine SET name = COALESCE(?, name), report = ?, host = ? WHERE removed_at IS NULL AND report IS NOT ? RETURNING *",
			report.name ?? null,
			metadata,
			sample,
			metadata,
		);
		if (inventory) return inventory;
		return storeHost(tx, sample);
	});
}

export async function machineTables(db: RawAccess) {
	await db.execute(`CREATE TABLE IF NOT EXISTS machine (id INTEGER PRIMARY KEY, name TEXT NOT NULL, version TEXT NOT NULL,
		public_key TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER, removed_at INTEGER, remove_sandboxes INTEGER NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0, duplicate INTEGER, report TEXT)`);
	await db.execute(
		"CREATE TABLE IF NOT EXISTS catalogs (id TEXT PRIMARY KEY, digest TEXT NOT NULL, options TEXT NOT NULL)",
	);
	const columns = await db.execute<{ name: string }>("PRAGMA table_info(machine)");
	if (!columns.some(column => column.name === "protocol"))
		await db.execute("ALTER TABLE machine ADD COLUMN protocol INTEGER NOT NULL DEFAULT 0");
	if (!columns.some(column => column.name === "host")) {
		await db.execute("ALTER TABLE machine ADD COLUMN host TEXT");
	}
	// A report stored by an older runner (with inline catalogs or host figures) is dropped, not converted:
	// converting it opened a transaction inside the migration's own and hung until the start timeout.
	// The runner sends a full report again as soon as it connects.
	await db.execute(
		`UPDATE machine SET report = NULL WHERE removed_at IS NULL AND (report LIKE '%"options":%' OR json_type(report, '$.host') IS NOT NULL)`,
	);
	await db.execute(
		"CREATE TABLE IF NOT EXISTS connection_budget (id INTEGER PRIMARY KEY, minute INTEGER NOT NULL, used INTEGER NOT NULL)",
	);
	await db.execute(
		"CREATE TABLE IF NOT EXISTS turn_slots (session TEXT NOT NULL, turn INTEGER NOT NULL, running INTEGER NOT NULL, PRIMARY KEY (session, turn))",
	);
	// The sessions whose turn is paused while the machine is away: woken when its runner is back.
	await db.execute("CREATE TABLE IF NOT EXISTS paused_sessions (session TEXT PRIMARY KEY, at INTEGER NOT NULL)");
	const slotColumns = await db.execute<{ name: string }>("PRAGMA table_info(turn_slots)");
	if (!slotColumns.some(col => col.name === "size"))
		await db.execute("ALTER TABLE turn_slots ADD COLUMN size INTEGER NOT NULL DEFAULT 1");
	await db.execute("CREATE TABLE IF NOT EXISTS pending (sandbox TEXT PRIMARY KEY)");
	// The deleted sessions whose copy of their agent session the runner is still to remove (`internalRemoveBackup`).
	await db.execute("CREATE TABLE IF NOT EXISTS pending_backups (session TEXT PRIMARY KEY)");
}

export const machine = actor({
	db: db({ onMigrate: machineTables }),
	createVars: (): Vars => ({
		retryOnFrame: false,
		nextSlotCheck: 0,
		live: null,
		work: Promise.resolve(),
		greeting: null,
		loginRemovals: new Set(),
	}),
	onCreate: async (c, input?: Input) => {
		if (
			!input ||
			c.key.length !== 2 ||
			!MACHINE_ID.test(c.key[1]!) ||
			!grantIsValid(input.grant, c.key, "machine") ||
			Date.now() >= input.expires
		) {
			c.destroy();
			return;
		}
		const now = Date.now();
		await c.schedule.at(now + MACHINE_EXPIRY_MS, "expire");
		await c.db.execute(
			"INSERT INTO machine (id, name, version, public_key, created) VALUES (1, ?, ?, ?, ?)",
			input.details.name,
			input.details.runnerVersion,
			input.publicKey,
			now,
		);
		// Only the account's still-valid reservation can make this key usable.
		if (!(await user(c).internalMachineCreated(c.key[1]))) {
			await c.db.execute("DELETE FROM machine");
			c.destroy();
		}
	},
	onWake: async c => {
		const row = await record(c);
		if (row && (row.seen !== null || row.removed_at !== null)) {
			await tell(c, row);
		}
	},
	onSleep: async c => {
		await ordered(c, async () => {
			c.vars.greeting?.close(1001, "Machine actor sleeping");
			c.vars.live?.ws.close(1001, "Machine actor sleeping");
		});
		await c.vars.work;
	},
	onBeforeConnect: (c, params) => {
		assertOrigin(c);
		if (!controlPath(c.request)) requireServiceFor({ key: c.key, conn: { params } }, "call");
	},
	onWebSocket: (c, raw) => {
		if (!controlPath(c.request)) {
			raw.close(1008, "Unknown path");
			return;
		}
		const [uid, id] = c.key;
		const nonce = randomBytes(32).toString("base64url");
		const identity = config.machines?.identity;
		const context = { uid: uid!, machineId: id!, challenge: nonce };
		let auth: FrameAuth | undefined;
		let hello = false;
		let closed = false;
		const queue = new ControlQueue();
		const staged = new Map<CatalogId, CatalogFrame>();
		// The raw socket need not deliver a close event when the actor initiates the close.
		const gone = () => {
			if (closed) return;
			closed = true;
			clearTimeout(deadline);
			clearInterval(heartbeat);
			if (c.vars.greeting === ws) c.vars.greeting = null;
			if (c.vars.live?.ws === ws)
				return ordered(c, () => disconnected(c, ws)).catch(error => machineError("machine disconnect", error));
		};
		const ws: Socket = {
			send(frame) {
				if (!closed && raw.readyState === raw.OPEN) {
					try {
						raw.send(auth ? auth.seal(frame) : JSON.stringify(frame));
						return true;
					} catch (error) {
						machineError("send control frame", error);
					}
				}
				ws.close(1011, "Control socket failed");
				return false;
			},
			close(code, reason) {
				if (closed) return;
				void gone();
				if (raw.readyState === raw.OPEN) raw.close(code, reason);
			},
		};
		// 1001, not 1008: the runner reads 1008 as a refusal, ends its sessions' conversations and waits ten minutes,
		// and a hello held up on a stalled link (or a socket replaced before its hello) is no refusal.
		let deadline = setTimeout(() => ws.close(1001, "No hello"), HELLO_WAIT_MS);
		const heartbeat = setInterval(() => {
			if (c.vars.live?.ws === ws) ws.send({ kind: "heartbeat" });
		}, CONTROL_HEARTBEAT_MS);
		c.vars.greeting?.close(1001, "Replaced before its hello");
		c.vars.greeting = ws;
		const fail = (error: unknown) => {
			machineError("machine control socket", error);
			ws.close(1011, "Control socket failed");
		};
		raw.addEventListener("close", gone);
		raw.addEventListener("message", ({ data }) => {
			if (closed) return;
			const bytes = typeof data === "string" ? Buffer.byteLength(data) : Infinity;
			if (!queue.reserve(bytes)) {
				if (auth) {
					console.warn("frame_auth_failed size");
					ws.close(1008, "frame_auth_failed");
				} else reject(ws, refuse("bad-frame"));
				return;
			}
			let frame;
			try {
				if (identity && hello && !auth) throw new FrameAuthError("handshake");
				frame = parseRunnerFrame(auth ? auth.open(data, MAX_REPORT_BYTES) : data, c.vars.live?.ws === ws);
				if (auth && (!frame || frame.kind === "hello")) throw new FrameAuthError("schema");
			} catch (error) {
				console.warn(authFailure(error));
				ws.close(1008, "frame_auth_failed");
				return;
			}
			if (!frame || (!hello && frame.kind !== "hello") || (hello && frame.kind === "hello")) {
				reject(ws, refuse("bad-frame"));
				return;
			}
			if (!hello) {
				hello = true;
				if (c.vars.greeting === ws) c.vars.greeting = null;
				clearTimeout(deadline);
				deadline = setTimeout(() => ws.close(1001, "Runner timed out"), CONTROL_DEAD_MS);
			} else {
				deadline.refresh();
			}
			const now = Date.now();
			return ordered(c, async () => {
				if (closed) return;
				if (frame.kind === "hello") {
					const r = await record(c);
					const statement = frame.protocol === 2 ? machineStatement(context, frame) : controlProof(uid!, id!, nonce);
					if (!r || !signed(r.public_key, statement, frame.signature)) {
						reject(ws, refuse("unknown"));
						return;
					}
					const base = {
						kind: "welcome" as const,
						idleSuspendMs: config.idleSuspendMs,
						...welcomeCapabilities(
							frame.runnerVersion,
							(process.env.WLP_GITHUB_URL ?? "").trim() || "https://github.com",
							config.storeLimits.caps,
						),
					};
					const greeting = (refusal?: Refusal) =>
						identity && frame.protocol === 2
							? platformWelcome(context, frame, { ...base, refusal }, identity)
							: undefined;
					const decline = (refusal: Refusal) => {
						const reply = greeting(refusal);
						if (!reply) return reject(ws, refusal);
						ws.send(reply.welcome);
						ws.close(1008, refusal.reason);
					};
					if (r.removed_at !== null && (!identity || frame.protocol === 2)) {
						decline(refuse("removed", { removeSandboxes: !!r.remove_sandboxes }));
						return;
					}
					const foreign = (frame.protocol === 2) !== !!identity;
					if (foreign || !versionAtLeast(frame.runnerVersion, MIN_RUNNER_VERSION)) {
						const [changed] = await c.db.execute<Row>(
							"UPDATE machine SET version = ?, protocol = ? WHERE removed_at IS NULL RETURNING *",
							frame.runnerVersion,
							frame.protocol ?? 1,
						);
						if (foreign && !identity)
							decline({
								kind: "refused",
								reason: "signing-disabled",
								message: "This platform has signed runner connections disabled.",
							});
						else decline(refuse("outdated", foreign ? {} : frame));
						await tell(c, changed);
						return;
					}
					const old = c.vars.live;
					if (secondHello(old, frame, now) === "refuse") {
						const [changed] = await c.db.execute<Row>(
							"UPDATE machine SET duplicate = ? WHERE removed_at IS NULL RETURNING *",
							now,
						);
						decline(refuse("key-in-use"));
						await tell(c, changed);
						return;
					}
					const accepted = greeting();
					const [changed] = await c.db.execute<Row>(
						"UPDATE machine SET seen = ?, version = ?, offset = ?, protocol = ?, report = json_patch(report, ?) WHERE removed_at IS NULL RETURNING *",
						now,
						frame.runnerVersion,
						frame.time - now,
						frame.protocol ?? 1,
						JSON.stringify({ slots: frame.slots ?? null }),
					);
					if (!changed || closed) return;
					c.vars.live = {
						ws,
						slots: frame.slots,
						maxTurns: frame.maxTurns,
						offset: frame.time - now,
						epoch: frame.epoch,
						heardAt: now,
						connected: now,
						savedAt: now,
					};
					old?.ws.close(1001, "Reconnected");
					if (!ws.send(accepted?.welcome ?? base)) return;
					auth = accepted?.auth;
					for (const { sandbox } of await c.db.execute<{ sandbox: string }>("SELECT sandbox FROM pending"))
						ws.send({ kind: "remove", sandbox });
					await tell(c, changed);
					// The runner is back: the turns paused while it was away resume.
					wakePaused(c);
				} else {
					const live = c.vars.live;
					if (live?.ws !== ws) return;
					live.heardAt = now;
					if (now - live.savedAt >= SEEN_INTERVAL) {
						await c.db.execute("UPDATE machine SET seen = ? WHERE removed_at IS NULL", now);
						live.savedAt = now;
					}
					if (frame.kind === "heartbeat" && c.vars.retryOnFrame) await tell(c, await record(c));
					if (frame.kind === "removed") await c.db.execute("DELETE FROM pending WHERE sandbox = ?", frame.sandbox);
					if (frame.kind === "backup-forgotten")
						await c.db.execute("DELETE FROM pending_backups WHERE session = ?", frame.sessionId);
					if (frame.kind === "claude-login-forgotten") answerLoginRemovals(c, frame.ok ? "removed" : "failed");
					if (frame.kind === "host") {
						const sample = frame.host ? JSON.stringify(frame.host) : null;
						const changed = await storeHost(c.db, sample);
						if (changed) await tell(c, changed);
					}
					if (frame.kind === "catalog") staged.set(frame.id, frame);
					if (frame.kind === "report") {
						const changed = await saveReport(c.db, { ...frame, slots: frame.slots ?? live.slots }, staged, live.offset);
						live.slots = frame.slots ?? live.slots;
						// The first report that says it keeps copies: the removals recorded meanwhile are its now.
						if (frame.sessionBackups === true && !live.backups) {
							live.backups = true;
							for (const { session } of await c.db.execute<{ session: string }>("SELECT session FROM pending_backups"))
								ws.send({ kind: "forget-backup", sessionId: session });
						}
						staged.clear();
						if (changed) await tell(c, changed);
					}
				}
			})
				.catch(fail)
				.finally(() => queue.release(bytes));
		});
		ws.send({ kind: "challenge", nonce });
	},
	actions: {
		internalTurnSlot: async (c, session: string, turn: number, size = 1): Promise<TurnSlot> => {
			requireServiceFor(c, "call");
			const slot = await ordered(c, () => requestSlot(c, session, turn, size));
			if (slot.state === "waiting" && Date.now() >= c.vars.nextSlotCheck) {
				c.vars.nextSlotCheck = Date.now() + 60_000;
				void c.keepAwake(reapSlots(c).catch(error => machineError("check machine turn slots", error)));
			}
			return slot;
		},
		/** A session's turn paused while this machine was away (`on`), or no longer waits for it. */
		internalPausedSession: async (c, session: string, on: boolean): Promise<boolean> => {
			requireServiceFor(c, "call");
			if (on)
				await c.db.execute(
					"INSERT OR REPLACE INTO paused_sessions (session, at) VALUES (?, ?)",
					String(session),
					Date.now(),
				);
			else await c.db.execute("DELETE FROM paused_sessions WHERE session = ?", String(session));
			// A hello may already have read the list before the session registered.
			return c.vars.live !== null;
		},
		internalReleaseTurnSlot: async (c, session: string, turn: number): Promise<void> => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				const released = await c.db.execute(
					"DELETE FROM turn_slots WHERE session = ? AND turn = ? RETURNING turn",
					session,
					turn,
				);
				if (released.length) await tell(c, await record(c));
			});
		},
		internalCatalog: async (c, id: CatalogId, digest?: string): Promise<HarnessOptions | null> => {
			requireServiceFor(c, "call");
			// A later probe can confirm the same catalog without sending its models again.
			const [row] = await c.db.execute<{ options: string; checkedAt: number | null }>(
				`SELECT catalogs.options,
				json_extract(h.value, '$.optionsCheckedAt') AS checkedAt
				FROM machine, json_each(machine.report, '$.harnesses') h JOIN catalogs ON catalogs.id = json_extract(h.value, '$.id')
				WHERE removed_at IS NULL AND catalogs.id = ? AND catalogs.digest = COALESCE(?, json_extract(h.value, '$.optionsDigest'))`,
				id,
				digest ?? null,
			);
			if (!row) return null;
			const options: HarnessOptions = JSON.parse(row.options);
			if (row.checkedAt !== null) options.checkedAt = row.checkedAt;
			return options;
		},
		internalPaired: async (c): Promise<boolean> => {
			requireServiceFor(c, "call");
			return (await c.db.execute("SELECT 1 FROM machine WHERE removed_at IS NULL")).length > 0;
		},
		internalFacts: async (c): Promise<MachineFacts> => {
			requireServiceFor(c, "call");
			const r = await record(c);
			// No row: the actor was made without a valid reservation and is going away. To a session, and to a confirmation, that is a machine removed.
			if (!r) return { name: "", status: "removed", publicKey: "", report: null };
			const facts = update(c, r);
			if (isMachineIdName(r.name) && !c.vars.system)
				c.vars.system =
					(await user(c)
						.internalMachineSystem(c.key[1])
						.catch(() => null)) ?? undefined;
			return {
				name: machineLabel({ name: r.name, ...c.vars.system }),
				status: r.removed_at !== null ? "removed" : facts.status,
				publicKey: r.public_key,
				report: facts.report,
			};
		},
		internalConnection: async (
			c,
			proof: string,
			signature: string,
			limitByMachine = false,
		): Promise<"unknown" | "active" | { removeSandboxes: boolean } | { retryAfter: number }> => {
			requireServiceFor(c, "call");
			const r = await record(c);
			if (!r || !signed(r.public_key, proof, signature)) return "unknown";
			if (r.removed_at !== null) return { removeSandboxes: !!r.remove_sandboxes };
			if (limitByMachine) {
				const now = Date.now();
				const minute = Math.floor(now / MINUTE_MS);
				const admitted = await c.db.execute(
					`INSERT INTO connection_budget VALUES (1, ?, 1)
					ON CONFLICT(id) DO UPDATE SET minute = excluded.minute, used = CASE WHEN minute = excluded.minute THEN used + 1 ELSE 1 END
					WHERE minute != excluded.minute OR used < ? RETURNING id`,
					minute,
					config.httpLimits.runnerConnection,
				);
				if (!admitted.length) return { retryAfter: Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000) };
			}
			return "active";
		},
		internalAttach: async (c, input: { sessionId: string; ticket: string }): Promise<Attachment> => {
			requireServiceFor(c, "call");
			return ordered(c, async (): Promise<Attachment> => {
				const r = await record(c);
				if (!r) return { ok: false, reason: "unknown" };
				if (r.removed_at !== null) return { ok: false, reason: "removed" };
				const live = c.vars.live;
				// The session had the key from `internalFacts` before it made the ticket: the runner's hello can come before this answer.
				if (!live || !live.ws.send({ kind: "attach", sessionId: input.sessionId, ticket: input.ticket }))
					return { ok: false, reason: "offline" };
				return { ok: true };
			});
		},
		internalRemoveSandbox: async (
			c,
			{ sandboxId, sessionId }: { sandboxId: string | null; sessionId?: string },
		): Promise<void> => {
			requireServiceFor(c, "call");
			await ordered(c, async () => {
				const r = await record(c);
				if (!r || r.removed_at !== null) return;
				const ids = new Set<string>();
				if (sandboxId) ids.add(sandboxId);
				// Only a session deletion includes sessionId. Read its last inventory in order with incoming reports.
				if (sessionId && r.report) {
					const report: Report = JSON.parse(r.report);
					for (const box of report.sandboxes) if (box.sessionId === sessionId) ids.add(box.id);
				}
				if (!ids.size) return;
				await c.db.execute("INSERT OR IGNORE INTO pending SELECT value FROM json_each(?)", JSON.stringify([...ids]));
				for (const sandbox of ids) c.vars.live?.ws.send({ kind: "remove", sandbox });
			});
		},
		/**
		 * Records that a deleted session's copy of its agent session must go from the machine, and tells
		 * the runner now when it keeps copies, or when it next reports that it does. Never refused for a
		 * removed machine: its volume of copies goes with its sandboxes, or stays with the owner's.
		 */
		internalRemoveBackup: async (c, { sessionId }: { sessionId: string }): Promise<void> => {
			requireServiceFor(c, "call");
			if (typeof sessionId !== "string" || !NAME.test(sessionId))
				throw new UserError("A session id is needed.", { code: "bad_request" });
			await ordered(c, async () => {
				const r = await record(c);
				if (!r || r.removed_at !== null) return;
				await c.db.execute("INSERT OR IGNORE INTO pending_backups (session) VALUES (?)", sessionId);
				if (c.vars.live?.backups) c.vars.live.ws.send({ kind: "forget-backup", sessionId });
			});
		},
		/**
		 * Asks the runner to remove the Claude Code login kept on the machine ("Switch back to your plan" on
		 * Connections) and waits for its answer. Not queued behind `ordered`: the answer arrives through it.
		 */
		internalForgetClaudeLogin: async (c): Promise<ClaudeLoginRemoval> => {
			requireServiceFor(c, "call");
			const live = c.vars.live;
			if (!live) return "offline";
			return new Promise<ClaudeLoginRemoval>(resolve => {
				const timer = setTimeout(() => done("failed"), LOGIN_REMOVAL_MS);
				const done = (answer: ClaudeLoginRemoval) => {
					clearTimeout(timer);
					c.vars.loginRemovals.delete(done);
					resolve(answer);
				};
				c.vars.loginRemovals.add(done);
				if (!live.ws.send({ kind: "forget-claude-login" })) done("offline");
			});
		},
		internalRevoke: async (c, removeSandboxes: boolean) => {
			requireServiceFor(c, "call");
			await revoke(c, removeSandboxes, false);
		},
		retryPublish: async (c, delay: number) => {
			if (!c.scheduledFire)
				throw new UserError("Only the machine's schedule can retry a publish.", { code: "forbidden" });
			await ordered(c, async () => tell(c, await record(c), delay));
		},
		expireKeyWarning: async c => {
			if (!c.scheduledFire)
				throw new UserError("Only the machine's schedule can expire its key warning.", { code: "forbidden" });
			await ordered(c, async () => {
				const row = await record(c);
				if (row && row.removed_at === null) await publish(c, row);
			});
		},
		expire: async c => {
			if (!c.scheduledFire)
				throw new UserError("Only the expiry schedule can remove an idle machine.", { code: "forbidden" });
			await revoke(c, false, true);
			const r = await record(c);
			if (r.removed_at === null) await c.schedule.at((r.seen ?? r.created) + MACHINE_EXPIRY_MS, "expire");
		},
	},
});
