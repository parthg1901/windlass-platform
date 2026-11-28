// Opening the session's sandbox, reading its workspace, and tracking its state.
import { type SpareRecipe, type SpareSetup, spareProfile, spareRecipe } from "../../runner/spare-recipe.js";
import { refHead } from "../../github/feature.js";
import { canReuseSnapshot, snapshotGeneration, DEFERRED_INPUTS, digest } from "../../sandbox/snapshot-key.js";
import { randomBytes } from "node:crypto";
import { describeError } from "../../auth.js";
import { snapshotsFor, config } from "../../config.js";
import type { WorkspaceFile, NetworkBlockedItem, BlockedNetwork } from "../../contract.js";
import { emptyNetwork, limitNetwork, unionNetwork, watchNetwork } from "../../blocked-network.js";
import { blockedHostNote, hostsForTurn } from "../../repository-network.js";
import { githubApp } from "../../github/app.js";
import { WORKSPACE_GIT_START, checkoutPreparedReviewBase, cloneCommand } from "../../github/git.js";
import { isHostName } from "../../sandbox/hosted-network.js";
import { fetchBase, putOnWork, sessionRepository } from "../../github/publish.js";
import { type SandboxLayer, type SandboxHandle, SandboxConnectionLost, observeSandbox } from "../../sandbox/api.js";
import { stopLeftoverSetup } from "../../sandbox/setup.js";
import { setupProjectOf } from "../../setup-command.js";
import { hostedLimitsApply, sandboxRefusal } from "../../usage.js";
import { type SealedSecrets, userActor, sessionSandboxInput } from "../internal.js";
import { capabilitiesOf } from "../../sandbox/harness.js";
import { privateSessionData } from "../../sandbox/session-data.js";
import { queueMessage, flushOutbox } from "../session-inbox.js";
import { note, persist, append, serial, writeItems, insertItems } from "./timeline.js";
import type { Ctx, SessionMeta, HeldSecrets, WorkspaceCopy } from "./state.js";
import type { MachineCopy } from "../internal.js";
import { layerOf, runnerLink } from "./runner.js";
import { publish } from "./summary.js";
import { restoreBackup, dropWorkspace, savedWorkspace } from "./workspace.js";
import {
	type SnapshotPlan,
	setupRevision,
	childSetupSeed,
	usesScreenshotImage,
	cloneConnected,
	runSetup,
	putWorkspaceOnWork,
} from "./setup.js";
import { githubConnection, connectOptions, sandboxChanged, TurnProblem, tail } from "./common.js";
import { noteSandbox, applySandboxClamp, holdSandbox, carriedOver, markUsed, useOf } from "./meter.js";
import { sessionRedactor } from "./secrets.js";

const CLONE_TIMEOUT_MS = 3 * 60 * 1000;
const GIT_TIMEOUT_MS = 30 * 1000;
const MAX_DIFF_CHARS = 400_000;

// Status must avoid the workspace index lock while the agent runs Git.
export const STATUS_COMMAND = `${WORKSPACE_GIT_START}\ngit --no-optional-locks status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`;

// Include untracked files through a private temporary index.
export const DIFF_COMMAND = [
	WORKSPACE_GIT_START,
	"git add -N . >/dev/null",
	// Without a commit there is nothing to compare with but the empty tree.
	"if git rev-parse -q --verify HEAD >/dev/null; then base=HEAD; else base=4b825dc642cb6eb9a060e54bf8d69288fbee4904; fi",
	`git --no-pager diff --no-color --no-ext-diff --no-textconv --ignore-submodules=all "$base" | head -c ${MAX_DIFF_CHARS}`,
].join("\n");

function parseStatus(output: string): WorkspaceFile[] {
	const files: WorkspaceFile[] = [];
	const fields = output.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (field.length < 4) continue;
		const status = field.slice(0, 2);
		files.push({ path: field.slice(3), status });
		// A rename or copy is followed by the path it came from.
		if (status.includes("R") || status.includes("C")) index += 1;
	}
	return files;
}

async function snapshotPlan(
	c: Ctx,
	meta: SessionMeta,
	secrets: HeldSecrets | null,
	layer: SandboxLayer,
): Promise<SnapshotPlan | null> {
	if (
		!secrets?.snapshotSetup ||
		!layer.sandboxes.hasSnapshot ||
		!canReuseSnapshot(snapshotsFor(meta.place), meta.harness, secrets.opened.length)
	)
		return null;
	const repo = meta.repo,
		project = setupProjectOf(meta),
		app = githubApp();
	if (!project || !app || !repo) return null;
	try {
		const saved = secrets.snapshotSetup,
			command = saved.command;
		const revision =
			meta.origin?.role === "reviewer" ? meta.reviewBase : (meta.origin?.childBranch?.start ?? repo.branch);
		if (!revision) return null;
		const key = {
			repo: String(repo.id),
			attempt: randomBytes(16).toString("hex"),
			generation: snapshotGeneration(String(repo.id), saved.updatedAt, saved.connectedAt),
		};
		// A build always starts cold, and is the only kind of session that saves an image (environments.ts).
		if (meta.environmentBuild) {
			if (meta.pushedHead || meta.windlassSessionId) return null;
			return {
				key: { ...key, inputs: DEFERRED_INPUTS },
				commit: "",
				defaultBranch: repo.branch,
				writer: true,
				command,
				updatedAt: saved.updatedAt,
			};
		}
		// Only a validated environment's image is started from: one that is not ready and current at this place, or not
		// there at all, leaves the session to start cold, as it would with none.
		if (
			!secrets.environment?.usable ||
			!saved.previouslySaved ||
			!(await layer.sandboxes.hasSnapshot(meta.uid, key.repo))
		)
			return null;
		const connection = await githubConnection(c, meta);
		if (!connection || connection.connectedAt !== saved.connectedAt) return null;
		const { commit, dependencies, defaultBranch } = await setupRevision(app, connection, repo, revision);
		if (!dependencies) return null;
		return {
			writer: false,
			key: { ...key, inputs: digest([dependencies, saved.command]) },
			commit,
			defaultBranch,
			command,
			updatedAt: saved.updatedAt,
		};
	} catch {
		return null;
	} // A missing permission, truncated tree or unavailable API still allows a normal clone.
}

async function restorePrepared(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	plan: SnapshotPlan | null,
	validated?: SealedSecrets["environment"],
) {
	const source = sandbox.snapshot,
		repo = meta.repo,
		app = githubApp();
	if (
		!source ||
		!repo ||
		!app ||
		!plan ||
		source.attempt !== plan.key.attempt ||
		source.repo !== plan.key.repo ||
		source.inputs !== plan.key.inputs ||
		source.generation !== plan.key.generation
	)
		return false;
	const work = meta.origin?.role !== "reviewer" && meta.pushedHead ? meta.publishBranch : null;
	const connection = await githubConnection(c, meta);
	if (!connection || snapshotGeneration(String(repo.id), plan.updatedAt, connection.connectedAt) !== source.generation)
		return false;
	const fetchedWork = await fetchBase(app, connection, repo, sandbox, work);
	let head: string;
	if (meta.origin?.role === "reviewer") {
		const pinned = await checkoutPreparedReviewBase(sandbox, repo.branch, plan.commit);
		if (!pinned.ok) return false;
		head = pinned.marks.get("work") ?? "";
		if (head !== plan.commit) return false;
		repo.baseSha = plan.commit;
	} else if (meta.origin?.childBranch) {
		head = await putOnWork(sandbox, ".", meta.origin.childBranch.name, meta.origin.childBranch.start);
		repo.baseSha = head;
	} else head = await putOnWork(sandbox, ".", repo.branch);
	if (head !== plan.commit) {
		// The branch moved during startup. Decide using the immutable tree we actually checked out.
		const latest = await setupRevision(app, connection, repo, head);
		if (latest.commit !== head || digest([latest.dependencies, plan.command]) !== source.inputs) return false;
	}
	const saved = await userActor(c, meta.uid).internalSetupCommand(setupProjectOf(meta)!.key);
	if (saved.command !== plan.command || saved.updatedAt !== plan.updatedAt) return false;
	if (work && fetchedWork) meta.workDue = { branch: work, directory: "." };
	else if (work) {
		meta.pushedHead = null;
		note(
			c,
			turn,
			"warn",
			`${work} is no longer on the remote, so the workspace starts from ${repo.branch} again. Work that was only on that branch is not in it.`,
		);
	}
	c.vars.unpushed = null;
	meta.cloneDirectory = ".";
	meta.cloned = true;
	meta.setupDue = null;
	meta.snapshotCommit = source.commit;
	meta.environment = validated?.usable
		? { commit: validated.commit, validatedAt: validated.validatedAt, checks: validated.checks }
		: null;
	note(
		c,
		turn,
		"info",
		meta.environment
			? `Started from a validated environment: setup and ${meta.environment.checks === 1 ? "the saved check" : `${meta.environment.checks} saved checks`} passed at ${meta.environment.commit.slice(0, 12)} on ${new Date(meta.environment.validatedAt).toISOString()}.`
			: `Started from a prepared sandbox. Setup ran at ${source.commit} on ${new Date(source.created).toISOString()}.`,
	);
	await persist(c);
	return true;
}

/** How many blocked hosts the timeline names for one sandbox. */
const MAX_HOSTS_NOTED = 40;

// Report each blocked host once per restricted sandbox.
async function noteBlockedHosts(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	layer: SandboxLayer,
	observed: (hosts: string[]) => void,
): Promise<void> {
	if (meta.place.kind !== "hosted" || !sandbox.blockedHosts || layer.sandboxes.egress?.() !== "restricted") return;
	const allowed = new Set(meta.networkHosts ?? []);
	const noted = new Set(meta.hostsNoted ?? []);
	if (noted.size >= MAX_HOSTS_NOTED) return;
	let found: string[];
	try {
		// What was named already is left out before the stub's log is cut to its first names, so it cannot hide a later one.
		found = await sandbox.blockedHosts([...allowed, ...noted]);
	} catch (error) {
		c.log.warn({ msg: "could not read which hosts the sandbox could not reach", error: describeError(error) });
		return;
	}
	const named = found
		.filter(
			host =>
				!allowed.has(host) &&
				!noted.has(host) &&
				(!c.vars.turn?.secrets || c.vars.turn.secrets.redactor.text(host) === host),
		)
		.slice(0, MAX_HOSTS_NOTED - noted.size);
	if (named.length === 0) return;
	observed(named);
	meta.hostsNoted = [...noted, ...named];
	const project = setupProjectOf(meta);
	for (const host of named)
		append(c, {
			turn,
			kind: "platform",
			level: "warn",
			text: blockedHostNote(host, project?.label ?? null),
			code: "host_blocked",
			host,
			...(project ? { repository: true } : {}),
		});
	if (meta.hostsNoted.length >= MAX_HOSTS_NOTED)
		note(
			c,
			turn,
			"info",
			`This sandbox's timeline names at most ${MAX_HOSTS_NOTED} hosts its commands could not reach, and has named them; it names no more until the agent has a new sandbox.`,
		);
	console.log(`[wlp] network.blocked session=${meta.sessionId} hosts=${named.length}`);
	if (project) {
		const filed = await userActor(c, meta.uid)
			.internalNetworkRequests({ sessionId: meta.sessionId, hosts: named })
			.catch((error: unknown) => {
				c.log.warn({ msg: "could not file the blocked hosts as requests", error: describeError(error) });
				return null;
			});
		// The requests already waiting are kept over new ones: what a command looks up cannot push out a host a person may want.
		const left: string[] = filed?.full ?? [];
		if (left.length > 0)
			note(
				c,
				turn,
				"info",
				`${left.length === 1 ? "1 host was" : `${left.length} hosts were`} not filed as a request for ${project.label}: it has as many waiting as it keeps. Allow or dismiss some in its network list to make room.`,
			);
	}
	void persist(c);
}

/** Only the first version consumes a sequence number. A replacement is durable before its live event.
 * The session totals and the item's outbox receipt commit alongside the same timeline version. */
function blockedRecorder(c: Ctx, meta: SessionMeta, turn: number) {
	const before = meta.blocked?.network ?? emptyNetwork();
	let row: NetworkBlockedItem | undefined;
	let saved = JSON.stringify(emptyNetwork());
	return async (snapshot: BlockedNetwork) => {
		const network = limitNetwork(before, snapshot);
		const signature = JSON.stringify(network);
		if (signature === saved) return;
		const blocked = { revision: (meta.blocked?.revision ?? 0) + 1, network: unionNetwork(before, network) };
		if (!row) {
			meta.blocked = blocked;
			row = append(c, { kind: "network.blocked", revision: blocked.revision, turn, ...network }) as NetworkBlockedItem;
			await serial(c, () => writeItems(c));
		} else {
			const item = { ...row, ...network, revision: blocked.revision };
			await serial(c, async () => {
				await writeItems(c);
				await c.db.transaction(
					async tx => {
						await insertItems(tx, [item]);
						await tx.execute("UPDATE meta SET data = ? WHERE id = 1", JSON.stringify({ ...meta, blocked }));
						if (meta.origin) await queueMessage(tx, { to: "network", itemId: meta.origin.itemId, ...blocked });
					},
					{ name: "session.network" },
				);
				meta.blocked = blocked;
			});
			c.broadcast("networkBlocked", item);
			if (meta.origin) await flushOutbox(c, meta.uid);
		}
		saved = signature;
	};
}

export async function observeNetwork(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	sandbox: SandboxHandle,
	layer: SandboxLayer,
) {
	const proxy = sandbox.blockedNetwork?.bind(sandbox);
	const dns = meta.place.kind === "hosted" && sandbox.blockedHosts && layer.sandboxes.egress?.() === "restricted";
	if (!proxy && !dns) return;
	const save = blockedRecorder(c, meta, turn);
	const lookups = emptyNetwork();
	let broker: string | undefined;
	let previousBrokers = emptyNetwork(),
		current = emptyNetwork();
	return watchNetwork(
		async () => {
			if (proxy) {
				const retained = meta.blocked?.network.hosts.map(({ host, port }) => ({ host, port })) ?? [];
				const snapshot = await proxy(turn, retained);
				if (broker && broker !== snapshot.broker) previousBrokers = unionNetwork(previousBrokers, current);
				broker = snapshot.broker;
				const redactor = c.vars.turn?.secrets?.redactor;
				const name =
					c.vars.runner?.known?.name || meta.machineName || (meta.place.kind === "machine" ? meta.place.machineId : "");
				current = {
					overflow: snapshot.overflow,
					hosts: snapshot.hosts.map(entry => {
						const host = entry.host && redactor && redactor.text(entry.host) !== entry.host ? null : entry.host;
						return {
							...entry,
							host,
							machineNames: [redactor?.text(name) ?? name],
							allow: entry.reason === "machine_policy" && host && isHostName(host) ? "machine" : "never",
						};
					}),
				};
				await save(unionNetwork(previousBrokers, current));
			} else {
				const before = lookups.hosts.length;
				await noteBlockedHosts(c, meta, turn, sandbox, layer, names => {
					const at = Date.now();
					for (const host of names)
						lookups.hosts.push({
							host,
							port: null,
							reason: "unlisted",
							allow: setupProjectOf(meta) ? "repository" : "deployment",
							count: 1,
							firstAt: at,
							lastAt: at,
						});
				});
				await save(lookups);
				return lookups.hosts.length > before;
			}
		},
		error => c.log.warn({ msg: "could not read blocked network requests", error: describeError(error) }),
		() => c.vars.stopping || c.vars.destroying,
	);
}

// An empty pool still needs an authorized seed. Repeated cold creates for the same
// branch can reuse its head briefly. A claim always observes the head afresh.
let lastSpareHead: { key: string; commit: string; until: number } | undefined;
export async function spareHead(key: string, seedOnly: boolean, read: () => Promise<string>) {
	if (seedOnly && lastSpareHead?.key === key && Date.now() < lastSpareHead.until) return lastSpareHead.commit;
	const commit = await read();
	lastSpareHead = { key, commit, until: Date.now() + 30_000 };
	return commit;
}

export function readySetupItems(turn: number, recipe: NonNullable<SpareRecipe["connected"]>, setup: SpareSetup) {
	const item = {
		turn,
		kind: "setup" as const,
		id: `su_${randomBytes(6).toString("hex")}`,
		command: recipe.command,
		limitMs: recipe.timeoutMs,
		output: "",
		truncated: false,
	};
	return [
		{ ...item, state: "started" as const, at: setup.startedAt, exitCode: null, durationMs: null },
		{
			...item,
			state: "succeeded" as const,
			at: setup.startedAt + setup.durationMs,
			exitCode: 0,
			durationMs: setup.durationMs,
		},
	];
}

/** Resolve the current permission and immutable base outside the machine. A mirror alone
 * cannot establish either. Only the ordinary base checkout can run setup in advance. */
export async function readyRecipe(
	c: Ctx,
	meta: SessionMeta,
	secrets: HeldSecrets | null,
	plan: SnapshotPlan | null,
	purpose: "claim" | "seed" | "resume" = "claim",
	getApp = githubApp,
): Promise<SpareRecipe | undefined> {
	if (
		!meta.repoUrl ||
		!spareProfile(meta.profile, meta.harness) ||
		meta.environmentBuild ||
		(purpose !== "resume" && (meta.windlassSessionId || meta.pushedHead)) ||
		meta.origin?.role === "reviewer" ||
		meta.origin?.owns !== undefined ||
		plan?.writer
	)
		return;
	if (!meta.repo) return spareRecipe({ url: meta.repoUrl }) ? { url: meta.repoUrl } : undefined;
	const repo = meta.repo,
		project = setupProjectOf(meta),
		app = getApp();
	if (
		!project ||
		!app ||
		!secrets ||
		secrets.opened.length ||
		secrets.unopened.length ||
		(await childSetupSeed(c, meta))
	)
		return;
	const connection = await githubConnection(c, meta);
	if (!connection) return;
	const saved = await userActor(c, meta.uid).internalSetupCommand(project.key);
	const { installation, repository } = await sessionRepository(app, connection, repo, "read");
	const key = digest([meta.uid, connection.connectedAt, installation.id, repo.id, repo.branch]);
	const commit =
		plan?.commit ||
		(await spareHead(key, purpose === "seed", () =>
			app.withToken(
				installation.id,
				{ repositoryId: repo.id, permissions: { metadata: "read", contents: "read" } },
				token => refHead(app, token, repository.owner, repository.name, repo.branch),
				{ revokeAfter: true },
			),
		));
	const recipe = {
		url: app.cloneUrl(repository.owner, repository.name),
		connected: {
			repo: String(repo.id),
			branch: repo.branch,
			commit,
			command: saved.command?.trim() ?? "",
			timeoutMs: config.setupTimeoutMs,
			generation: snapshotGeneration(String(repo.id), saved.updatedAt, connection.connectedAt),
		},
	};
	return spareRecipe(recipe) ? recipe : undefined;
}

// Restart seeds describe a base checkout. A repository with a usable environment will
// supply its prepared image selection on the next create.
export function canSeedOnResume(meta: Pick<SessionMeta, "place" | "repoUrl">, environment: HeldSecrets["environment"]) {
	return meta.place.kind === "machine" && !!meta.repoUrl && !environment?.usable;
}

/** Connects to the session's sandbox for a turn, creating it (and cloning the repository) when needed. */
export async function openSandbox(
	c: Ctx,
	meta: SessionMeta,
	turn: number,
	signal: AbortSignal,
	layer: SandboxLayer,
	secrets: HeldSecrets | null,
	allowSnapshot = true,
): Promise<SandboxHandle> {
	let plan: SnapshotPlan | null = null;
	let recipe: SpareRecipe | undefined;
	let ready = false;
	// A setup cut off with the server is being stopped: let it finish first, or it could stop this turn's processes.
	await c.vars.setupReap;
	// Preserve hosts allowed after this turn read the repository list.
	if (secrets?.network !== undefined) {
		const hosts = hostsForTurn(secrets.network, secrets.networkAt ?? 0, c.vars.hostsAllowed);
		meta.networkHosts = meta.place.kind === "hosted" && hosts.length > 0 ? hosts : undefined;
	}
	const connecting = Date.now();
	let handle = meta.sandboxId
		? await layer.sandboxes.connect(meta.sandboxId, {
				...connectOptions(meta),
				...(allowSnapshot &&
					canSeedOnResume(meta, secrets?.environment) && {
						spareSeed: () => readyRecipe(c, meta, secrets, null, "resume"),
						screenshots: sessionSandboxInput(meta, secrets?.screenshots).screenshots,
					}),
			})
		: undefined;
	if (handle) c.vars.startClock?.sandbox(Date.now() - connecting, false);
	sandboxChanged(c);
	// Accept positive ownership evidence only. Older runners may omit it.
	if (handle?.ownData) meta.ownDataSandbox = handle.id;
	if (handle) {
		if (meta.sandbox === "paused") note(c, turn, "info", "Resuming sandbox");
		if (handle.notice) note(c, turn, "warn", handle.notice);
		noteSandbox(c, meta, "running");
	} else {
		if (meta.sandboxId) {
			note(
				c,
				turn,
				"warn",
				"The sandbox this agent was working in no longer exists, so the files it had there are gone. Starting again in a new sandbox.",
			);
			meta.sandbox = "none";
			meta.cloned = false;
		}
		const making = Date.now();
		// What is known of a setup run, and of the Windlass that was asked, was the old sandbox's.
		meta.accountSecrets = null;
		meta.snapshotCommit = null;
		meta.environment = null;
		meta.setupDue = null;
		meta.setupRunning = null;
		meta.setupUnfinished = null;
		meta.workDue = null;
		meta.setupOnBase = null;
		meta.hostsNoted = undefined;
		await dropWorkspace(c);
		// The session holds its turn here, so it is making no other sandbox: one the provider has for it is one it never heard of.
		await sweepSandboxes(c, meta, layer);
		if (hostedLimitsApply(meta.place)) {
			// Claim the place at creation if the reservation did not already claim it.
			const place = await userActor(c, meta.uid).internalClaimPlace(meta.sessionId, meta.hostedSize);
			if (!place.ok)
				throw new TurnProblem("numbers" in place ? sandboxRefusal(place.numbers) : "The agent was deleted.");
			if (applySandboxClamp(meta, place.clampedSize, text => note(c, turn, "info", text))) {
				await persist(c);
				// The previous sandbox disappeared, or the plan changed since the reserve. Trade its hold at the new weight.
				await holdSandbox(c, meta, false);
			}
		}
		// In the user's words: where, and Strict or Open. The provider and its layers are in the panel's "How it's isolated".
		const isolation = layer.sandboxes.profile(meta.profile).name;
		note(
			c,
			turn,
			"info",
			meta.place.kind === "hosted"
				? `Starting a hosted sandbox (${isolation})`
				: `Starting on ${meta.machineName ? `‘${meta.machineName}’` : "your machine"} (${isolation})`,
		);
		// Hold the layer before awaiting the create. Concurrent deletion can invalidate actor state.
		const vars = c.vars;
		plan = allowSnapshot ? await snapshotPlan(c, meta, secrets, layer) : null;
		const fromSnapshot = plan ? { ...plan.key, writer: plan.writer } : undefined;
		const id = await layer.sandboxes.create({
			...sessionSandboxInput(meta, secrets?.screenshots),
			fromSnapshot,
			...(allowSnapshot &&
				meta.place.kind === "machine" &&
				meta.repoUrl && {
					spareRecipe: async (ready: number) => {
						const candidate = await readyRecipe(c, meta, secrets, plan, ready === 0 ? "seed" : "claim");
						// A spare may finish after an empty report. Revalidate before accepting that claim.
						if (ready > 0) recipe = candidate;
						return candidate;
					},
				}),
			mirrorRepo: !meta.readiness && meta.repo?.provider === "github" ? String(meta.repo.id) : undefined,
			...connectOptions(meta),
		});
		console.log(`[wlp] sandbox.created id=${id} session=${meta.sessionId}`);
		if (vars.destroying) {
			await layer.sandboxes.destroy(id);
			throw new TurnProblem("The agent was deleted.");
		}
		meta.sandboxId = id;
		sandboxChanged(c);
		meta.sandbox = "running";
		publish(c);
		await persist(c);
		if (c.vars.destroying) {
			// The session was deleted while its sandbox was being made.
			await layer.sandboxes.destroy(id);
			throw new TurnProblem("The agent was deleted.");
		}
		handle = await layer.sandboxes.connect(id, connectOptions(meta));
		if (!handle) throw new SandboxConnectionLost("The new sandbox disappeared right after it was created.");
		c.vars.startClock?.sandbox(Date.now() - making, true, handle.runnerStart);
		// The repository's environment at this place: its image went missing (stale, build again), or it has none yet (build one).
		if (
			!meta.environmentBuild &&
			meta.repo &&
			secrets?.snapshotSetup &&
			canReuseSnapshot(snapshotsFor(meta.place), meta.harness, secrets.opened.length)
		) {
			const kind = secrets.environment?.usable ? (plan && !handle.snapshot ? "missed" : null) : "cold";
			if (kind)
				void c.keepAwake(
					userActor(c, meta.uid)
						.internalEnvironmentNudge(meta.sessionId, kind, usesScreenshotImage(meta, handle, secrets.screenshots))
						.catch(() => undefined),
				);
		}
		// Recorded for this sandbox from what it has, not from what the provider would make now.
		meta.ownDataSandbox = handle.ownData ? id : null;
		// Continued on a machine: the earlier session's copy becomes this session's here, where the runner hears it from this session.
		if (meta.pendingCopy) {
			const pending = meta.pendingCopy;
			meta.pendingCopy = undefined;
			if (await copyOnMachine(meta, pending, layer, id)) {
				meta.windlassSessionId = pending.windlassSessionId;
				// The copy's turn counts no turn of this session.
				meta.backup = { windlassSessionId: pending.windlassSessionId, ...pending.backup, turn: 0 };
			}
		}
		// The earlier session's copied agent session is only this one's once restored here: on shared agent data it is still the earlier session's own.
		if (meta.copiedSession && !(await privateSessionData(meta, layer.sandboxes, id))) {
			meta.windlassSessionId = null;
			meta.backup = null;
		}
		meta.copiedSession = undefined;
		if (meta.windlassSessionId && (await privateSessionData(meta, layer.sandboxes, id))) {
			// Restore memory before starting the agent in its replacement sandbox.
			if (!capabilitiesOf(meta.harness).backups || !(await restoreBackup(c, meta, turn, handle, layer))) {
				meta.windlassSessionId = null;
				meta.backup = null;
				note(
					c,
					turn,
					"info",
					meta.handoff
						? "The earlier session's memory could not be restored here, so the agent starts with an account of that session instead."
						: "The agent's memory of the conversation went with the old sandbox, so it starts this turn without it.",
				);
			}
		}
		// Where Windlass's session outlives the sandbox, the agent remembers files this new workspace does not have, and is told.
		if (meta.windlassSessionId && !(await privateSessionData(meta, layer.sandboxes, id))) meta.freshWorkspace = true;
	}

	if (!meta.cloned && handle.readyKey) {
		// A replayed create (or connect after an actor restart) must agree with today's recipe too.
		recipe ??= allowSnapshot ? await readyRecipe(c, meta, secrets, plan).catch(() => undefined) : undefined;
		if (
			!recipe ||
			digest([recipe]) !== handle.readyKey ||
			(!handle.snapshot && recipe.connected?.command && !handle.readySetup)
		) {
			await layer.sandboxes.destroy(handle.id);
			meta.sandboxId = null;
			await persist(c);
			return openSandbox(c, meta, turn, signal, layer, secrets, false);
		}
		if (!handle.snapshot) {
			if (meta.repo && recipe.connected) meta.repo.baseSha = recipe.connected.commit;
			if (recipe.connected?.command && handle.readySetup) {
				for (const item of readySetupItems(turn, recipe.connected, handle.readySetup)) append(c, item, item.at);
			}
			meta.cloneDirectory = ".";
			meta.setupDue = null;
			meta.cloned = true;
			await persist(c);
		}
		ready = true;
	}

	if (!meta.cloned && handle.snapshot) {
		// A restarted actor can find the container before it recorded the successful refresh.
		if (!(await restorePrepared(c, meta, turn, handle, plan, secrets?.environment).catch(() => false))) {
			await layer.sandboxes.destroy(handle.id);
			meta.sandboxId = null;
			meta.cloned = false;
			await persist(c);
			if (!allowSnapshot) throw new TurnProblem("Could not replace the prepared sandbox.");
			return openSandbox(c, meta, turn, signal, layer, secrets, false);
		}
	}

	if (ready) note(c, turn, "info", "Started from a ready sandbox.");
	const active = c.vars.turn;
	if (active) active.finishNetwork = await observeNetwork(c, meta, turn, handle, layer);

	// A requested review opens its own read-only tree, without running repository setup.
	if (meta.readiness || active?.item?.row.checkout?.requested) return handle;

	// A repository of the user's GitHub connection is cloned with a token of the platform's own (below).
	if (meta.repo && !meta.cloned && !signal.aborted && !(await cloneConnected(c, meta, turn, handle, signal)))
		return handle;
	// What a setup run that was cut off with its server left running is not the agent's to find at work.
	if (meta.setupUnfinished?.state === "interrupted" && !signal.aborted) await stopLeftoverSetup(handle);
	// The repository's setup command, once in this sandbox, before Windlass is started in it, on the base; only then the session's branch.
	if (meta.repo && meta.cloned && typeof meta.setupDue === "string" && !signal.aborted) {
		await runSetup(c, meta, turn, handle, signal, secrets, plan, layer);
	}
	if (meta.origin?.role !== "reviewer" && meta.repo && meta.workDue && !signal.aborted)
		await putWorkspaceOnWork(c, meta, turn, handle);
	if (meta.repoUrl && !meta.cloned && !signal.aborted) {
		note(c, turn, "info", `Cloning ${meta.repoUrl}`);
		const cloned = await handle.run(cloneCommand(meta.repoUrl), { timeoutMs: CLONE_TIMEOUT_MS, signal });
		if (cloned.aborted || signal.aborted) return handle;
		if (cloned.timedOut)
			throw new TurnProblem(
				`Cloning ${meta.repoUrl} took longer than ${CLONE_TIMEOUT_MS / 60_000} minutes and was stopped.`,
			);
		if (cloned.exitCode !== 0) {
			const why = tail(cloned.stderr || cloned.stdout, 4, 500);
			throw new TurnProblem(`Cloning ${meta.repoUrl} failed${why ? `: ${why}` : ` (exit code ${cloned.exitCode}).`}`);
		}
		meta.cloned = true;
		void persist(c);
	}
	return handle;
}

/** Null when git could not say. */
export async function readFiles(c: Ctx, sandbox: SandboxHandle): Promise<WorkspaceFile[] | null> {
	const status = await sandbox.run(STATUS_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (status.exitCode !== 0) {
		c.log.warn({
			msg: "git status failed in the sandbox",
			exitCode: status.exitCode,
			stderr: tail(status.stderr, 3, 300),
		});
		return null;
	}
	return parseStatus(status.stdout);
}

// A setup command can write a secret to a file. Redact the diff before caching it.
export async function readDiff(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<string | null> {
	const redactor = await sessionRedactor(c, meta);
	const diff = await sandbox.run(DIFF_COMMAND, { timeoutMs: GIT_TIMEOUT_MS });
	if (diff.exitCode !== 0 && diff.stdout === "") {
		c.log.warn({
			msg: "git diff failed in the sandbox",
			exitCode: diff.exitCode,
			stderr: redactor.text(tail(diff.stderr, 3, 300)),
		});
		return null;
	}
	// Cut after the values are out: a cut through one would leave its beginning.
	const text = redactor.text(diff.stdout);
	return text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) : text;
}

/** Reads the workspace from a running sandbox and keeps the copy. Null, and no copy kept, when it could not be read. Never throws. */
export async function copyWorkspace(c: Ctx, meta: SessionMeta, sandbox: SandboxHandle): Promise<WorkspaceCopy | null> {
	try {
		const files = await readFiles(c, sandbox);
		const diff = files === null ? null : await readDiff(c, meta, sandbox);
		if (files === null || diff === null) return null;
		const copy: WorkspaceCopy = { files, diff };
		await c.db.execute(
			"INSERT OR REPLACE INTO workspace (id, files, diff) VALUES (1, ?, ?)",
			JSON.stringify(files),
			diff,
		);
		c.vars.workspace = copy;
		return copy;
	} catch (error) {
		c.log.warn({ msg: "could not copy the workspace's changes", error: describeError(error) });
		return null;
	}
}

// Reuse the saved workspace between turns. A live read may need to resume the sandbox.
export async function workspaceView(
	c: Ctx,
	meta: SessionMeta,
): Promise<WorkspaceCopy | { sandbox: SandboxHandle } | null> {
	if (c.vars.idling) await c.vars.idling.catch(() => undefined);
	if (!meta.sandboxId) return null;
	if (!c.vars.turn) {
		const saved = await savedWorkspace(c);
		if (saved) return saved;
	}
	const { sandboxes } = await layerOf(c, meta);
	// Starting a paused sandbox to read it uses its user's sandbox time, as a turn does: refused when none is left.
	// So does a stretch carried over a wake: it is settled where it can have ended, and the read takes a hold of its own.
	if (!c.vars.turn && (!meta.meter || carriedOver(c, meta))) await holdSandbox(c, meta, true);
	const sandbox = await sandboxes.connect(meta.sandboxId, connectOptions(meta));
	sandboxChanged(c);
	if (!sandbox) {
		noteSandbox(c, meta, "none");
		return null;
	}
	noteSandbox(c, meta, "running");
	if (c.vars.turn) return { sandbox };
	markUsed(c, meta);
	return (await copyWorkspace(c, meta, sandbox)) ?? { sandbox };
}

// Sweep only this session's orphaned sandboxes. A create may finish after its actor disappears.
export async function sweepSandboxes(c: Ctx, meta: SessionMeta, layer: SandboxLayer): Promise<void> {
	if (!hostedLimitsApply(meta.place)) return;
	try {
		for (const listed of await layer.sandboxes.list(meta.uid)) {
			if (listed.sessionId !== meta.sessionId || listed.id === meta.sandboxId) continue;
			await layer.sandboxes.destroy(listed.id);
			console.log(`[wlp] sandbox.swept id=${listed.id} session=${meta.sessionId}`);
		}
	} catch (error) {
		c.log.warn({
			msg: "could not remove the sandboxes the session did not know of",
			session: meta.sessionId,
			error: describeError(error),
		});
	}
}

/** Machine removals must be durable before a delete succeeds, even if the runner is offline. */
export async function destroySessionSandboxes(c: Ctx, meta: SessionMeta): Promise<void> {
	if (meta.place.kind === "machine") {
		await runnerLink(c, meta.place.machineId).removeSessionSandboxes(meta.sandboxId);
		sandboxChanged(c);
		meta.sandboxId = null;
		meta.sandbox = "none";
		return;
	}
	if (meta.sandboxId) {
		try {
			const { sandboxes } = await layerOf(c, meta);
			await sandboxes.destroy(meta.sandboxId);
			sandboxChanged(c);
			console.log(`[wlp] sandbox.destroyed id=${meta.sandboxId} session=${meta.sessionId}`);
			meta.sandboxId = null;
			meta.sandbox = "none";
		} catch (error) {
			c.log.error({ msg: "could not destroy the sandbox", sandbox: meta.sandboxId, error: describeError(error) });
		}
	}
	await layerOf(c, meta).then(
		layer => sweepSandboxes(c, meta, layer),
		() => undefined,
	);
}

/** Asks the sandbox layer what state the sandbox is really in. */
export async function refreshSandbox(c: Ctx, meta: SessionMeta, required = false): Promise<number | undefined> {
	const id = meta.sandboxId;
	if (!id) return;
	const gen = c.vars.sandboxGen;
	// The stretch the answer is about: a read or a push that takes a fresh hold meanwhile has its own, which this answer does not close.
	const use = useOf(meta);
	try {
		const { sandboxes } = await layerOf(c, meta);
		const observed = await observeSandbox(sandboxes, id);
		// A prompt that woke the actor may have resumed the sandbox while this was asked: "paused" is then the sandbox it was, not the one that runs.
		if (c.vars.sandboxGen === gen) {
			noteSandbox(c, meta, observed.state, use, observed.pausedAt);
			if (useOf(meta) === use) {
				c.vars.carried = null;
				if (sandboxes.observe && observed.state === "running") return Date.now();
			}
		}
	} catch (error) {
		c.log.warn({ msg: "could not read the sandbox's state", error: describeError(error) });
		if (required) throw error;
	}
}

/**
 * Copies the earlier session's agent session to this session's name in the machine's volume of copies,
 * for the restore that follows. Only where the runner keeps copies, for an agent whose sessions are
 * copied, and where this sandbox's agent data is its own: on shared agent data the new session would
 * resume the very session the earlier one goes on writing. False when no copy was made: the agent then
 * starts with the account of the earlier session.
 */
export async function copyOnMachine(
	meta: SessionMeta,
	pending: MachineCopy,
	layer: SandboxLayer,
	sandbox: string,
): Promise<boolean> {
	const backups = layer.backups;
	if (meta.place.kind !== "machine" || !backups || !capabilitiesOf(meta.harness).backups) return false;
	try {
		if (!((await backups.available?.()) ?? true)) return false;
		if (!(await privateSessionData(meta, layer.sandboxes, sandbox))) return false;
		if (await backups.copy({ uid: meta.uid, sessionId: pending.from }, { uid: meta.uid, sessionId: meta.sessionId })) {
			console.log(`[wlp] backup.copied session=${pending.from} to=${meta.sessionId} machine`);
			return true;
		}
		console.warn(`[wlp] backup.copy_missing session=${pending.from} to=${meta.sessionId}: the machine has no copy`);
	} catch (error) {
		console.warn(`[wlp] backup.copy_failed session=${pending.from} to=${meta.sessionId}: ${describeError(error)}`);
	}
	return false;
}
