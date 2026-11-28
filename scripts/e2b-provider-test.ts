/**
 * Tests of the E2B provider that need no E2B account and send nothing to E2B. Run with:
 *
 *   cd server && npx tsx ../scripts/e2b-provider-test.ts                  the provider on the in-memory client
 *   cd server && npx tsx ../scripts/e2b-provider-test.ts --docker
 *                                                                        the same, and "a real turn" besides, and the
 *                                                                        network modes through a stand-in of E2B's filter
 *                                                                        (--network-only: only those)
 *
 * The first part runs the provider's logic (server/src/sandbox/e2b/sandboxes.ts) on `FakeE2b`, which
 * does to sandboxes what E2B's documentation says E2B does: the cap, the timeout that is pushed out
 * while a turn runs and stops a sandbox whose server is gone, pause and resume, destroy, the metadata,
 * the line about what a sandbox cost, and the cleanup.
 *
 * "A real turn" (--docker) gives the same in-memory client sandboxes whose commands run in real
 * containers of the sandbox image on this machine, each on a disk of its own as a microVM is. Then
 * everything between `E2bClient` and Windlass is real: the provider's quoting of commands, standard
 * input and its order, signals, the access token file, and a whole scripted turn through turn.ts. What
 * stays untried is only the adapter to E2B's SDK (e2b/sdk.ts) and E2B itself: scripts/e2b-check.ts.
 * The containers carry the label dev.windlass-platform=1 and are removed at the end.
 *
 * Exit code 0 when every check passed.
 */

import assert from "node:assert/strict";
import { HostedSandboxes } from "../server/src/sandbox/hosted.js";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TimelineItem, WindlassEvent } from "../server/src/contract.js";
import {
	type AccessTokens,
	type ChatgptLogins,
	type OutOfMemory,
	DeploymentFull,
	PLATFORM_RESTART,
	type RunTurnResult,
	SandboxUserError,
	type ScriptedModel,
	type TurnQuestion,
} from "../server/src/sandbox/api.js";
import { IMAGE, LABEL_ARG, docker } from "../server/src/sandbox/docker.js";
import { cleanupDeployment } from "../server/src/sandbox/e2b/cleanup.js";
import type { E2bClient, E2bCommand, E2bCommandOptions } from "../server/src/sandbox/e2b/client.js";
import { DEFAULT_SNAPSHOT_LIMITS, offeredSize } from "../server/src/sandbox/hosted-settings.js";
import {
	type E2bSettings,
	buildShape,
	refusesSize,
	readE2bKey,
	readE2bSettings,
	templateFor,
} from "../server/src/sandbox/e2b/config.js";
import { E2bSnapshots } from "../server/src/sandbox/e2b/snapshots.js";
import { outOfMemoryWords } from "../server/src/contract.js";
import { FakeE2b, type FakeMachine, ScriptedMachine } from "../server/src/sandbox/e2b/fake.js";
import { createE2bSandboxLayer } from "../server/src/sandbox/e2b/index.js";
import { describeUsage, estimatedCostUsd } from "../server/src/sandbox/e2b/pricing.js";
import {
	ACCOUNT_LIMIT,
	E2bSandboxHandle,
	e2bSandboxes,
	META,
	RESTARTED_NOTICE,
	capReached,
	hardeningRefusal,
} from "../server/src/sandbox/e2b/sandboxes.js";
import { GUEST_HARDENING_SCRIPT, HARDENING_MARK } from "../server/src/sandbox/e2b/guest-hardening.js";
import { RESTARTED_COMMAND, restartShellResult, resumePrompt } from "../server/src/actors/turn-resume.js";
import { sessionSandboxInput } from "../server/src/actors/internal.js";
import { describeTemplate } from "../server/src/sandbox/e2b/template.js";
import { PROFILE_RUN_FLAGS } from "../server/src/sandbox/docker-flags.js";
import { OPEN_PROFILE_NOT_OFFERED, PROFILES, e2bProfile, profilesFor } from "../server/src/sandbox/profiles.js";
import { HOSTED_OFFLINE_REPOSITORY, hostedNetworkText } from "../server/src/sandbox/hosted-network.js";
import {
	type E2bNetworkConfig,
	readE2bNetwork,
	withHosts,
	guestDnsArgv,
	guestNetworkStep,
	networkConfig,
} from "../server/src/sandbox/e2b/network.js";
import { personalServerReach } from "../server/src/server-question.js";
import { choosePlacement } from "../server/src/factory/placement.js";
import {
	cloneWithToken,
	commitWork,
	discardHandover,
	fetchWithToken,
	outgoingPatch,
	pushWithToken,
} from "../server/src/github/git.js";
import { INIT_WORKSPACE } from "../server/src/github/git-flags.js";
import { execFileSync } from "node:child_process";
import {
	BWRAP_PROBE,
	DATA_DIR,
	GIT_USER_ENV,
	isTurnSandbox,
	randomId,
	shellQuote,
} from "../server/src/sandbox/provider.js";
import {
	openModelKeyRelay,
	rotatePlanToken,
	tokenFilePath,
	turnTokenFilePath,
	writePlanPlaceholder,
} from "../server/src/sandbox/token-file.js";
import { GUEST_NODE, planRelaySources } from "../server/src/sandbox/plan-relay.js";
import { hostedKeyEnv, redactKeyLease, windlassPlanEnv } from "../server/src/sandbox/hosted-keys.js";
import { sleep } from "./check-wait.js";
import { Report } from "./check-report.js";
import { matchesSection } from "./check-sections.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withDocker = process.argv.includes("--docker");
/** With --docker: only the network checks through the stand-in of E2B's filter, not the real turns. */
const networkOnly = process.argv.includes("--network-only");
const run = randomId(3);
const tally = new Report();
const { expect } = tally;

async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (!matchesSection(name)) return;
	console.log(`\n== ${name}`);
	try {
		await body();
	} catch (error) {
		tally.failures += 1;
		console.log(
			`FAIL  ${name}: unexpected error  ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	}
}
async function userError(body: () => Promise<unknown>): Promise<string | null> {
	try {
		await body();
		return null;
	} catch (error) {
		return error instanceof SandboxUserError
			? error.message
			: `not a SandboxUserError: ${error instanceof Error ? error.message : String(error)}`;
	}
}

async function expectRejects(body: () => Promise<unknown>, pattern: RegExp, name: string): Promise<void> {
	let message = "";
	try {
		await body();
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(name, pattern.test(message), message || "it did not reject");
}

const MINUTE = 60_000;
const SETTINGS: E2bSettings = {
	...readE2bSettings({}),
	deployment: "test",
	maxRunning: 2,
};

/** A machine that answers as the sandbox image would to what the provider itself runs. */
function imageLike(
	extra: (
		command: string,
		stdin: () => string,
	) => { exitCode?: number; stdout?: string; stderr?: string } | undefined = () => undefined,
): ScriptedMachine {
	return new ScriptedMachine(
		(command, stdin) =>
			extra(command, stdin) ??
			(/ wlp-network [a-z]+ /.test(command)
				? { stdout: `network ${/ wlp-network ([a-z]+) /.exec(command)?.[1]}\n` }
				: command.includes("windlass --version")
					? { stdout: "Windlass 0.4.0+test (linux-x64)\n" }
					: command.includes("wlp-run list") && command.includes("wc -l")
						? { stdout: "0\n" }
						: undefined),
	);
}

/** A provider on a fake E2B, with a clock of its own and its log lines kept. */
function world(
	settings: Partial<E2bSettings> = {},
	fakeOptions: { accountMaxRunning?: number; machine?: (id: string) => FakeMachine } = {},
) {
	const clock = { now: Date.parse("2026-11-15T12:00:00Z") };
	const lines: string[] = [];
	const machines = new Map<string, ScriptedMachine>();
	const fake = new FakeE2b({
		now: () => clock.now,
		accountMaxRunning: fakeOptions.accountMaxRunning,
		machine:
			fakeOptions.machine ??
			(id => {
				const machine = imageLike();
				machines.set(id, machine);
				return machine;
			}),
	});
	const versions: string[] = [];
	const sandboxes = e2bSandboxes(
		fake,
		{ ...SETTINGS, ...settings },
		{
			log: line => lines.push(line),
			now: () => clock.now,
			sleep: async () => {},
			onVersion: version => versions.push(version),
		},
	);
	const make = (uid = "u1", sessionId = "s1") => sandboxes.create({ uid, sessionId, profile: "e2b" });
	return { clock, lines, fake, sandboxes, machines, versions, make };
}

const callsOf = (fake: FakeE2b, name: string) => fake.calls.filter(call => call.startsWith(`${name} `));
/** The provider's hardening script (guest-hardening.ts), as a machine saw it. */
const hardening = (entry: { command: string }) => entry.command.includes(HARDENING_MARK);
/** The root commands a machine saw other than the hardening script. */
const rootsBesidesHardening = (commands: Array<{ command: string; options: E2bCommandOptions }>) =>
	commands.filter(entry => entry.options.root && !hardening(entry));

// ---------------------------------------------------------------------------------------------
// The provider on the in-memory client
// ---------------------------------------------------------------------------------------------

await section("profiles", async () => {
	const onE2b = profilesFor("e2b");
	const e2b = onE2b.find(profile => profile.id === "e2b");
	expect(
		"a server on E2B offers the E2B profile and no other",
		onE2b
			.filter(profile => profile.available)
			.map(profile => profile.id)
			.join() === "e2b" && onE2b.length === PROFILES.length,
	);
	const notOffered = onE2b.find(profile => profile.id === "e2b-open");
	expect(
		"without WLP_E2B_OPEN_PROFILE=1 the microVM-only profile is listed, with why it cannot be chosen",
		notOffered?.available === false && notOffered.unavailableReason === OPEN_PROFILE_NOT_OFFERED,
	);
	const both = profilesFor("e2b", { windlassSandbox: true, openProfile: true });
	const open = both.find(profile => profile.id === "e2b-open");
	// With the model relay a command reads the turn's token file, which holds only a placeholder: the access token is not readable.
	const relayedOpen = profilesFor("e2b", { windlassSandbox: false, openProfile: true }, true).find(
		profile => profile.id === "e2b-open",
	);
	expect(
		"with the model relay, e2b-open's commands read the token file but not the access token",
		relayedOpen?.modelRelay === true &&
			relayedOpen.commandsCanReadAccessToken &&
			relayedOpen.accessTokenReadable === false &&
			open?.accessTokenReadable === undefined,
	);
	expect(
		"with it, both E2B profiles are offered, the one with Windlass's sandbox first (the picker's default)",
		both
			.filter(profile => profile.available)
			.map(profile => profile.id)
			.join() === "e2b,e2b-open",
	);
	expect(
		"the microVM-only profile says what it gives up: network, the access token, no questions",
		open?.name === "Open" &&
			open.approval === "full" &&
			open.commandNetwork &&
			open.commandsCanReadAccessToken &&
			open.layers.length === 1 &&
			open.details !== undefined &&
			/any host on the network/.test(open.details) &&
			/access token/.test(open.details) &&
			/without asking/.test(open.details) &&
			/never in the microVM/.test(open.details),
		open?.details,
	);
	expect(
		"what it promises holds with or without bubblewrap: Windlass asks or sandboxes, and commands are not said to be without network or token",
		e2b?.name === "Strict" &&
			e2b.approval === "auto" &&
			e2b.commandNetwork &&
			e2b.commandsCanReadAccessToken &&
			e2b.details !== undefined &&
			/asks before running a command it cannot sandbox/.test(e2b.details) &&
			/never in the microVM/.test(e2b.details),
		e2b?.details,
	);
	expect(
		"the Docker profiles say why they cannot be chosen there",
		onE2b
			.filter(profile => profile.id.startsWith("docker-"))
			.every(profile => !profile.available && /E2B/.test(profile.unavailableReason ?? "")),
	);
	const onDocker = profilesFor("docker");
	expect(
		"a server on Docker lists E2B as unavailable, with what would offer it",
		JSON.stringify(onDocker) === JSON.stringify(PROFILES) &&
			onDocker.find(profile => profile.id === "e2b")?.available === false &&
			/WLP_SANDBOX=e2b/.test(onDocker.find(profile => profile.id === "e2b")?.unavailableReason ?? ""),
	);
	expect(
		"and the microVM-only profile too",
		onDocker.find(profile => profile.id === "e2b-open")?.available === false &&
			/WLP_E2B_OPEN_PROFILE=1/.test(onDocker.find(profile => profile.id === "e2b-open")?.unavailableReason ?? ""),
	);
	const strong = e2bProfile({ windlassSandbox: true });
	expect(
		"with WLP_E2B_WINDLASS_SANDBOX=1 the stronger promise is made",
		strong.available &&
			strong.approval === "auto" &&
			!strong.commandNetwork &&
			!strong.commandsCanReadAccessToken &&
			strong.layers.length === 2,
	);
	const { sandboxes } = world();
	expect(
		"the provider answers profiles() and profile() from the same list",
		JSON.stringify(sandboxes.profiles()) === JSON.stringify(onE2b) &&
			sandboxes.profile("e2b").available &&
			sandboxes.sessionsLiveInSandbox === true,
	);
});

await section("create", async () => {
	const { fake, sandboxes, machines, versions, lines, make, clock } = world();
	const id = await make("user-1", "session-1");
	const made = fake.sandboxes.get(id);
	expect(
		"a sandbox is tagged with the deployment, the user, the session and the profile",
		made !== undefined &&
			made.metadata[META.deployment] === "test" &&
			made.metadata[META.uid] === "user-1" &&
			made.metadata[META.session] === "session-1" &&
			made.metadata[META.profile] === "e2b",
		JSON.stringify(made?.metadata),
	);
	expect(
		"it is made from the template, with the short timeout, and pauses when that runs out",
		made?.template === "windlass-platform-sandbox" &&
			made.endAt === clock.now + 2 * MINUTE &&
			made.onTimeout === "pause",
		`${(made?.endAt ?? 0) - clock.now} ms, ${made?.onTimeout}`,
	);
	expect(
		"every command gets the environment the Dockerfile's ENV gives a container",
		made?.envs.LANG === "C.UTF-8" && made.envs.NO_COLOR === "1",
	);
	const commands = machines.get(id)?.commands ?? [];
	const init = commands.find(entry => entry.command.includes("git init"));
	expect(
		"the workspace gets an empty git repository, under wlp-run, in /workspace",
		init !== undefined &&
			/^wlp-run exec r[a-f0-9]{12} sh -c /.test(init.command) &&
			init.command.endsWith(shellQuote(INIT_WORKSPACE + " && windlass --version")) &&
			init.options.cwd === "/workspace",
		init?.command,
	);
	expect("the Windlass in the template is noted from the first sandbox", versions.join() === "0.4.0+test");
	expect(
		"a line says it was created, and how many run",
		lines.some(
			line =>
				line.startsWith(`[wlp] e2b.sandbox.created id=${id} uid=user-1 session=session-1`) &&
				line.includes("1 of at most 2 running"),
		),
		lines.join(" | "),
	);
	expect("the handle is one the turn code takes", isTurnSandbox((await sandboxes.connect(id))!));
	const refused = await userError(() =>
		sandboxes.create({ uid: "user-1", sessionId: "s", profile: "docker-hardened" }),
	);
	expect(
		"create() refuses a profile that is not offered here, in a sentence fit to show",
		refused !== null && /not available/.test(refused) && /E2B/.test(refused),
		refused ?? "did not throw",
	);
	let invalid = "";
	await sandboxes
		.create({ uid: "../x", sessionId: "s", profile: "e2b" })
		.catch((error: unknown) => (invalid = error instanceof Error ? error.message : String(error)));
	expect(
		"create() refuses an invalid user id before it asks E2B anything",
		/invalid user id/.test(invalid) && callsOf(fake, "create").length === 1,
	);

	for (const role of ["builder", "reviewer", undefined] as const) {
		for (const enabled of [false, true]) {
			const origin = role && { kind: "item" as const, itemId: "item", role };
			const args = sessionSandboxInput({ uid: "u", sessionId: "selection", profile: "e2b", origin }, enabled);
			const box = await sandboxes.create(args);
			const expected = enabled && role ? SETTINGS.templates.small.shotsTemplate : SETTINGS.templates.small.template;
			expect(
				`E2B creates ${role ?? "personal"} on ${expected} with repository screenshots ${enabled}`,
				fake.sandboxes.get(box)?.template === expected,
			);
			await sandboxes.destroy(box);
		}
	}

	const broken = world(
		{},
		{
			machine: () =>
				imageLike(command =>
					command.includes("git init") ? { exitCode: 128, stderr: "fatal: not a git repository" } : undefined,
				),
		},
	);
	let why = "";
	await broken.make().catch((error: unknown) => (why = error instanceof Error ? error.message : String(error)));
	expect(
		"a sandbox whose workspace cannot be set up is removed again",
		/could not set up the workspace: fatal: not a git repository/.test(why) &&
			broken.fake.sandboxes.size === 0 &&
			callsOf(broken.fake, "kill").length === 1,
		why,
	);
});

await section("hosted agents", async () => {
	const { sandboxes, fake } = world({ openProfile: true, modelRelayOrigin: "https://relay.example.com" });
	for (const harness of ["claude", "codex", "opencode"] as const) {
		const id = await sandboxes.create({ uid: "u1", sessionId: "test", profile: "e2b-open", harness });
		const box = fake.sandboxes.get(id)!;
		expect(`${harness} uses its own E2B template`, box.template === SETTINGS.templates.small.template + "-" + harness);
		expect(
			"no credentials on provision",
			Object.keys(box.envs).every(key => ["LANG", "NO_COLOR"].includes(key)),
		);
		await sandboxes.destroy(id);
	}
});

await section("a profile per session", async () => {
	const notOffered = world({ windlassSandbox: true });
	const refused = await userError(() =>
		notOffered.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b-open" }),
	);
	expect(
		"a server without WLP_E2B_OPEN_PROFILE=1 refuses to make a microVM-only sandbox, and asks E2B nothing",
		refused !== null && refused.includes(OPEN_PROFILE_NOT_OFFERED) && callsOf(notOffered.fake, "create").length === 0,
		refused ?? "did not throw",
	);

	const w = world({ windlassSandbox: true, openProfile: true });
	const strict = await w.make("u1", "s-strict");
	const open = await w.sandboxes.create({ uid: "u1", sessionId: "s-open", profile: "e2b-open" });
	const probed = (id: string) =>
		(w.machines.get(id)?.commands ?? []).some(entry => entry.command === BWRAP_PROBE.map(shellQuote).join(" "));
	expect(
		"each sandbox carries the profile it was made with",
		w.fake.sandboxes.get(strict)?.metadata[META.profile] === "e2b" &&
			w.fake.sandboxes.get(open)?.metadata[META.profile] === "e2b-open",
	);
	expect(
		"only the profile that promises Windlass's sandbox holds a new sandbox to bubblewrap's probe",
		probed(strict) && !probed(open),
	);
	// Another server, which made neither: what it knows of a sandbox's profile is what E2B keeps.
	const other = e2bSandboxes(
		w.fake,
		{ ...SETTINGS, windlassSandbox: true, openProfile: true },
		{ log: () => undefined, now: () => w.clock.now, sleep: async () => {} },
	);
	const a = (await other.connect(strict)) as E2bSandboxHandle;
	const b = (await other.connect(open)) as E2bSandboxHandle;
	expect(
		"Windlass runs with --approval auto in the one and full in the other, on any server",
		a.profile === "e2b" && a.approval === "auto" && b.profile === "e2b-open" && b.approval === "full",
		`${a.profile} ${a.approval}, ${b.profile} ${b.approval}`,
	);
	const withdrawn = e2bSandboxes(
		w.fake,
		{ ...SETTINGS, windlassSandbox: true },
		{ log: () => undefined, now: () => w.clock.now, sleep: async () => {} },
	);
	const kept = (await withdrawn.connect(open)) as E2bSandboxHandle;
	expect(
		"a session made with it keeps it after the operator stops offering it to new ones",
		kept.profile === "e2b-open" && kept.approval === "full",
	);
	delete w.fake.sandboxes.get(strict)!.metadata[META.profile];
	await assert.rejects(other.connect(strict), /profile metadata/);
});

await section("the cap", async () => {
	const w = world({ maxRunning: 1 });
	const a = await w.make("u1", "s1");
	const capacityWait = (error: unknown) =>
		error instanceof DeploymentFull && error.limit === 1 && error.message === capReached(1);
	const before = callsOf(w.fake, "create").length;
	const refused = await w.make("u2", "s2").catch((error: unknown) => error);
	expect(
		"creating at the deployment cap throws the capacity wait with limit 1 and the user's sentence",
		capacityWait(refused) && callsOf(w.fake, "create").length === before && w.fake.sandboxes.size === 1,
	);
	expect(
		"the sentence is one for a user",
		/at most 2 sandboxes at the same time/.test(capReached(2)) &&
			/Try again in a few minutes/.test(capReached(2)) &&
			/at most 1 sandbox at the same time, and it is in use/.test(capReached(1)),
	);
	expect(
		"the count comes from E2B's list of the deployment's running sandboxes",
		w.fake.calls.some(call => call === `list {"${META.deployment}":"test"} running`),
	);
	expect(
		"a line says the cap was reached",
		w.lines.some(line => line.includes("e2b.cap_reached deployment=test: 1 of at most 1 sandboxes are running")),
	);

	await w.sandboxes.suspend(a);
	const c = await w.make("u3", "s3");
	expect(
		"a paused sandbox does not count: another may be created",
		w.fake.sandboxes.get(c)?.state === "running" && w.fake.sandboxes.get(a)?.state === "paused",
	);
	const resumed = await w.sandboxes.connect(a).catch((error: unknown) => error);
	expect(
		"resuming at the deployment cap throws the same capacity wait and keeps the sandbox paused",
		capacityWait(resumed) &&
			w.fake.sandboxes.get(a)?.state === "paused" &&
			callsOf(w.fake, "connect").filter(call => call.includes(a)).length === 1,
	);
	await w.sandboxes.destroy(c);
	expect(
		"once one is gone the paused one can be resumed",
		(await w.sandboxes.connect(a)) !== undefined && w.fake.sandboxes.get(a)?.state === "running",
	);

	// Sandboxes of other deployments on the same account, and sandboxes that are not the platform's at all, are not counted.
	const others = world({ maxRunning: 1 });
	await others.fake.plant({ [META.deployment]: "another" });
	await others.fake.plant({});
	const own = await others.make();
	expect(
		"only this deployment's sandboxes count",
		others.fake.sandboxes.get(own)?.state === "running" && others.fake.sandboxes.size === 3,
	);

	// Two servers look at the list at the same moment and both create: the second finds one too many and takes its own back.
	const race = world({ maxRunning: 1 });
	const racing: E2bClient = Object.assign(Object.create(race.fake) as E2bClient, {
		create: async (input: Parameters<E2bClient["create"]>[0]) => {
			const connection = await race.fake.create(input);
			await race.fake.plant({ [META.deployment]: "test", [META.uid]: "other-server" });
			return connection;
		},
	});
	const second = e2bSandboxes(
		racing,
		{ ...SETTINGS, maxRunning: 1 },
		{ log: line => race.lines.push(line), now: () => race.clock.now },
	);
	const lost = await userError(() => second.create({ uid: "u1", sessionId: "s1", profile: "e2b" }));
	const left = [...race.fake.sandboxes.values()];
	expect(
		"a sandbox that turns out to be one too many (another server made one at the same moment) is removed at once",
		lost === capReached(1) &&
			left.length === 1 &&
			left[0]?.metadata[META.uid] === "other-server" &&
			race.lines.some(line => line.includes("the newest") && line.includes("was removed again")),
		`${lost} | ${left.length} left`,
	);

	const account = world({ maxRunning: 5 }, { accountMaxRunning: 1 });
	await account.fake.plant({});
	const refusedByE2b = await userError(() => account.make());
	expect(
		"when E2B itself refuses (the account's own limit), the user reads that",
		refusedByE2b === ACCOUNT_LIMIT && /account limit/.test(ACCOUNT_LIMIT),
		refusedByE2b ?? "did not throw",
	);
});

await section("only this deployment's sandboxes", async () => {
	const w = world();
	const foreign = await w.fake.plant({ [META.deployment]: "another", [META.uid]: "u1" });
	const bare = await w.fake.plant({});
	w.fake.calls.length = 0;
	const states = [
		await w.sandboxes.state(foreign),
		await w.sandboxes.state(bare),
		await w.sandboxes.state("nosuchsandbox"),
		await w.sandboxes.state("../etc"),
	];
	expect(
		"a sandbox of another deployment, or of nobody, is none of ours",
		states.join() === "none,none,none,none" &&
			(await w.sandboxes.connect(foreign)) === undefined &&
			(await w.sandboxes.connect(bare)) === undefined,
	);
	await w.sandboxes.suspend(foreign);
	await w.sandboxes.destroy(foreign);
	await w.sandboxes.destroy(bare);
	expect(
		"it is never connected to, paused or killed",
		w.fake.sandboxes.size === 2 &&
			[...w.fake.sandboxes.values()].every(sandbox => sandbox.state === "running") &&
			!w.fake.calls.some(call => /^(connect|pause|kill|setTimeout) /.test(call)),
		w.fake.calls.join(" | "),
	);
	expect("an id that cannot be E2B's is not sent to E2B", !w.fake.calls.some(call => call.includes("../etc")));
});

await section("what the usage meter reads", async () => {
	const w = world({ maxRunning: 5 });
	const mine = await w.make("u1", "s1");
	const paused = await w.make("u1", "s2");
	await w.sandboxes.suspend(paused);
	await w.make("u2", "s3");
	await w.fake.plant({ [META.deployment]: "another", [META.uid]: "u1", [META.session]: "elsewhere" });
	const listed = await w.sandboxes.list("u1");
	expect(
		"a user's sandboxes are listed with their sessions, running and paused, and nobody else's",
		listed.length === 2 &&
			listed.some(sandbox => sandbox.id === mine && sandbox.sessionId === "s1" && sandbox.state === "running") &&
			listed.some(sandbox => sandbox.id === paused && sandbox.sessionId === "s2" && sandbox.state === "paused"),
		JSON.stringify(listed),
	);
	expect("a user id that cannot be one lists nothing", (await w.sandboxes.list("../u1")).length === 0);
	expect("an unused sandbox stops by itself after the idle timeout", w.sandboxes.idleStopMs === SETTINGS.idleTimeoutMs);
	const price = w.sandboxes.price();
	expect(
		"a second is priced for the size E2B said the sandboxes have",
		Math.abs(price.usdPerSecond - 0.0000185) < 1e-9 &&
			price.basis === "1 CPU and 1,024 MiB of memory at published prices",
		JSON.stringify(price),
	);
});

await section("the dead-man switch", async () => {
	// Real time here: the keepalive is a timer. A lease of 3 s is set again every second.
	const w = world({ turnLeaseMs: 3_000, idleTimeoutMs: 30_000 });
	const real = { offset: w.clock.now - Date.now() };
	const tick = () => (w.clock.now = Date.now() + real.offset);
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	tick();
	w.fake.calls.length = 0;
	const release = await handle.holdForTurn();
	expect(
		"when a turn starts, the timeout is set to the lease at once",
		callsOf(w.fake, "setTimeout").join() === `setTimeout ${id} 3000`,
		w.fake.calls.join(" | "),
	);
	await sleep(2_300);
	tick();
	const during = callsOf(w.fake, "setTimeout").length;
	expect(
		"while the turn runs it is pushed out again every third of the lease",
		during === 3 && w.fake.sandboxes.get(id)!.endAt > w.clock.now,
		`${during} calls in 2.3 s`,
	);
	await release();
	const after = callsOf(w.fake, "setTimeout");
	expect(
		"when the turn ends the timeout goes back to the short one",
		after.at(-1) === `setTimeout ${id} 30000` && after.length === during + 1,
		after.join(" | "),
	);
	await sleep(1_300);
	expect("and nothing pushes it out any more", callsOf(w.fake, "setTimeout").length === during + 1);
	await release();
	expect("releasing twice does nothing more", callsOf(w.fake, "setTimeout").length === during + 1);

	// A server that dies in the middle of a turn: nothing is released, nothing is pushed out again.
	const crashed = world({ turnLeaseMs: 3 * MINUTE });
	const lost = await crashed.make();
	const held = (await crashed.sandboxes.connect(lost)) as E2bSandboxHandle;
	await held.holdForTurn();
	const startedAt = crashed.clock.now;
	// The dead server's timer is not this test's to wait for: the clock moves on without it.
	crashed.clock.now += 3 * MINUTE + 1_000;
	const info = await crashed.fake.info(lost);
	expect(
		"a sandbox whose server died is paused by E2B itself when the lease runs out, having run no longer than the lease",
		info?.state === "paused" &&
			crashed.fake.ranMs(lost) === 3 * MINUTE &&
			crashed.fake.ranMs(lost) <= crashed.clock.now - startedAt,
		`${info?.state}, ran ${crashed.fake.ranMs(lost) / 1000} s`,
	);
	expect(
		"the server that wakes after expiry can read the actual pause time without resuming the VM",
		(await crashed.sandboxes.observe(lost)).pausedAt === startedAt + 3 * MINUTE &&
			(await crashed.fake.info(lost))?.state === "paused",
	);
	const idle = world();
	const quiet = await idle.make();
	idle.clock.now += 2 * MINUTE + 1;
	expect(
		"a sandbox nobody connects to is paused when the short timeout runs out",
		(await idle.sandboxes.state(quiet)) === "paused" && idle.fake.ranMs(quiet) === 2 * MINUTE,
	);
	expect(
		"and a line says it stopped by itself, with the most it can have cost",
		idle.lines.some(
			line =>
				line.includes(`e2b.sandbox.timed_out id=${quiet}`) &&
				line.includes("ran at most 120 s at 1 vCPU and 1024 MiB") &&
				line.includes("(estimated)"),
		),
		idle.lines.join(" | "),
	);

	const failing = world({ turnLeaseMs: 3_000 });
	const flaky = await failing.make();
	const flakyHandle = (await failing.sandboxes.connect(flaky)) as E2bSandboxHandle;
	const let_go = await flakyHandle.holdForTurn();
	failing.fake.failSetTimeout = new Error("fake E2B: unreachable");
	await sleep(2_300);
	const said = failing.lines.filter(line => line.includes("e2b.keepalive_failed"));
	expect(
		"a timeout that cannot be pushed out is said once, with when the sandbox stops",
		said.length === 1 && /unreachable/.test(said[0] ?? "") && /it stops \d+ s from now/.test(said[0] ?? ""),
		said.join(" | "),
	);
	failing.fake.failSetTimeout = null;
	await let_go();

	// A command outside a turn that takes long (a clone) is vouched for too, once it has run a third of the short timeout.
	let finish: () => void = () => {};
	const slowCommand = new Promise<void>(resolve => (finish = resolve));
	const cloning = world({ idleTimeoutMs: 30_000, turnLeaseMs: 60_000 });
	const repo = await cloning.make();
	const repoHandle = (await cloning.sandboxes.connect(repo)) as E2bSandboxHandle;
	const repoMachine = cloning.machines.get(repo)!;
	const startOf = repoMachine.start.bind(repoMachine);
	repoMachine.start = async (command, options) => {
		const started = await startOf(command, options);
		return command.includes("git clone")
			? { ...started, wait: async () => (await slowCommand, started.wait()) }
			: started;
	};
	cloning.fake.calls.length = 0;
	const quick = await repoHandle.run("git status");
	expect(
		"a short command asks E2B for nothing about the timeout",
		quick.exitCode === 0 && callsOf(cloning.fake, "setTimeout").length === 0,
	);
	// The provider waits a third of the idle timeout (10 s here) before it vouches; the test does not: it shortens that wait.
	(cloning.sandboxes.provider as unknown as { holdCommandsAfterMs: number }).holdCommandsAfterMs = 200;
	const clone = repoHandle.run("git clone https://example.invalid/repo.git");
	await sleep(600);
	const whileCloning = callsOf(cloning.fake, "setTimeout");
	finish();
	const cloned = await clone;
	expect(
		"a command that takes long keeps its sandbox alive like a turn, and lets go when it ends",
		whileCloning.join() === `setTimeout ${repo} 60000` &&
			cloned.exitCode === 0 &&
			callsOf(cloning.fake, "setTimeout").at(-1) === `setTimeout ${repo} 30000` &&
			callsOf(cloning.fake, "pause").length === 0,
		callsOf(cloning.fake, "setTimeout").join(" | "),
	);

	const refused = world();
	const gone = await refused.make();
	const goneHandle = (await refused.sandboxes.connect(gone)) as E2bSandboxHandle;
	await refused.fake.kill(gone);
	let rejected = "";
	await goneHandle
		.holdForTurn()
		.catch((error: unknown) => (rejected = error instanceof Error ? error.message : String(error)));
	expect("a sandbox that cannot be kept running is not held: the turn is told", /not running/.test(rejected), rejected);
});

await section("the plan's hour", async () => {
	const w = world();
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	w.fake.calls.length = 0;
	await (await handle.holdForTurn())();
	expect("a sandbox with most of its hour left is not paused before a turn", callsOf(w.fake, "pause").length === 0);
	// It has run 20 minutes without a pause, kept up by turns: 45 minutes of turn and the lease no longer fit into the hour.
	w.fake.sandboxes.get(id)!.endAt = Number.MAX_SAFE_INTEGER;
	w.clock.now += 20 * MINUTE;
	w.fake.calls.length = 0;
	const before = handle.connection;
	const release = await handle.holdForTurn();
	const order = w.fake.calls.filter(call => /^(pause|connect|setTimeout) /.test(call)).map(call => call.split(" ")[0]);
	expect(
		"a sandbox with too little of its hour left is paused and resumed before the turn starts",
		order.join() === "pause,connect,setTimeout" &&
			handle.connection !== before &&
			w.lines.some(line => line.includes("e2b.sandbox.refreshed") && line.includes("20 min of the 60")),
		order.join(),
	);
	await release();
	w.fake.calls.length = 0;
	await (await handle.holdForTurn())();
	expect("after that it has a whole hour again", callsOf(w.fake, "pause").length === 0);
	const long = world({ turnLimitMs: 2 * 60 * MINUTE });
	const big = await long.make();
	const bigHandle = (await long.sandboxes.connect(big)) as E2bSandboxHandle;
	long.fake.sandboxes.get(big)!.endAt = Number.MAX_SAFE_INTEGER;
	long.clock.now += 20 * MINUTE;
	long.fake.calls.length = 0;
	await (await bigHandle.holdForTurn())();
	expect(
		"where a turn may take longer than the plan's hour, pausing first would not help and is not done",
		callsOf(long.fake, "pause").length === 0,
	);
});

await section("suspend, resume, destroy", async () => {
	const w = world();
	const id = await w.make("u1", "s1");
	const machine = w.machines.get(id)!;
	w.clock.now += 90_000;
	machine.commands.length = 0;
	await w.sandboxes.suspend(id);
	const path = tokenFilePath(id, DATA_DIR);
	expect(
		"suspend removes an access token file a turn that was cut off left, then pauses",
		machine.commands.some(entry => entry.command === `rm -f -- ${path} ${path}.tmp`) &&
			w.fake.sandboxes.get(id)?.state === "paused" &&
			(await w.sandboxes.state(id)) === "paused",
		machine.commands.map(entry => entry.command).join(" | "),
	);
	expect(
		"the E2B token file stays in Windlass's data directory on the private guest disk",
		path === `${DATA_DIR}/access-token-${id}.json`,
	);
	const paused = w.lines.find(line => line.includes(`e2b.sandbox.paused id=${id}`));
	expect(
		"a line says how long it ran and what that costs by estimate",
		paused !== undefined &&
			paused.includes("uid=u1 session=s1: it ran 90 s at 1 vCPU and 1024 MiB, $0.0017 (estimated)"),
		paused,
	);
	expect("E2B counted the same running time", w.fake.ranMs(id) === 90_000);
	expect(
		"an explicit pause reports the time it happened even with idle lease time remaining",
		(await w.sandboxes.observe(id)).pausedAt === w.clock.now,
	);
	const pausesBefore = callsOf(w.fake, "pause").length;
	await w.sandboxes.suspend(id);
	expect("suspending a paused sandbox does nothing", callsOf(w.fake, "pause").length === pausesBefore);

	w.clock.now += 10 * MINUTE;
	machine.commands.length = 0;
	const handle = await w.sandboxes.connect(id);
	expect(
		"connect resumes it",
		handle !== undefined &&
			w.fake.sandboxes.get(id)?.state === "running" &&
			w.lines.some(line => line.includes(`e2b.sandbox.resumed id=${id}`)),
	);
	expect(
		"a resumed sandbox is tidied first, once one command shows it answers: a Windlass a cut-off turn left is looked for, and its token file removed",
		machine.commands[0]?.command === "true" &&
			machine.commands[0].options.root === true &&
			hardening(machine.commands[1] ?? { command: "" }) &&
			machine.commands[1].options.root === true &&
			machine.commands[2]?.command === "wlp-run tags-of windlass" &&
			machine.commands.some(entry => entry.command === `rm -f -- ${path} ${path}.tmp`),
		machine.commands.map(entry => entry.command).join(" | "),
	);
	expect("the ten minutes it was paused are not running time", w.fake.ranMs(id) === 90_000);

	const busy = world();
	const slow = await busy.make();
	busy.fake.pauseBusy = 2;
	await busy.sandboxes.suspend(slow);
	expect(
		"a pause E2B refuses for now is tried again",
		callsOf(busy.fake, "pause").length === 3 && busy.fake.sandboxes.get(slow)?.state === "paused",
	);
	const stuck = world();
	const never = await stuck.make();
	stuck.fake.pauseBusy = 5;
	let gaveUp = "";
	await stuck.sandboxes
		.suspend(never)
		.catch((error: unknown) => (gaveUp = error instanceof Error ? error.message : String(error)));
	expect(
		"one that is refused three times is reported, with what stops the sandbox instead",
		/could not pause the sandbox \(its own timeout pauses it within 120 s\)/.test(gaveUp),
		gaveUp,
	);

	w.clock.now += 30_000;
	await w.sandboxes.destroy(id);
	const killed = w.lines.find(line => line.includes(`e2b.sandbox.killed id=${id}`));
	expect(
		"destroy kills it, and a line says what the last stretch cost",
		w.fake.sandboxes.size === 0 &&
			(await w.sandboxes.state(id)) === "none" &&
			killed !== undefined &&
			killed.includes("it ran 30 s at 1 vCPU and 1024 MiB, $0.0006 (estimated)"),
		killed,
	);
	const killsBefore = callsOf(w.fake, "kill").length;
	await w.sandboxes.destroy(id);
	expect(
		"destroying one that is gone does nothing",
		callsOf(w.fake, "kill").length === killsBefore && (await w.sandboxes.connect(id)) === undefined,
	);
	const p = world();
	const sleeping = await p.make();
	await p.sandboxes.suspend(sleeping);
	p.lines.length = 0;
	await p.sandboxes.destroy(sleeping);
	expect(
		"a paused sandbox is destroyed too, and the line says nothing ran",
		p.fake.sandboxes.size === 0 && p.lines.some(line => line.includes("it was paused already, so nothing ran")),
		p.lines.join(" | "),
	);

	const noPause = world({ pause: false });
	const brief = await noPause.make();
	expect(
		"with WLP_E2B_PAUSE=0 a sandbox is killed when its timeout runs out",
		noPause.fake.sandboxes.get(brief)?.onTimeout === "kill",
	);
	await noPause.sandboxes.suspend(brief);
	expect(
		"and suspend kills it, saying plainly what is lost",
		noPause.fake.sandboxes.size === 0 &&
			noPause.lines.some(
				line =>
					line.includes(`e2b.sandbox.killed id=${brief}`) &&
					line.includes("the files in its workspace and its Windlass session are lost"),
			),
		noPause.lines.join(" | "),
	);
});

await section("hardening", async () => {
	// E2B's base system lets any user of the guest become root (sshd that lets root in, empty passwords): the
	// provider takes that away as root at every create, resume and restart, before anything of a session's runs.
	const syntax = spawnSync("sh", ["-n", "-c", GUEST_HARDENING_SCRIPT], { encoding: "utf8" });
	expect("the hardening script is valid sh", syntax.status === 0, syntax.stderr);
	expect(
		"it locks root and user, masks the ssh and rpcbind units and checks port 22 and empty passwords",
		GUEST_HARDENING_SCRIPT.startsWith(HARDENING_MARK) &&
			/for name in root user /.test(GUEST_HARDENING_SCRIPT) &&
			/passwd -l "\$name"/.test(GUEST_HARDENING_SCRIPT) &&
			/ssh\.socket ssh\.service .*rpcbind\.socket rpcbind\.service/.test(GUEST_HARDENING_SCRIPT) &&
			/:0016\$/.test(GUEST_HARDENING_SCRIPT) &&
			/PermitRootLogin no/.test(GUEST_HARDENING_SCRIPT),
	);

	const w = world();
	const id = await w.make();
	const machine = w.machines.get(id)!;
	const firstOther = machine.commands.findIndex(entry => !hardening(entry));
	expect(
		"create: the first command in a new sandbox is the hardening script, as root, and it runs once",
		hardening(machine.commands[0] ?? { command: "" }) &&
			machine.commands[0].options.root === true &&
			machine.commands.filter(hardening).length === 1 &&
			firstOther === 1,
		machine.commands.map(entry => entry.command.slice(0, 40)).join(" | "),
	);

	machine.commands.length = 0;
	const again = await w.sandboxes.connect(id);
	expect(
		"a connect to a running sandbox this process hardened since it started does not run it again",
		again !== undefined && !machine.commands.some(hardening),
		machine.commands.map(entry => entry.command.slice(0, 40)).join(" | "),
	);
	const release = await (again as E2bSandboxHandle).holdForTurn();
	await (again as E2bSandboxHandle).run("echo mid-turn");
	await release();
	expect("nor does a turn's hold or a command in the turn", !machine.commands.some(hardening));

	// Another server, or this one after a restart: it has not seen the sandbox hardened, so it hardens it first.
	const other = e2bSandboxes(w.fake, SETTINGS, { log: () => {}, now: () => w.clock.now, sleep: async () => {} });
	machine.commands.length = 0;
	await other.connect(id);
	expect(
		"a connect from a process that has not hardened it runs the script right after the probe",
		machine.commands[0]?.command === "true" && hardening(machine.commands[1] ?? { command: "" }),
		machine.commands.map(entry => entry.command.slice(0, 40)).join(" | "),
	);

	await w.sandboxes.suspend(id);
	machine.commands.length = 0;
	await w.sandboxes.connect(id);
	expect(
		"resume: the script runs right after the probe, before the leftovers of a cut-off turn are looked for",
		machine.commands[0]?.command === "true" &&
			hardening(machine.commands[1] ?? { command: "" }) &&
			machine.commands[1].options.root === true &&
			machine.commands[2]?.command === "wlp-run tags-of windlass",
		machine.commands.map(entry => entry.command.slice(0, 40)).join(" | "),
	);

	// The plan's hour: the hold pauses and resumes the sandbox before the turn, and hardens it again then.
	const refreshed = world();
	const rid = await refreshed.make();
	const rmachine = refreshed.machines.get(rid)!;
	const rhandle = (await refreshed.sandboxes.connect(rid)) as E2bSandboxHandle;
	refreshed.fake.sandboxes.get(rid)!.endAt = Number.MAX_SAFE_INTEGER;
	refreshed.clock.now += 20 * MINUTE;
	rmachine.commands.length = 0;
	const rrelease = await rhandle.holdForTurn();
	await rrelease();
	expect(
		"a pause and resume for the plan's hour hardens it again before the turn",
		callsOf(refreshed.fake, "pause").length === 1 && rmachine.commands.filter(hardening).length === 1,
		`${callsOf(refreshed.fake, "pause").length} pauses; ${rmachine.commands.map(entry => entry.command.slice(0, 40)).join(" | ")}`,
	);

	// A start from the disk boots E2B's base system again: hardened after the reboot, before anything else.
	class Wedging extends ScriptedMachine {
		wedged = false;
		override async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
			if (!this.wedged) return super.start(command, options);
			this.commands.push({ command, options, stdin: "" });
			return {
				pid: 9,
				sendStdin: async () => {},
				closeStdin: async () => {},
				wait: () => new Promise(() => {}),
				disconnect: async () => {},
				kill: async () => {},
			};
		}
		async rebooted(): Promise<void> {
			this.wedged = false;
		}
	}
	const wedges = new Map<string, Wedging>();
	const rebootFake = new FakeE2b({
		machine: sandboxId => {
			const made = new Wedging(command =>
				command.includes("windlass --version") ? { stdout: "Windlass 0.4.0+test (linux-x64)\n" } : undefined,
			);
			wedges.set(sandboxId, made);
			return made;
		},
	});
	const rebooting = e2bSandboxes(rebootFake, SETTINGS, { log: () => {}, sleep: async () => {}, probeMs: 50 });
	const wid = await rebooting.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
	const wmachine = wedges.get(wid)!;
	wmachine.wedged = true;
	wmachine.commands.length = 0;
	const rebooted = (await rebooting.connect(wid)) as E2bSandboxHandle;
	const probes = wmachine.commands.map(entry =>
		entry.command === "true" ? "probe" : hardening(entry) ? "harden" : "other",
	);
	expect(
		"restart from disk: the script runs after the probe that shows the rebooted guest answers, before anything else",
		rebooted.notice === RESTARTED_NOTICE && probes.slice(0, 3).join() === "probe,probe,harden",
		probes.join(),
	);

	// Fails closed: a guest the script could not lock down is not used.
	const refusing = (answer: (command: string) => { exitCode?: number; stdout?: string } | undefined) => {
		const lines: string[] = [];
		const machines = new Map<string, ScriptedMachine>();
		let refuse = false;
		const fake = new FakeE2b({
			machine: sandboxId => {
				const made = imageLike(command => (refuse && hardening({ command }) ? answer(command) : undefined));
				machines.set(sandboxId, made);
				return made;
			},
		});
		const sandboxes = e2bSandboxes(fake, SETTINGS, {
			log: line => lines.push(line),
			sleep: async () => {},
			hardeningMs: 50,
		});
		return { lines, machines, fake, sandboxes, refuse: () => (refuse = true) };
	};
	const bad = refusing(() => ({ exitCode: 1, stdout: "refused: something still listens on port 22\n" }));
	bad.refuse();
	const created = await userError(() => bad.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" }));
	const badId = [...bad.machines.keys()][0] ?? "";
	expect(
		"create: a failed check fails the create with words for the person, and the sandbox is killed",
		created === hardeningRefusal("refused: something still listens on port 22") &&
			bad.fake.sandboxes.size === 0 &&
			bad.machines.get(badId)?.commands.length === 1 &&
			bad.lines.some(line => line.includes(`e2b.sandbox.hardening_failed id=${badId}`)),
		created ?? "created",
	);

	const later = refusing(() => ({ exitCode: 1, stdout: "refused: accounts with an empty password remain: user\n" }));
	const laterId = await later.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
	await later.sandboxes.suspend(laterId);
	later.refuse();
	const lmachine = later.machines.get(laterId)!;
	lmachine.commands.length = 0;
	const resumed = await userError(() => later.sandboxes.connect(laterId));
	expect(
		"resume: a failed check fails the connect, nothing of the session's runs, and the sandbox is paused again",
		resumed === hardeningRefusal("refused: accounts with an empty password remain: user") &&
			lmachine.commands.map(entry => (hardening(entry) ? "harden" : entry.command)).join() === "true,harden" &&
			later.fake.sandboxes.get(laterId)?.state === "paused",
		`${resumed} | ${lmachine.commands.map(entry => entry.command.slice(0, 40)).join(" | ")}`,
	);
	const retry = await userError(() => later.sandboxes.connect(laterId));
	expect("and the next connect tries again, and fails again while the guest refuses", retry === resumed);

	const silent = refusing(() => ({ exitCode: 0, stdout: "" }));
	silent.refuse();
	const said = await userError(() => silent.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" }));
	expect(
		"a script that ends well without saying `hardened` counts as a failure",
		said !== null && said.startsWith("The sandbox was not used") && silent.fake.sandboxes.size === 0,
		said ?? "",
	);

	const hanging = refusing(() => undefined);
	const hangingId = await hanging.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
	const hmachine = hanging.machines.get(hangingId)!;
	const start = hmachine.start.bind(hmachine);
	hmachine.start = async (command, options) => {
		if (!hardening({ command })) return start(command, options);
		return {
			pid: 9,
			sendStdin: async () => {},
			closeStdin: async () => {},
			wait: () => new Promise(() => {}),
			disconnect: async () => {},
			kill: async () => {},
		};
	};
	await hanging.sandboxes.suspend(hangingId);
	const hung = await userError(() => hanging.sandboxes.connect(hangingId));
	expect(
		"a script that does not end in time counts as a failure",
		hung === hardeningRefusal("the script did not end within 0.05 s"),
		hung ?? "",
	);
});

await section("a sandbox that does not answer", async () => {
	// What happened on the live server: an agent's command used all of a 1 GiB sandbox's memory. Commands still started
	// and none ended, and the pause kept that memory, so every resume brought the same wedged guest back and every
	// turn failed at its network. The connect now finds that out first and starts the sandbox again from its disk.
	class Wedged extends ScriptedMachine {
		wedged = false;
		/** Whether a start from the disk cures it (a memory image that wedges the guest) or not. */
		curedByReboot = true;
		reboots = 0;
		constructor() {
			super(command =>
				/ wlp-network [a-z]+ /.test(command)
					? { stdout: `network ${/ wlp-network ([a-z]+) /.exec(command)?.[1]}\n` }
					: command.includes("windlass --version")
						? { stdout: "Windlass 0.4.0+test (linux-x64)\n" }
						: undefined,
			);
		}
		override async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
			if (!this.wedged) return super.start(command, options);
			this.commands.push({ command, options, stdin: "" });
			return {
				pid: 9,
				sendStdin: async () => {},
				closeStdin: async () => {},
				wait: () => new Promise(() => {}),
				disconnect: async () => {},
				kill: async () => {},
			};
		}
		async rebooted(): Promise<void> {
			this.reboots += 1;
			if (this.curedByReboot) this.wedged = false;
		}
	}
	const restrictedNetwork = readE2bNetwork({ WLP_E2B_NETWORK: "restricted" });
	const setup = (settings: Partial<E2bSettings> = {}) => {
		const lines: string[] = [];
		const machines = new Map<string, Wedged>();
		const fake = new FakeE2b({
			machine: id => {
				const machine = new Wedged();
				machines.set(id, machine);
				return machine;
			},
		});
		const sandboxes = e2bSandboxes(
			fake,
			{ ...SETTINGS, network: restrictedNetwork, ...settings },
			{ log: line => lines.push(line), sleep: async () => {}, probeMs: 50, networkMs: 100 },
		);
		return { lines, fake, machines, sandboxes };
	};

	for (const paused of [true, false]) {
		const w = setup();
		const id = await w.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
		const machine = w.machines.get(id)!;
		if (paused) await w.sandboxes.suspend(id);
		machine.wedged = true;
		machine.commands.length = 0;
		w.fake.calls.length = 0;
		const handle = await w.sandboxes.connect(id).catch((error: unknown) => error as Error);
		const ok = handle !== undefined && !(handle instanceof Error);
		const names = machine.commands.findIndex(entry => entry.command.includes(" wlp-network restricted "));
		expect(
			`${paused ? "a resumed" : "a running"} sandbox that starts commands and ends none is paused and started again from its disk, then set up`,
			ok &&
				machine.reboots === 1 &&
				callsOf(w.fake, "pause").length === 1 &&
				callsOf(w.fake, "connect").at(-1) === `connect ${id} ${SETTINGS.idleTimeoutMs} reboot` &&
				names > 0 &&
				w.fake.sandboxes.get(id)?.state === "running",
			handle instanceof Error ? handle.message : `${machine.reboots} reboots; ${w.fake.calls.join(" | ")}`,
		);
		expect(
			`${paused ? "resumed" : "running"}: the turn's timeline is told, and the log says what did not answer`,
			ok &&
				(handle as E2bSandboxHandle).notice === RESTARTED_NOTICE &&
				w.lines.some(
					line => line.includes(`e2b.sandbox.unresponsive id=${id}`) && line.includes("did not end within 0.05 s"),
				) &&
				w.lines.some(line => line.includes(`e2b.sandbox.rebooted id=${id}`)),
			w.lines.join("\n"),
		);
	}

	{
		const w = setup();
		const id = await w.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
		const machine = w.machines.get(id)!;
		const fine = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
		expect(
			"a sandbox that answers is not restarted, and its timeline is told nothing",
			fine.notice === undefined && machine.reboots === 0 && !w.lines.some(line => line.includes("unresponsive")),
		);
		machine.wedged = true;
		machine.curedByReboot = false;
		const error = await w.sandboxes.connect(id).then(
			() => null,
			(failure: unknown) => failure as Error,
		);
		expect(
			"one that still does not answer after a start from its disk fails the connect, saying both",
			error !== null &&
				/does not answer \(a command started in it and did not end within 0\.05 s\), and still did not after it was started again from its disk/.test(
					error.message,
				),
			error?.message,
		);
	}

	{
		const w = setup({ pause: false });
		const id = await w.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
		w.machines.get(id)!.wedged = true;
		const error = await w.sandboxes.connect(id).then(
			() => null,
			(failure: unknown) => failure as Error,
		);
		expect(
			"without pauses (WLP_E2B_PAUSE=0) it is not killed in passing: the connect fails and says why",
			error !== null && /WLP_E2B_PAUSE=0/.test(error.message) && w.fake.sandboxes.has(id),
			error?.message,
		);
	}

	{
		// The names script itself hangs, after its first step: the error says how far it got.
		const w = setup();
		const id = await w.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
		const machine = w.machines.get(id)!;
		const start = machine.start.bind(machine);
		machine.start = async (command, options) => {
			if (!command.includes(" wlp-network ")) return start(command, options);
			options.onStdout?.("step lock\n");
			return {
				pid: 9,
				sendStdin: async () => {},
				closeStdin: async () => {},
				wait: () => new Promise(() => {}),
				disconnect: async () => {},
				kill: async () => {},
			};
		};
		const error = await w.sandboxes.connect(id).then(
			() => null,
			(failure: unknown) => failure as Error,
		);
		expect(
			"a names script that hangs says which part hung",
			error !== null &&
				/the script started \(in [\d.]+ s\) and did not end within 0\.1 s; it was waiting for its lock/.test(
					error.message,
				),
			error?.message,
		);
	}
	expect(
		"a names script that printed nothing never ran its first line",
		guestNetworkStep("") === "it printed nothing, so the sandbox never ran its first line" &&
			guestNetworkStep("step lock\nstep hosts\n") === "it was writing /etc/hosts",
	);
});

await section("sizes", async () => {
	const plain = (value: unknown) => JSON.stringify(value);
	// E2B fixes a sandbox's CPUs and memory when its template is built: each size is a template of its own.
	expect(
		"WLP_E2B_SIZES: small alone by default, small always among them, in size order",
		plain(readE2bSettings({}).sizes) === plain(["small"]) &&
			plain(readE2bSettings({ WLP_E2B_SIZES: "large, standard" }).sizes) === plain(["small", "standard", "large"]),
	);
	expect(
		"a size that is not one is refused at startup",
		(() => {
			try {
				readE2bSettings({ WLP_E2B_SIZES: "small,huge" });
				return false;
			} catch (error) {
				return /WLP_E2B_SIZES/.test(String(error));
			}
		})(),
	);
	const named = readE2bSettings({ WLP_E2B_TEMPLATE_LARGE: "big-one" });
	expect(
		"each size's templates by default, and by their own variables",
		templateFor(named, "standard", false) === "windlass-platform-sandbox-standard" &&
			templateFor(named, "standard", true) === "windlass-platform-sandbox-standard-shots" &&
			templateFor(named, "large", false) === "big-one" &&
			templateFor(named, "small", false) === "windlass-platform-sandbox",
	);
	expect(
		"a size not offered gets the largest offered below it",
		offeredSize({ sizes: ["small", "standard"] }, "large") === "standard" &&
			offeredSize({ sizes: ["small", "large"] }, "standard") === "small" &&
			offeredSize({ sizes: ["small"] }, "large") === "small",
	);

	const lines: string[] = [];
	const clock = { now: Date.parse("2026-11-15T12:00:00Z") };
	const fake = new FakeE2b({
		now: () => clock.now,
		machine: () => imageLike(),
		templateSizes: {
			"windlass-platform-sandbox-standard": { cpuCount: 2, memoryMB: 4096 },
			"windlass-platform-sandbox-large-shots": { cpuCount: 4, memoryMB: 8192 },
		},
	});
	const sandboxes = e2bSandboxes(
		fake,
		{ ...SETTINGS, maxRunning: 5, sizes: ["small", "standard", "large"] },
		{ log: line => lines.push(line), now: () => clock.now, sleep: async () => {} },
	);
	const standard = await sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b", hostedSize: "standard" });
	const made = fake.sandboxes.get(standard)!;
	expect(
		"a standard sandbox is made from the standard template, and says its size in its metadata and the log",
		made.template === "windlass-platform-sandbox-standard" &&
			made.metadata[META.size] === "standard" &&
			lines.some(line => line.includes(`e2b.sandbox.created id=${standard}`) && line.includes("size=standard")),
		lines.join("\n"),
	);
	const shots = await sandboxes.create({
		uid: "u1",
		sessionId: "s2",
		profile: "e2b",
		hostedSize: "large",
		screenshots: true,
	});
	expect(
		"screenshots in a large one: the large size's shots template",
		fake.sandboxes.get(shots)?.template === "windlass-platform-sandbox-large-shots",
	);
	const small = await sandboxes.create({ uid: "u1", sessionId: "s3", profile: "e2b" });
	expect(
		"no size asked: small, from the template it always was",
		fake.sandboxes.get(small)?.template === "windlass-platform-sandbox" &&
			fake.sandboxes.get(small)?.metadata[META.size] === "small",
	);
	const handle = (await sandboxes.connect(standard)) as E2bSandboxHandle;
	expect("its handle knows its size", handle.size === "standard");
	clock.now += 100_000;
	await sandboxes.suspend(standard);
	expect(
		"the cost line of a pause is at the size's own figures",
		lines.some(
			line => line.includes(`e2b.sandbox.paused id=${standard}`) && line.includes(describeUsage(100, 2, 4096)),
		),
		lines.filter(line => line.includes("paused")).join("\n"),
	);
	const sizes = sandboxes.sizes();
	expect(
		"the sizes offered, each with its price an hour",
		plain(sizes.map(size => size.id)) === plain(["small", "standard", "large"]) &&
			Math.abs((sizes[1]?.usdPerHour ?? 0) - estimatedCostUsd(3600, 2, 4096)) < 1e-9 &&
			(sizes[2]?.usdPerHour ?? 0) > (sizes[1]?.usdPerHour ?? 0),
	);
	expect(
		"the usage page's base price stays the small size's",
		Math.abs(sandboxes.price().usdPerSecond - estimatedCostUsd(1, 1, 1024)) < 1e-12,
	);

	const fallback = new FakeE2b({ machine: () => imageLike() });
	const smallOnly = e2bSandboxes(fallback, SETTINGS, { log: () => {}, sleep: async () => {} });
	const asked = await smallOnly.create({ uid: "u1", sessionId: "s1", profile: "e2b", hostedSize: "large" });
	expect(
		"a deployment that built only small offers one size, and makes small for any size asked",
		smallOnly.sizes().length === 1 && fallback.sandboxes.get(asked)?.template === "windlass-platform-sandbox",
	);

	// The account's plan refuses a size: the person reads the plan's limits, not E2B's words alone.
	const refusing = Object.assign(Object.create(fake) as FakeE2b, {
		create: async () => {
			throw new Error("400: memory 8192 MB exceeds the maximum allowed for your team's plan");
		},
	});
	const planLines: string[] = [];
	const onPlan = e2bSandboxes(
		refusing,
		{ ...SETTINGS, maxRunning: 5, sizes: ["small", "standard", "large"] },
		{ log: line => planLines.push(line), now: () => clock.now, sleep: async () => {} },
	);
	const refusal = await userError(() =>
		onPlan.create({ uid: "u1", sessionId: "s9", profile: "e2b", hostedSize: "large" }),
	);
	expect(
		"a size the plan refuses names the size and E2B's words, and is logged",
		refusal?.startsWith("E2B refused a Large sandbox (4 vCPU, 8 GiB) for the account's plan. E2B said:") === true &&
			refusal.includes("exceeds the maximum") &&
			planLines.some(line => line.includes("e2b.size_refused size=large")),
		refusal ?? "",
	);
	expect(
		"a template that is not there, or the account's count of sandboxes, is no size refusal",
		!refusesSize("404: template 'windlass-platform-sandbox-large' not found") &&
			!refusesSize("429: rate limit exceeded"),
	);

	// A snapshot is of one template's sandbox: its key differs by size, so one size's never starts another's.
	const store = new E2bSnapshots(
		fake,
		{ ...SETTINGS, sizes: ["small", "standard"], snapshots: DEFAULT_SNAPSHOT_LIMITS },
		() => {},
		() => clock.now,
	);
	const request = { repo: "123", generation: "a".repeat(64), inputs: "b".repeat(64) };
	expect(
		"snapshot keys differ by size, and each size's look-up is of its own template",
		store.key(request, "u1", "e2b", false, "build-1", "small") !==
			store.key(request, "u1", "e2b", false, "build-1", "standard") &&
			store.templateOf(false, "standard") === "windlass-platform-sandbox-standard",
	);
});

await section("a sandbox that ran out of memory", async () => {
	const plain = (value: unknown) => JSON.stringify(value);
	const lines: string[] = [];
	class Wedged extends ScriptedMachine {
		wedged = false;
		constructor() {
			super(command =>
				command.includes("windlass --version")
					? { stdout: "Windlass 0.6.0 (linux-x64)\n" }
					: command.includes("/proc/vmstat")
						? { stdout: "oom_kill 3\ntotal_kib 1000448\n" }
						: undefined,
			);
		}
		override async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
			if (!this.wedged) return super.start(command, options);
			this.commands.push({ command, options, stdin: "" });
			return {
				pid: 9,
				sendStdin: async () => {},
				closeStdin: async () => {},
				wait: () => new Promise(() => {}),
				disconnect: async () => {},
				kill: async () => {},
			};
		}
		async rebooted(): Promise<void> {
			this.wedged = false;
		}
	}
	const machines = new Map<string, Wedged>();
	const fake = new FakeE2b({
		machine: id => {
			const machine = new Wedged();
			machines.set(id, machine);
			return machine;
		},
	});
	const sandboxes = e2bSandboxes(
		fake,
		{ ...SETTINGS, sizes: ["small", "standard"] },
		{ log: line => lines.push(line), sleep: async () => {}, probeMs: 50 },
	);
	const id = await sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
	// The incident's figures: 942 of 977 MiB, as E2B sampled them while the guest answered nothing.
	const MiB = 2 ** 20;
	fake.samples.set(id, [
		{ at: Date.now() - 60_000, memUsed: 400 * MiB, memTotal: 977 * MiB },
		{ at: Date.now() - 30_000, memUsed: 942 * MiB, memTotal: 977 * MiB },
	]);
	machines.get(id)!.wedged = true;
	const handle = (await sandboxes.connect(id)) as E2bSandboxHandle;
	expect(
		"a sandbox that stopped answering with its memory used up says so, with the figures and the next size, and is restarted",
		handle.notice?.startsWith(
			"The sandbox ran out of memory (942 of 977 MiB). A larger size has more room: Medium · 2 CPU · 4 GB.",
		) === true &&
			plain(handle.outOfMemory) === plain({ usedMiB: 942, totalMiB: 977, size: "small" }) &&
			lines.some(line => line.includes("e2b.sandbox.unresponsive") && line.includes("memory=942/977MiB")),
		handle.notice ?? lines.join("\n"),
	);
	const events = await handle.memoryEvents();
	expect(
		"the guest's own count of programs killed for memory, and its memory",
		plain(events) === plain({ oomKills: 3, totalMiB: 977 }),
		JSON.stringify(events),
	);
	fake.samples.set(id, [{ at: Date.now(), memUsed: 300 * MiB, memTotal: 977 * MiB }]);
	expect("samples far from the total are no running out", (await handle.memoryPeak(0)) === null);
	expect(
		"the largest size says to use less memory instead",
		/largest size this deployment has: have the agent's commands use less memory/.test(
			outOfMemoryWords({ usedMiB: 8000, totalMiB: 8100, size: "large" }),
		) && /Large · 4 CPU · 8 GB/.test(outOfMemoryWords({ usedMiB: 4000, totalMiB: 4000, size: "standard" })),
	);
});

await section("a machine slot that ran out of memory", async () => {
	const { machineLayer } = await import("../server/src/sandbox/runner-layer.js");
	const { noteTurnMemory } = await import("../server/src/actors/agent-session.js");
	const { getLayer } = await import("../server/src/layer.js");
	for (const [name, capable, kills, workItem] of [
		["an unfinished work item", true, 2, true],
		["a personal session", true, 1, false],
		["no kills this turn", true, 0, true],
		["an older runner", false, 0, true],
	] as const) {
		let reads = 0;
		const link = {
			who: { machineId: "local" },
			again: async () => ({ cwd: "/workspace", profile: "docker-hardened", ...(capable && { memoryEvents: true }) }),
			request: async (op: string, args: { id: string }) => {
				if (op !== "memoryEvents" || args.id !== "box") throw new Error("unexpected runner operation");
				return { totalMiB: 1536, oomKills: 4 + (reads++ ? kills : 0) };
			},
		};
		const sandbox = (await machineLayer(link as never, await getLayer()).sandboxes.connect("box"))!;
		const start = (await sandbox.memoryEvents?.()) ?? null;
		const rows: TimelineItem[] = [];
		const c = {
			vars: { nextSeq: 1, unwritten: [], flushQueued: true },
			log: console,
			broadcast: (_name: string, row: TimelineItem) => rows.push(row),
		};
		const meta = { sessionId: "s1", place: { kind: "machine", machineId: "local" } };
		const active: { item?: { outOfMemory?: OutOfMemory } } = workItem ? { item: {} } : {};
		await noteTurnMemory(c as never, meta as never, active as never, sandbox, start, 0, 1);
		const row = rows[0];
		expect(
			name + ": only new kills warn on the timeline",
			kills
				? rows.length === 1 &&
						row?.kind === "platform" &&
						row.level === "warn" &&
						row.text.startsWith("The machine slot ran out of memory (limit 1,536 MiB).") &&
						row.text.includes(kills === 1 ? "stopped a program" : "stopped 2 programs") &&
						row.text.includes("137") &&
						!row.text.includes("larger")
				: rows.length === 0,
		);
		expect(
			name + ": only a work item with kills carries the memory to its question",
			kills && workItem
				? active.item?.outOfMemory?.totalMiB === 1536 && active.item.outOfMemory.larger === undefined
				: !active.item?.outOfMemory,
		);
		expect(name + ": only a capable runner receives memory reads", reads === (capable ? 2 : 0));
	}
});

await section("the handle", async () => {
	const secrets: string[] = [];
	const w = world(
		{},
		{
			machine: () =>
				imageLike((command, stdin) =>
					command.includes("umask 077")
						? (secrets.push(stdin()), {})
						: command === "cat /etc/hostname"
							? { stdout: "sandbox\n" }
							: undefined,
				),
		},
	);
	const id = await w.make();
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	const machine = [...w.fake.sandboxes.values()][0]!.machine as ScriptedMachine;
	machine.commands.length = 0;
	await handle.writeSecretFile(
		"/home/agent/.local/share/windlass/access-token-x.json",
		'{"accessToken":"FAKE-TOKEN-not-real"}',
	);
	const write = machine.commands[0];
	expect(
		"a secret goes in on standard input and is on no command line",
		secrets.join() === '{"accessToken":"FAKE-TOKEN-not-real"}' &&
			write !== undefined &&
			!write.command.includes("FAKE-TOKEN") &&
			write.command.endsWith("sh /home/agent/.local/share/windlass/access-token-x.json") &&
			write.options.stdin === true,
		write?.command,
	);
	expect(
		"it is written beside the file and renamed into place, readable by its owner only",
		/umask 077/.test(write?.command ?? "") && /mv -fT -- "\$tmp" "\$1"/.test(write?.command ?? ""),
	);
	expect(
		"an argument is quoted for E2B's shell, whatever is in it",
		shellQuote("it's $HOME `x`") === `'it'\\''s $HOME \`x\`'` &&
			shellQuote("plain-1.txt") === "plain-1.txt" &&
			shellQuote("") === "''",
	);
	machine.commands.length = 0;
	await handle.run("echo hi", { env: { A_B: "x y" }, cwd: "/tmp" });
	const ran = machine.commands[0];
	expect(
		"run() goes through bash under wlp-run, with its environment beside the command and not in it",
		ran !== undefined &&
			/^wlp-run exec r[a-f0-9]{12} bash -c 'echo hi'$/.test(ran.command) &&
			ran.options.envs?.A_B === "x y" &&
			ran.options.cwd === "/tmp",
		ran?.command,
	);
	let bad = "";
	await Promise.resolve()
		.then(() => handle.run("true", { env: { "A;B": "x" } }))
		.catch((error: unknown) => (bad = error instanceof Error ? error.message : String(error)));
	expect("an environment variable's name that is none is refused", /invalid environment variable name/.test(bad));
	await handle.writeTextFile("notes/a.txt", "hello");
	expect(
		"a relative path is the workspace's, as on Docker",
		machine.files.get("/workspace/notes/a.txt") === "hello" &&
			(await handle.readTextFile("notes/a.txt")) === "hello" &&
			(await handle.readTextFile("/workspace/notes/a.txt")) === "hello",
	);
	let missing = "";
	await handle
		.readTextFile("nope.txt")
		.catch((error: unknown) => (missing = error instanceof Error ? error.message : String(error)));
	expect("a file that is not there is an error that names it", /cannot read nope.txt/.test(missing), missing);
	const answer = await handle.ask(["cat", "/etc/hostname"]);
	expect(
		"ask() runs a short program directly and returns what it said",
		answer?.code === 0 && answer.stdout === "sandbox\n" && machine.commands.at(-1)?.command === "cat /etc/hostname",
	);
	await w.fake.pause(id);
	expect(
		"ask() of a sandbox that is not running answers null, as the turn code expects",
		(await handle.ask(["true"])) === null,
	);
});

/** A sandbox image whose plan relay (plan-relay.ts) runs: it listens once it has its sources and token, and ends when its input closes or it is killed. */
class PlanRelayMachine extends ScriptedMachine {
	readonly relays: Array<{ command: string; options: E2bCommandOptions; stdin: string; ended: boolean }> = [];
	constructor(private readonly listens = true) {
		super(
			(command, stdin) =>
				(/ wlp-network [a-z]+ /.test(command)
					? { stdout: `network ${/ wlp-network ([a-z]+) /.exec(command)?.[1]}\n` }
					: command.includes("windlass --version")
						? { stdout: "Windlass 0.7.1+test (linux-x64)\n" }
						: undefined) ?? (stdin(), undefined),
		);
	}
	override async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
		if (command.includes("git-stop")) for (const relay of this.relays) this.end(relay);
		if (!command.includes(GUEST_NODE)) return super.start(command, options);
		const relay = { command, options, stdin: "", ended: false };
		this.relays.push(relay);
		this.commands.push({ command, options, stdin: "" });
		let finish: (result: { exitCode: number }) => void = () => {};
		const done = new Promise<{ exitCode: number }>(resolve => (finish = resolve));
		this.ends.set(relay, () => finish({ exitCode: 0 }));
		return {
			pid: 99,
			sendStdin: async data => {
				relay.stdin += data;
				const lines = relay.stdin.split("\n").length;
				// A replaced token after the first two lines: the relay answers it was handed.
				if (lines > 3 && data.includes('"token"')) options.onStdout?.('{"handed":true}\n');
				if (lines === 3) {
					if (this.listens) options.onStdout?.('{"listening":40123}\n');
					else {
						options.onStderr?.("[wlp-plan-relay] cannot listen: EACCES\n");
						this.end(relay, 2);
					}
				}
			},
			closeStdin: async () => this.end(relay),
			wait: () => done,
			disconnect: async () => {},
			kill: async () => this.end(relay),
		};
	}
	private readonly ends = new Map<object, (code?: number) => void>();
	private end(relay: { ended: boolean }, code = 0) {
		if (relay.ended) return;
		relay.ended = true;
		this.ends.get(relay)?.(code);
	}
}

await section("a plan's relay in the sandbox", async () => {
	const PLAN_TOKEN = "sk-ant-oat01-FAKE-PLAN-TOKEN-not-real-" + "z".repeat(20);
	const relayOrigin = "https://relay.example.com";
	const machines: PlanRelayMachine[] = [];
	const w = world(
		{ openProfile: true, modelRelayOrigin: relayOrigin, maxRunning: 3 },
		{
			machine: () => {
				const machine = new PlanRelayMachine();
				machines.push(machine);
				return machine;
			},
		},
	);
	const id = await w.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b-open", harness: "claude" });
	const handle = (await w.sandboxes.connect(id)) as E2bSandboxHandle;
	const machine = machines.at(-1)!;
	const before = machine.commands.length;
	const CLAUDE_PLAN = { wire: "claude-plan", harness: "claude" } as const;
	const relay = await handle.localPlanRelay(PLAN_TOKEN, CLAUDE_PLAN);
	const started = machine.relays[0];
	expect(
		"it runs as the transport user (nobody), started from the image's Node, with a clean environment",
		started !== undefined &&
			started.options.gitUser === true &&
			started.command.includes("git-run") &&
			Object.entries(started.options.envs ?? {}).every(
				([key, value]) =>
					GIT_USER_ENV[key as keyof typeof GIT_USER_ENV] === value || ["LANG", "NO_COLOR"].includes(key),
			),
		JSON.stringify(started?.options.envs),
	);
	const lines = started?.stdin.split("\n") ?? [];
	const handed = lines[1] ? JSON.parse(lines[1]) : {};
	expect(
		"its program and then the token and a fresh placeholder arrive on its standard input",
		lines[0] === planRelaySources() &&
			handed.token === PLAN_TOKEN &&
			handed.placeholder === relay.placeholder &&
			handed.wire === "claude-plan" &&
			handed.harness === "claude",
	);
	const agentVisible = machine.commands.slice(before).filter(entry => !entry.command.includes(GUEST_NODE));
	const everywhere = [
		...machine.commands.map(entry => entry.command + JSON.stringify(entry.options.envs ?? {})),
		...agentVisible.map(entry => entry.stdin),
		...machine.files.values(),
	].join("\n");
	expect(
		"the token is on no command line, in no environment, in no other command's input and in no file",
		!everywhere.includes(PLAN_TOKEN) && !everywhere.includes("FAKE-PLAN-TOKEN"),
	);
	const env = hostedKeyEnv("claude", { provider: "anthropic", plan: true }, relay);
	expect(
		"Claude Code is pointed at the relay on loopback with the placeholder as its plan token",
		env.ANTHROPIC_BASE_URL === "http://127.0.0.1:40123" &&
			env.CLAUDE_CODE_OAUTH_TOKEN === relay.placeholder &&
			/^wlp-plan\.[A-Za-z0-9_-]{43}$/.test(relay.placeholder) &&
			env.ANTHROPIC_API_KEY === undefined,
		JSON.stringify(env),
	);
	const redacted = redactKeyLease({ active: false, text: t => t, deep: v => v, held: () => 0 }, relay.placeholder).text(
		`bearer ${relay.placeholder}`,
	);
	expect("the placeholder is redacted from the turn", !redacted.includes(relay.placeholder), redacted);
	const fileCount = machine.files.size;
	await relay.close();
	expect(
		"the turn's end stops it, and it left no file behind",
		started?.ended === true && machine.files.size === fileCount,
	);
	await expectRejects(() => relay.hand("sk-ant-oat01-another-token-0000"), /ended/, "a closed relay takes no token");

	const controller = new AbortController();
	const second = await handle.localPlanRelay(PLAN_TOKEN, { ...CLAUDE_PLAN, signal: controller.signal });
	controller.abort();
	await sleep(20);
	expect("the turn's abort stops it", machine.relays[1]?.ended === true);
	await second.close();
	const early = new AbortController();
	early.abort();
	await expectRejects(
		() => handle.localPlanRelay(PLAN_TOKEN, { ...CLAUDE_PLAN, signal: early.signal }),
		/abort/i,
		"an aborted turn starts none",
	);

	const failing = new PlanRelayMachine(false);
	const broken = world({ openProfile: true, modelRelayOrigin: relayOrigin }, { machine: () => failing });
	const brokenId = await broken.sandboxes.create({
		uid: "u1",
		sessionId: "s1",
		profile: "e2b-open",
		harness: "claude",
	});
	const brokenHandle = (await broken.sandboxes.connect(brokenId)) as E2bSandboxHandle;
	await expectRejects(
		() => brokenHandle.localPlanRelay(PLAN_TOKEN, CLAUDE_PLAN),
		/plan's relay could not be started in the sandbox: \[wlp-plan-relay\] cannot listen/,
		"a relay that cannot listen fails the turn, with nothing left running",
	);
	expect(
		"and it was stopped",
		failing.relays.every(one => one.ended),
	);

	// A ChatGPT plan's access token expires within the hour: the turn hands its relay the current one before then.
	const codexId = await w.sandboxes.create({ uid: "u1", sessionId: "s2", profile: "e2b-open", harness: "codex" });
	const codexHandle = (await w.sandboxes.connect(codexId)) as E2bSandboxHandle;
	const codexMachine = machines.at(-1)!;
	const firstAccess = "chatgpt-access-FAKE-1-" + "a".repeat(24);
	const nextAccess = "chatgpt-access-FAKE-2-" + "b".repeat(24);
	let asked = 0;
	let plan: { secret: string; expiresAt: number } | null = { secret: nextAccess, expiresAt: Date.now() + 3_600_000 };
	const codexRelay = await openModelKeyRelay(
		codexHandle,
		"s2",
		{ provider: "openai", plan: true, generation: "g1", harness: "codex" },
		undefined,
		undefined,
		async () => (asked++ === 0 ? { secret: firstAccess, expiresAt: Date.now() + 20 * 60_000 } : plan),
	);
	const codexStarted = codexMachine.relays.at(-1)!;
	const codexHanded = JSON.parse(codexStarted.stdin.split("\n")[1] ?? "{}");
	expect(
		"a ChatGPT plan's relay is started on its own wire for Codex, with the access token the turn opened",
		codexHanded.wire === "chatgpt-plan" && codexHanded.harness === "codex" && codexHanded.token === firstAccess,
	);
	await codexRelay.close();
	// The next token is due again soon too, so the plan's change below is asked about while the check waits.
	plan = { secret: nextAccess, expiresAt: Date.now() + 60_100 };
	const rotating = await codexHandle.localPlanRelay(firstAccess, { wire: "chatgpt-plan", harness: "codex" });
	const rotated = rotatePlanToken(
		rotating,
		Date.now() + 60_000,
		async () => {
			const answer = plan;
			plan = null;
			return answer;
		},
		{ leadMs: 59_950, retryMs: 10, log: () => undefined },
	);
	await sleep(400);
	const rotatingStarted = codexMachine.relays.at(-1)!;
	const replaced = rotatingStarted.stdin.split("\n").filter(line => line.includes(nextAccess));
	expect(
		"when the token has the lead left, the current one is asked for and handed on the relay's standard input, once",
		replaced.length === 1 && JSON.parse(replaced[0]!).token === nextAccess,
		rotatingStarted.stdin.slice(-200),
	);
	expect(
		"a plan that changed meanwhile gives no token, nothing more is handed, and its relay is stopped",
		rotatingStarted.stdin.split("\n").filter(line => line.includes('"token"')).length === 2 &&
			rotatingStarted.ended === true,
	);
	await rotated.close();

	// Hosted Windlass on the ChatGPT plan: the same relay in the sandbox, on Windlass's routes, its file only the placeholder.
	const windlassId = await w.sandboxes.create({ uid: "u1", sessionId: "s3", profile: "e2b" });
	const windlassHandle = (await w.sandboxes.connect(windlassId)) as E2bSandboxHandle;
	const windlassMachine = machines.at(-1)!;
	const windlassRelay = await openModelKeyRelay(
		windlassHandle,
		"s3",
		{ provider: "openai", plan: true, generation: "g1", harness: "windlass" },
		undefined,
		undefined,
		async () => ({ secret: firstAccess, expiresAt: Date.now() + 30 * 60_000 }),
	);
	const windlassStarted = windlassMachine.relays.at(-1)!;
	const windlassHanded = JSON.parse(windlassStarted.stdin.split("\n")[1] ?? "{}");
	const planFile = turnTokenFilePath(windlassHandle);
	await writePlanPlaceholder(windlassHandle, planFile, windlassRelay.placeholder, Date.now() + 3_600_000);
	const fileWrite = windlassMachine.commands.find(c => c.command.includes(planFile) && c.stdin.includes("accessToken"));
	const windlassEnv = windlassPlanEnv(windlassRelay, planFile);
	expect(
		"Windlass on the ChatGPT plan starts the relay in its sandbox on the chatgpt-plan wire for Windlass, at the /v1 base, and its token file holds only the placeholder",
		windlassHanded.wire === "chatgpt-plan" &&
			windlassHanded.harness === "windlass" &&
			windlassHanded.token === firstAccess &&
			windlassEnv.WINDLASS_MODEL_BASE_URL === "http://127.0.0.1:40123/v1" &&
			windlassEnv.WINDLASS_PROVIDER === "chatgpt" &&
			windlassEnv.WINDLASS_ACCESS_TOKEN_FILE === planFile &&
			planFile.startsWith(DATA_DIR) &&
			!!fileWrite &&
			fileWrite.stdin.includes(windlassRelay.placeholder) &&
			!windlassMachine.commands.some(c => c.stdin.includes(firstAccess) || c.command.includes(firstAccess)),
		JSON.stringify({ wire: windlassHanded.wire, env: windlassEnv, file: !!fileWrite }),
	);
	await windlassRelay.close();
	expect("the turn's end stops Windlass's plan relay", windlassStarted.ended === true);

	const keyLease = await openModelKeyRelay(handle, "s1", {
		provider: "anthropic",
		generation: "g1",
		harness: "claude",
	});
	expect(
		"a Settings key still goes through the platform relay, with no relay in the sandbox",
		keyLease.env.WINDLASS_MODEL_BASE_URL === `${relayOrigin}/model-relay` && machine.relays.length === 2,
		keyLease.env.WINDLASS_MODEL_BASE_URL,
	);
	await keyLease.close();

	// The plan's API is allowed in a Claude Code sandbox, out of `open`, so its relay can reach it; in no other.
	for (const mode of ["restricted", "none"] as const) {
		const network = readE2bNetwork({
			WLP_E2B_NETWORK: mode,
			WLP_MODEL_RELAY_URL: relayOrigin,
			WLP_E2B_WINDLASS_VERSION: "0.7.1",
		});
		const n = world({ openProfile: true, modelRelayOrigin: relayOrigin, network, maxRunning: 10 });
		const allowed = async (harness?: "claude" | "codex" | "opencode") => {
			const made = await n.sandboxes.create({
				uid: "u1",
				sessionId: `s-${harness ?? "windlass"}`,
				profile: harness ? "e2b-open" : "e2b",
				...(harness && { harness }),
			});
			const made1 = n.fake.sandboxes.get(made)!.network?.allowOut ?? [];
			await n.sandboxes.connect(made);
			const made2 = n.fake.sandboxes.get(made)!.network?.allowOut ?? [];
			return { made1, made2, meta: n.fake.sandboxes.get(made)!.metadata };
		};
		const claude = await allowed("claude");
		expect(
			`${mode}: a Claude Code sandbox may reach api.anthropic.com and the platform relay, at create and at each connect`,
			claude.made1.includes("api.anthropic.com") &&
				claude.made2.includes("api.anthropic.com") &&
				claude.made1.includes("relay.example.com") &&
				claude.meta[META.harness] === "claude",
			claude.made2.join(","),
		);
		const codex = await allowed("codex");
		const others = [codex, await allowed("opencode"), await allowed()];
		expect(
			`${mode}: no other agent's sandbox may`,
			others.every(o => !o.made1.includes("api.anthropic.com") && !o.made2.includes("api.anthropic.com")) &&
				others[2]!.meta[META.harness] === undefined,
		);
		const windlass = others[2]!;
		expect(
			`${mode}: a Codex or Windlass sandbox may reach api.openai.com for a ChatGPT plan's relay, and no other agent's may`,
			[codex, windlass].every(o => o.made1.includes("api.openai.com") && o.made2.includes("api.openai.com")) &&
				[claude, others[1]!].every(o => !o.made1.includes("api.openai.com")),
			`${codex.made2.join(",")} | windlass: ${windlass.made2.join(",")}`,
		);
	}
});

await section("a sign-in that is forgotten", async () => {
	const w = world({ maxRunning: 5 });
	const one = await w.make("u1", "s1");
	const two = await w.make("u1", "s2");
	const other = await w.make("u2", "s3");
	const asleep = await w.make("u1", "s4");
	await w.sandboxes.suspend(asleep);
	for (const machine of w.machines.values()) machine.commands.length = 0;
	let loggedOut = "";
	const logins = { logout: async (uid: string) => void (loggedOut = uid) } as unknown as ChatgptLogins;
	const tokens: AccessTokens = {
		current: async () => ({ accessToken: "x".repeat(20), expiresAt: Date.now() + 3_600_000 }),
	};
	const layer = createE2bSandboxLayer(
		{ logins, tokens },
		{ client: w.fake, settings: { ...SETTINGS, maxRunning: 5 }, log: () => undefined, now: () => w.clock.now },
	);
	await layer.logins.logout("u1");
	const removed = (id: string) =>
		(w.machines.get(id)?.commands ?? []).some(
			entry => entry.command === `rm -f -- ${tokenFilePath(id, DATA_DIR)} ${tokenFilePath(id, DATA_DIR)}.tmp`,
		);
	expect(
		"logout forgets the sign-in, then removes the token files of the user's running turns, each in its own sandbox",
		loggedOut === "u1" && removed(one) && removed(two),
	);
	expect(
		"another user's sandbox is left alone, and a paused one is not started for it",
		!removed(other) &&
			w.fake.sandboxes.get(asleep)?.state === "paused" &&
			(w.machines.get(other)?.commands.length ?? 0) === 0,
	);
});

await section("cleanup", async () => {
	const w = world({ maxRunning: 5 });
	const a = await w.make("u1", "s1");
	const b = await w.make("u2", "s2");
	await w.sandboxes.suspend(b);
	const foreign = await w.fake.plant({ [META.deployment]: "another" });
	const bare = await w.fake.plant({});
	w.clock.now += 5 * MINUTE;
	w.fake.sandboxes.get(a)!.endAt = Number.MAX_SAFE_INTEGER;
	w.fake.calls.length = 0;
	const dry = await cleanupDeployment(w.fake, "test", { kill: false, now: () => w.clock.now });
	expect(
		"a dry run lists the deployment's sandboxes, running and paused, and changes nothing",
		dry.found.length === 2 &&
			dry.killed.length === 0 &&
			w.fake.sandboxes.size === 4 &&
			!w.fake.calls.some(call => call.startsWith("kill ")),
		dry.lines.join(" | "),
	);
	expect(
		"each line names the sandbox, its user and session, and what it has cost at most",
		dry.lines.some(line =>
			line.startsWith(
				`${a}  uid=u1 session=s1 size=small  running, at most 300 s at 1 vCPU and 1024 MiB, $0.0055 (estimated) so far: would be killed`,
			),
		) &&
			dry.lines.some(line => line.startsWith(`${b}  uid=u2 session=s2 size=small  paused`)) &&
			/A dry run: nothing was changed/.test(dry.lines.at(-1) ?? ""),
		dry.lines.join(" | "),
	);
	const real = await cleanupDeployment(w.fake, "test", { kill: true, now: () => w.clock.now });
	expect(
		"with --kill they are removed, paused ones too",
		real.killed.sort().join() === [a, b].sort().join() &&
			real.failed.length === 0 &&
			/Killed 2 of the 2 sandboxes/.test(real.lines.at(-1) ?? ""),
	);
	expect(
		"sandboxes of another deployment, and those that are not the platform's, are left alone",
		w.fake.sandboxes.size === 2 && w.fake.sandboxes.has(foreign) && w.fake.sandboxes.has(bare),
	);
	const none = await cleanupDeployment(w.fake, "test", { kill: true });
	expect("with nothing left it says so", none.found.length === 0 && /has no sandboxes at E2B/.test(none.lines.join()));
});

await section("settings and prices", async () => {
	const defaults = readE2bSettings({});
	expect(
		"the defaults are the careful ones",
		defaults.maxRunning === 3 &&
			defaults.idleTimeoutMs === 2 * MINUTE &&
			defaults.turnLeaseMs === 3 * MINUTE &&
			defaults.maxRuntimeMs === 60 * MINUTE &&
			defaults.pause &&
			!defaults.windlassSandbox &&
			defaults.deployment === "default" &&
			defaults.templates.small.template === "windlass-platform-sandbox",
		JSON.stringify(defaults),
	);
	const set = readE2bSettings({
		WLP_E2B_MAX_RUNNING: "1",
		WLP_E2B_DEPLOYMENT: "prod-1",
		WLP_E2B_IDLE_TIMEOUT_MS: "60000",
		WLP_E2B_PAUSE: "0",
		WLP_E2B_WINDLASS_SANDBOX: "1",
		WLP_TURN_TIMEOUT_MS: "600000",
		WLP_E2B_WINDLASS_VERSION: "0.4.0+abc",
	});
	expect(
		"every one of them is read from the environment",
		set.maxRunning === 1 &&
			set.deployment === "prod-1" &&
			set.idleTimeoutMs === 60_000 &&
			!set.pause &&
			set.windlassSandbox &&
			set.turnLimitMs === 600_000 &&
			set.windlassVersion === "0.4.0+abc",
	);
	expect(
		"the turn limit is read as the server's own settings read it: the whole text as a number",
		readE2bSettings({ WLP_TURN_TIMEOUT_MS: "1e6" }).turnLimitMs === 1_000_000 &&
			readE2bSettings({ WLP_TURN_TIMEOUT_MS: " 90000 " }).turnLimitMs === 90_000,
	);
	const rejects = (env: NodeJS.ProcessEnv) => {
		try {
			readE2bSettings(env);
			return false;
		} catch {
			return true;
		}
	};
	expect(
		"a value that makes no sense is refused, not guessed at",
		rejects({ WLP_E2B_MAX_RUNNING: "0" }) &&
			rejects({ WLP_E2B_MAX_RUNNING: "many" }) &&
			rejects({ WLP_E2B_IDLE_TIMEOUT_MS: "5" }) &&
			rejects({ WLP_E2B_DEPLOYMENT: "a b" }) &&
			rejects({ WLP_E2B_PAUSE: "yes" }),
	);
	let noKey = "";
	try {
		readE2bKey({});
	} catch (error) {
		noKey = error instanceof Error ? error.message : String(error);
	}
	expect(
		"without E2B_API_KEY the provider refuses to be configured, and says what to set",
		/E2B_API_KEY is not set/.test(noKey),
		noKey,
	);
	let layerError = "";
	const saved = process.env.E2B_API_KEY;
	delete process.env.E2B_API_KEY;
	try {
		createE2bSandboxLayer({
			logins: {} as ChatgptLogins,
			tokens: { current: async () => ({ accessToken: "", expiresAt: 0 }) },
		});
	} catch (error) {
		layerError = error instanceof Error ? error.message : String(error);
	}
	if (saved !== undefined) process.env.E2B_API_KEY = saved;
	expect(
		"so a server configured for E2B without a key does not start as if it could run agents",
		/E2B_API_KEY is not set/.test(layerError),
	);
	const hour = estimatedCostUsd(3600, 1, 1024);
	expect(
		"an hour of the default sandbox is estimated at about 6.7 cents",
		Math.abs(hour - 0.0666) < 1e-9 &&
			describeUsage(3600, 1, 1024) === "3600 s at 1 vCPU and 1024 MiB, $0.0666 (estimated)",
		describeUsage(3600, 1, 1024),
	);
});

await section("hosted deployment settings", async () => {
	const defaults = readE2bSettings({});
	assert.deepEqual(defaults.sizes, ["small"]);
	assert.equal(defaults.turnLimitMs, 2_700_000);
	assert.equal(defaults.openProfile, false);
	assert.equal(defaults.windlassVersion, null);
	assert.equal(defaults.network.maxHosts, 64);
	assert.equal(defaults.snapshots, undefined);
	assert.deepEqual(readE2bSettings({ WLP_HOSTED_SNAPSHOTS: "on" }).snapshots, {
		maxTotal: 10,
		maxPerUser: 3,
		maxBytes: 4 * 2 ** 30,
		ttlMs: 1_209_600_000,
	});
	assert.deepEqual(defaults.rateCard, { usdPerVcpuSecond: 0.000014, usdPerGiBSecond: 0.0000045 });

	const settings = readE2bSettings({
		WLP_HOSTED_DEPLOYMENT: "prod-2",
		WLP_HOSTED_MAX_RUNNING: "1500",
		WLP_E2B_MAX_RUNNING: "9",
		WLP_HOSTED_IDLE_TIMEOUT_MS: "45000",
		WLP_HOSTED_TURN_LEASE_MS: "90000",
		WLP_HOSTED_MAX_CONTINUOUS_MS: "172800000",
		WLP_HOSTED_IDLE_ACTION: "destroy",
		WLP_HOSTED_INNER_SANDBOX: "1",
		WLP_HOSTED_OPEN_PROFILE: "1",
		WLP_HOSTED_WINDLASS_VERSION: "0.7.1",
		WLP_HOSTED_SIZES: "large,standard",
		WLP_HOSTED_NETWORK: "restricted",
		WLP_HOSTED_NETWORK_ALLOW: "repo.example",
		WLP_HOSTED_NETWORK_MAX_HOSTS: "3",
		WLP_HOSTED_SNAPSHOTS: "on",
		WLP_HOSTED_SNAPSHOT_MAX: "8",
		WLP_HOSTED_SNAPSHOT_USER_MAX: "2",
		WLP_HOSTED_SNAPSHOT_MAX_GIB: "1",
		WLP_HOSTED_SNAPSHOT_TTL_MS: "1000",
	});
	assert.equal(settings.deployment, "prod-2");
	assert.equal(settings.maxRunning, 1500);
	assert.equal(settings.idleTimeoutMs, 45000);
	assert.equal(settings.turnLeaseMs, 90000);
	assert.equal(settings.openProfile && settings.windlassSandbox, true);
	assert.equal(settings.windlassVersion, "0.7.1");
	assert.deepEqual(settings.snapshots, { maxTotal: 8, maxPerUser: 2, maxBytes: 2 ** 30, ttlMs: 1000 });
	assert.deepEqual(settings.network.hosts, ["api.openai.com", "github.com", "repo.example"]);
	assert.deepEqual(withHosts(settings.network, ["other.example"]).dropped, ["other.example"]);
	const { provider } = world(settings).sandboxes;
	assert.deepEqual(
		provider.sizes().map(size => size.id),
		["small", "standard", "large"],
	);
	assert.equal(settings.pause, false);
	assert.equal(settings.maxRuntimeMs, 172800000);
	assert.throws(() => readE2bSettings({ WLP_HOSTED_IDLE_ACTION: "stop" }), /IDLE_ACTION/);
	assert.throws(() => readE2bSettings({ WLP_HOSTED_SNAPSHOTS: "on", WLP_HOSTED_SNAPSHOT_TTL_MS: "0" }), /TTL_MS/);
	assert.throws(
		() => readE2bSettings({ WLP_HOSTED_NETWORK: "restricted", WLP_HOSTED_NETWORK_MAX_HOSTS: "1" }),
		/at most 1/,
	);
	assert.throws(() => buildShape({ WLP_E2B_CPU: "9" }, "small"), /WLP_E2B_CPU/);
	assert.throws(() => buildShape({ WLP_HOSTED_MAX_MEMORY_MIB: "4096" }, "large"), /MEMORY/);
	assert.deepEqual(buildShape({ WLP_HOSTED_MAX_VCPUS: "12", WLP_E2B_CPU: "12" }, "large"), {
		cpuCount: 12,
		memoryMB: 8192,
	});

	const file = join(mkdtempSync(join(tmpdir(), "wlp-rates-")), "rates.json");
	try {
		writeFileSync(file, JSON.stringify({ e2b: { microvm: { usdPerVcpuSecond: 0.001, usdPerGiBSecond: 0 } } }));
		const prices = world(readE2bSettings({ WLP_HOSTED_RATE_CARD_FILE: file })).sandboxes;
		assert.equal(prices.price().usdPerSecond, 0.001);
		assert.equal(prices.sizes()[0]?.usdPerHour, 3.6);
		writeFileSync(file, JSON.stringify({ e2b: { microvm: { usdPerVcpuSecond: -1 } } }));
		assert.throws(() => readE2bSettings({ WLP_HOSTED_RATE_CARD_FILE: file }), /RATE_CARD_FILE/);
	} finally {
		rmSync(dirname(file), { recursive: true, force: true });
	}

	// An account without per-sandbox filtering must refuse both the selection and a direct create.
	const unfiltered = Object.create(provider);
	Object.defineProperty(unfiltered, "supportsAllowList", { value: false });
	assert.throws(() => new HostedSandboxes(unfiltered), /cannot enforce/);
	Object.defineProperty(unfiltered, "network", { value: { mode: "open", hosts: [] } });
	const boxes = new HostedSandboxes(unfiltered);
	assert.deepEqual(
		boxes
			.profiles()
			.filter(p => p.available)
			.map(p => p.id),
		["e2b-open"],
	);
	await assert.rejects(boxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" }), /cannot enforce/);
	expect("hosted policy, rates, build bounds and account capabilities", true);
});

await section("network modes", async () => {
	const restrictedEnv = { WLP_E2B_NETWORK: "restricted" };
	const open = readE2bNetwork({});
	expect(
		"without WLP_E2B_NETWORK the deployment is open and nothing is listed",
		open.mode === "open" && open.hosts.length === 0 && networkConfig(open) === null,
	);
	const restricted = readE2bNetwork(restrictedEnv);
	expect(
		"restricted lists the model API, the git host and the default presets, sorted, each once",
		restricted.mode === "restricted" &&
			[
				"api.openai.com",
				"github.com",
				"registry.npmjs.org",
				"pypi.org",
				"files.pythonhosted.org",
				"objects.githubusercontent.com",
			].every(host => restricted.hosts.includes(host)) &&
			JSON.stringify(restricted.hosts) === JSON.stringify([...new Set(restricted.hosts)].sort()),
		restricted.hosts.join(","),
	);
	const bucketEnv = {
		WLP_BUCKET_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
		WLP_BUCKET_NAME: "memory",
		WLP_BUCKET_ACCESS_KEY_ID: "id",
		WLP_BUCKET_SECRET_ACCESS_KEY: "secret",
	};
	const withBucket = readE2bNetwork({
		...restrictedEnv,
		...bucketEnv,
		WLP_E2B_NETWORK_ALLOW: "@crates,git.example.org",
		WLP_GITHUB_URL: "https://ghe.example.com",
	});
	expect(
		"the bucket's host, the GitHub of WLP_GITHUB_URL and the operator's hosts are added; the default presets are replaced",
		["acct.r2.cloudflarestorage.com", "ghe.example.com", "crates.io", "git.example.org", "api.openai.com"].every(host =>
			withBucket.hosts.includes(host),
		) &&
			!withBucket.hosts.includes("registry.npmjs.org") &&
			!withBucket.hosts.includes("github.com"),
		withBucket.hosts.join(","),
	);
	const virtual = readE2bNetwork({ ...restrictedEnv, ...bucketEnv, WLP_BUCKET_STYLE: "virtual" });
	expect(
		"in virtual style the bucket's name comes before the endpoint's host, as in a signed link",
		virtual.hosts.includes("memory.acct.r2.cloudflarestorage.com"),
		virtual.hosts.join(","),
	);
	const none = readE2bNetwork({ WLP_E2B_NETWORK: "none", ...bucketEnv });
	expect(
		"none lists only the model API and the bucket: no git host, no presets",
		JSON.stringify(none.hosts) === JSON.stringify(["acct.r2.cloudflarestorage.com", "api.openai.com"]),
		none.hosts.join(","),
	);
	const config = networkConfig(restricted);
	expect(
		"E2B is asked to deny every destination, allow the names, and allow no DNS server",
		config !== null &&
			JSON.stringify(config.denyOut) === '["0.0.0.0/0"]' &&
			JSON.stringify(config.allowOut) === JSON.stringify(restricted.hosts) &&
			config.dnsServers.length === 0,
	);
	const refusal = (env: NodeJS.ProcessEnv) => {
		try {
			readE2bNetwork(env);
			return "";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	expect(
		"a wildcard, an address, a port or an unknown preset is refused",
		["*.example.com", "93.184.216.34", "example.com:8443", "@cargo", "localhost"].every(
			entry => refusal({ ...restrictedEnv, WLP_E2B_NETWORK_ALLOW: entry }) !== "",
		),
		refusal({ ...restrictedEnv, WLP_E2B_NETWORK_ALLOW: "*.example.com" }),
	);
	expect(
		"WLP_E2B_NETWORK_ALLOW without restricted is refused",
		/only with WLP_E2B_NETWORK=restricted/.test(
			refusal({ WLP_E2B_NETWORK: "none", WLP_E2B_NETWORK_ALLOW: "pypi.org" }),
		) && /only with/.test(refusal({ WLP_E2B_NETWORK_ALLOW: "pypi.org" })),
	);
	expect(
		"a git host or bucket E2B could not match by name (a port, plain http) stops the server",
		/WLP_GITHUB_URL/.test(refusal({ ...restrictedEnv, WLP_GITHUB_URL: "https://git.example.com:8443" })) &&
			/WLP_BUCKET_ENDPOINT/.test(
				refusal({ WLP_E2B_NETWORK: "none", ...bucketEnv, WLP_BUCKET_ENDPOINT: "http://minio.local:9000" }),
			),
	);
	expect("an unknown mode is refused", /open, restricted or none/.test(refusal({ WLP_E2B_NETWORK: "closed" })));
	expect(
		"readE2bSettings carries it",
		readE2bSettings({ WLP_E2B_NETWORK: "none" }).network?.mode === "none" &&
			readE2bSettings({}).network?.mode === "open",
	);

	// The provider, per mode, on the in-memory client.
	const opened = world();
	const openId = await opened.make();
	const openBox = opened.fake.sandboxes.get(openId);
	expect(
		"open: the sandbox is made without a network option and without a network mark, as before",
		openBox?.network === null &&
			!(META.network in (openBox?.metadata ?? {})) &&
			rootsBesidesHardening(opened.machines.get(openId)?.commands ?? []).length === 0,
	);
	await opened.sandboxes.connect(openId);
	expect("open: a connect asks nothing more of E2B", callsOf(opened.fake, "updateNetwork").length === 0);

	const w = world({ network: restricted });
	const id = await w.make();
	const box = w.fake.sandboxes.get(id);
	expect(
		"restricted: the sandbox is made with the deny-all configuration and its mark",
		JSON.stringify(box?.network) === JSON.stringify(config) && box?.metadata[META.network] === "restricted",
		JSON.stringify(box?.network),
	);
	const commands = w.machines.get(id)?.commands ?? [];
	const first = commands[1];
	expect(
		"restricted: before anything else runs in it, the guest is hardened and then the names are pinned as root, every allowed host and nothing else",
		hardening(commands[0] ?? { command: "" }) &&
			first !== undefined &&
			first.options.root === true &&
			first.command.includes("wlp-network") &&
			first.command.includes(" wlp-network restricted 1.1.1.1 ") &&
			restricted.hosts.every(host => first.command.includes(` ${host}`)) &&
			commands.findIndex(entry => entry.command.includes("git init")) > 0,
		first?.command.slice(0, 200),
	);
	expect(
		"restricted: no command of a session's runs as root",
		rootsBesidesHardening(commands).length === 1 && commands.filter(hardening).length === 1,
	);
	w.fake.calls.length = 0;
	await w.sandboxes.connect(id);
	const updates = callsOf(w.fake, "updateNetwork");
	expect(
		"restricted: each connect sets E2B's configuration again and pins the names again",
		updates.length === 1 &&
			updates[0] === `updateNetwork ${id} ${JSON.stringify(config)}` &&
			(w.machines.get(id)?.commands ?? [])
				.filter(entry => entry.options.root)
				.map(entry =>
					entry.command === "true"
						? "probe"
						: hardening(entry)
							? "hardening"
							: entry.command.includes("wlp-network")
								? "names"
								: entry.command,
				)
				.join() === "hardening,names,probe,names",
		updates.join(" | "),
	);
	await w.sandboxes.suspend(id);
	await w.sandboxes.connect(id);
	expect(
		"restricted: a resumed sandbox is set again too",
		callsOf(w.fake, "updateNetwork").length === 2 && w.fake.sandboxes.get(id)?.state === "running",
	);

	// The operator turns the deployment back to open: a kept sandbox is opened at its next connect.
	const reopened = e2bSandboxes(
		w.fake,
		{ ...SETTINGS, network: open },
		{ log: () => {}, now: () => w.clock.now, sleep: async () => {} },
	);
	w.fake.calls.length = 0;
	await reopened.connect(id);
	const roots = (w.machines.get(id)?.commands ?? []).filter(entry => entry.options.root);
	expect(
		"a mode change reaches a kept sandbox: open clears E2B's configuration and gives the resolver back",
		callsOf(w.fake, "updateNetwork").join() === `updateNetwork ${id} null` &&
			w.fake.sandboxes.get(id)?.network === null &&
			roots.at(-1)?.command.endsWith(" wlp-network open 1.1.1.1") === true,
		callsOf(w.fake, "updateNetwork").join(),
	);

	const n = world({ network: none });
	const noneId = await n.make();
	expect(
		"none: only the model API and the bucket are allowed",
		JSON.stringify(n.fake.sandboxes.get(noneId)?.network?.allowOut) === JSON.stringify(none.hosts),
	);
	expect(
		"the provider says its mode, for the launch's refusal and the factory",
		n.sandboxes.egress() === "none" && w.sandboxes.egress() === "restricted" && opened.sandboxes.egress() === "open",
	);
	expect(
		"a repository launch on hosted none is refused in a sentence fit to show",
		/WLP_E2B_NETWORK=none/.test(HOSTED_OFFLINE_REPOSITORY) && /without a repository/.test(HOSTED_OFFLINE_REPOSITORY),
	);

	const failing = world(
		{ network: restricted },
		{
			machine: () =>
				new ScriptedMachine(command =>
					command.includes("wlp-network")
						? { exitCode: 1, stderr: "read-only file system" }
						: command.includes("windlass --version")
							? { stdout: "Windlass 0.4.0 (linux-x64)\n" }
							: undefined,
				),
		},
	);
	let failed = "";
	await failing.make().catch((error: unknown) => (failed = error instanceof Error ? error.message : String(error)));
	expect(
		"a sandbox whose names cannot be pinned is removed, not handed out",
		/could not set the sandbox's names/.test(failed) &&
			/read-only file system/.test(failed) &&
			[...failing.fake.sandboxes.values()].length === 0,
		failed,
	);

	// A repository's network list (server/src/repository-network.ts): its hosts on top of the deployment's.
	let stubLog = "1795358136 1 cdn.example.org\n1795358136 28 registry.npmjs.org\n1795358136 1 registry.example.com\n";
	const readBytes: number[] = [];
	let failRead = false;
	let listed: ScriptedMachine | undefined;
	const order: string[] = [];
	const r = world(
		{ network: restricted },
		{
			machine: () =>
				(listed = imageLike(command => {
					if (command.includes("if=/var/log/wlp-dns.log")) {
						const offset = /skip=(\d+)/.exec(command)?.[1];
						if (!offset || failRead) return { exitCode: 1 };
						const stdout = stubLog.slice(Number(offset));
						readBytes.push(stdout.length);
						return { stdout };
					}
					if (command.includes(" wlp-network "))
						order.push(`names ${/ (first|second)\.example\.org/.exec(command)?.[1] ?? "-"}`);
					return undefined;
				})),
		},
	);
	const rid = await r.sandboxes.create({
		uid: "u1",
		sessionId: "s1",
		profile: "e2b",
		network: ["registry.example.com"],
	});
	const allowOut = r.fake.sandboxes.get(rid)?.network?.allowOut ?? [];
	expect(
		"a repository's hosts are allowed from the sandbox's first command, beside the deployment's",
		allowOut.includes("registry.example.com") &&
			restricted.hosts.every(host => allowOut.includes(host)) &&
			(rootsBesidesHardening(listed?.commands ?? [])[0]?.command.includes(" registry.example.com") ?? false),
		allowOut.join(","),
	);
	r.fake.calls.length = 0;
	const rHandle = await r.sandboxes.connect(rid, { network: ["registry.example.com"] });
	expect(
		"each connect sets them again, with the deployment's",
		callsOf(r.fake, "updateNetwork").length === 1 &&
			(callsOf(r.fake, "updateNetwork")[0] ?? "").includes("registry.example.com"),
	);
	await r.sandboxes.connect(rid);
	expect(
		"a connect that names none leaves the deployment's alone",
		!(callsOf(r.fake, "updateNetwork").at(-1) ?? "").includes("registry.example.com"),
	);
	expect(
		"blocked hosts: the names the lookup stub wrote that the sandbox may not reach",
		JSON.stringify(await rHandle?.blockedHosts?.()) === JSON.stringify(["cdn.example.org"]),
	);
	expect(
		"blocked hosts: names the caller has seen already are left out",
		JSON.stringify(await rHandle?.blockedHosts?.(["cdn.example.org"])) === "[]",
	);
	const initialBytes = stubLog.length;
	const partial = "1795358136 1 second.";
	stubLog += partial;
	expect(
		"a partial DNS line is held until complete",
		JSON.stringify(await rHandle?.blockedHosts?.(["cdn.example.org"])) === "[]",
	);
	stubLog += "example.org\n";
	failRead = true;
	await rHandle?.blockedHosts?.();
	failRead = false;
	expect(
		"a failed read retries from the last complete line and still supports replay",
		JSON.stringify(await rHandle?.blockedHosts?.()) === JSON.stringify(["cdn.example.org", "second.example.org"]),
	);
	expect(
		"idle and appended DNS reads transfer only new bytes",
		JSON.stringify(readBytes) ===
			JSON.stringify([initialBytes, 0, partial.length, partial.length + "example.org\n".length]),
	);
	r.fake.calls.length = 0;
	const unheld = await r.sandboxes.setNetwork(rid, ["registry.example.com", "cdn.example.org"]);
	expect(
		"outside a turn's hold a host allowed from a session changes nothing now: no connect, which would resume or extend the sandbox with no meter",
		!unheld && r.fake.calls.length === 0,
		r.fake.calls.join(" | "),
	);
	const release = await (rHandle as E2bSandboxHandle).holdForTurn();
	r.fake.calls.length = 0;
	const rootsBefore = (listed?.commands ?? []).filter(entry => entry.options.root).length;
	const applied = await r.sandboxes.setNetwork(rid, ["registry.example.com", "cdn.example.org"]);
	const roots2 = (listed?.commands ?? []).filter(entry => entry.options.root);
	expect(
		"a host allowed from a session while a turn holds its sandbox reaches it at once: E2B's configuration and the pinned names",
		applied &&
			(callsOf(r.fake, "updateNetwork")[0] ?? "").includes("cdn.example.org") &&
			roots2.length === rootsBefore + 1 &&
			(roots2.at(-1)?.command.includes(" cdn.example.org") ?? false),
	);
	// Two changes at once: each sets E2B's list and then the names file before the next starts, so both end on the same list.
	const realUpdate = r.fake.updateNetwork.bind(r.fake);
	r.fake.updateNetwork = async (sandboxId, network) => {
		order.push(
			`e2b ${network?.allowOut.includes("first.example.org") ? "first" : network?.allowOut.includes("second.example.org") ? "second" : "-"}`,
		);
		await new Promise(resolve => setTimeout(resolve, 20));
		return realUpdate(sandboxId, network);
	};
	order.length = 0;
	const both = await Promise.all([
		r.sandboxes.setNetwork(rid, ["first.example.org"]),
		r.sandboxes.connect(rid, { network: ["second.example.org"] }),
	]);
	r.fake.updateNetwork = realUpdate;
	expect(
		"a host allowed and a connect at once change the sandbox one after the other, so E2B's list and the names file end the same",
		both[0] === true &&
			both[1] !== undefined &&
			JSON.stringify(order) === JSON.stringify(["e2b first", "names first", "e2b second", "names second"]) &&
			(r.fake.sandboxes.get(rid)?.network?.allowOut.includes("second.example.org") ?? false),
		order.join(", "),
	);
	await release();
	await r.sandboxes.suspend(rid);
	r.fake.calls.length = 0;
	expect(
		"a paused sandbox is not started for it: it gets the hosts at its next connect",
		!(await r.sandboxes.setNetwork(rid, ["later.example.org"])) &&
			r.fake.sandboxes.get(rid)?.state === "paused" &&
			callsOf(r.fake, "updateNetwork").length === 0,
	);
	const openList = world();
	const openListId = await openList.make();
	const openHandle = await openList.sandboxes.connect(openListId, { network: ["registry.example.com"] });
	expect(
		"open: a repository's list changes nothing, reads no log, and a sandbox reaches every host anyway",
		openList.fake.sandboxes.get(openListId)?.network === null &&
			JSON.stringify(await openHandle?.blockedHosts?.()) === "[]" &&
			(await openList.sandboxes.setNetwork(openListId, ["x.example.org"])) &&
			callsOf(openList.fake, "updateNetwork").length === 0,
	);
	expect(
		"the provider names the deployment's own hosts, for a repository's settings",
		JSON.stringify(r.sandboxes.allowedHosts()) === JSON.stringify(restricted.hosts) &&
			openList.sandboxes.allowedHosts().length === 0,
	);

	// What the user reads.
	const facts = (mode: "open" | "restricted" | "none") =>
		profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: mode });
	const [plain, microvm] = ["e2b", "e2b-open"].map(
		profileId => facts("restricted").find(profile => profile.id === profileId)!,
	);
	expect(
		"restricted: the E2B profiles' facts and details say what commands reach",
		plain.commandNetwork &&
			plain.commandNetworkText === hostedNetworkText("restricted") &&
			/hosts its operator allows/.test(plain.details ?? "") &&
			/model API, GitHub and the hosts this deployment allows, and no other host/.test(microvm.details ?? "") &&
			microvm.commandNetworkText === hostedNetworkText("restricted"),
		microvm.details,
	);
	const noneOpen = facts("none").find(profile => profile.id === "e2b-open")!;
	expect(
		"none: commands are said to have no network but the model API",
		!noneOpen.commandNetwork &&
			noneOpen.commandNetworkText === "commands can reach only the model API" &&
			/cannot have a repository/.test(facts("none").find(profile => profile.id === "e2b")!.details ?? ""),
	);
	expect(
		"open: the facts are what they were",
		JSON.stringify(facts("open")) ===
			JSON.stringify(profilesFor("e2b", { windlassSandbox: false, openProfile: true })) &&
			facts("open").every(profile => profile.commandNetworkText === undefined),
	);
	const sandboxed = e2bProfile({ windlassSandbox: true, network: "restricted" });
	expect(
		"with Windlass's sandbox, sandboxed commands keep no network, and the details say what else the microVM reaches",
		!sandboxed.commandNetwork &&
			sandboxed.commandNetworkText === undefined &&
			/hosts its operator allows/.test(sandboxed.details ?? ""),
	);
	expect(
		"the provider lists its profiles with its mode",
		w.sandboxes.profile("e2b").commandNetworkText === hostedNetworkText("restricted"),
	);
	const reachOf = personalServerReach(facts("restricted"), "restricted").find(entry => entry.profile === "e2b")!;
	expect(
		"Settings says a server by address must be on an allowed host, and what a started one can reach",
		/must be one of them/.test(reachOf.address) && /only the network this deployment allows/.test(reachOf.command),
		reachOf.address,
	);
	expect(
		"and on open says what it said before",
		JSON.stringify(personalServerReach(facts("open"))) === JSON.stringify(personalServerReach(facts("open"), "open")),
	);

	const hostedTask = {
		key: "a",
		title: "Do a",
		brief: "b",
		acceptance: ["x"],
		dependsOn: [],
		owns: ["src/**"],
		budget: { tokens: 1000 },
		place: { prefer: "hosted", reason: "r" },
	};
	const placed = (hostedEgress?: "open" | "restricted" | "none") =>
		choosePlacement(
			hostedTask,
			{ preferred: { kind: "hosted" }, alternatives: [] },
			{ machines: [], hostedProfiles: ["e2b"], hostedEgress },
		);
	const [offline, limited] = [placed("none"), placed("restricted")];
	expect(
		"the factory places no repository work on hosted none, and places it on restricted",
		"refused" in offline && /no network for repositories/.test(offline.refused ?? "") && "decision" in limited,
		JSON.stringify(offline),
	);
	// A plan's cpus and memoryGiB pick the least hosted size that has them.
	const sized = (needs: { cpus?: number; memoryGiB?: number }, hostedSizes?: ("small" | "standard" | "large")[]) =>
		choosePlacement(
			{ ...hostedTask, needs },
			{ preferred: { kind: "hosted" }, alternatives: [] },
			{ machines: [], hostedProfiles: ["e2b"], hostedSizes },
		);
	const all = ["small", "standard", "large"] as ("small" | "standard" | "large")[];
	const [two, eight, plainTask, unsized, tooBig, notBuilt] = [
		sized({ cpus: 2 }, all),
		sized({ memoryGiB: 6 }, all),
		sized({}, all),
		sized({ cpus: 1 }),
		sized({ cpus: 16 }, all),
		sized({ memoryGiB: 8 }, ["small", "standard"]),
	];
	expect(
		"hosted takes cpus and memoryGiB as a size: the least that has them, none without them, and refuses what no offered size has",
		two.decision?.hostedSize === "standard" &&
			eight.decision?.hostedSize === "large" &&
			plainTask.decision !== undefined &&
			plainTask.decision.hostedSize === undefined &&
			unsized.decision !== undefined &&
			unsized.decision.hostedSize === undefined &&
			/at most 4 vCPU and 8 GiB/.test(tooBig.refused ?? "") &&
			/no Large sandbox/.test(notBuilt.refused ?? ""),
		JSON.stringify([two, eight, plainTask, unsized, tooBig, notBuilt]),
	);
});

await section("the template", async () => {
	// What E2B would be asked to build, from a context like the one sandbox/e2b/build.sh makes. Nothing is sent.
	const context = mkdtempSync(join(tmpdir(), "wlp-e2b-template-"));
	try {
		writeFileSync(join(context, "Dockerfile"), readFileSync(join(root, "sandbox/Dockerfile"), "utf8"));
		writeFileSync(join(context, "wlp-run"), readFileSync(join(root, "sandbox/wlp-run"), "utf8"));
		writeFileSync(join(context, "wlp-pnpm"), readFileSync(join(root, "sandbox/wlp-pnpm"), "utf8"));
		writeFileSync(join(context, "wlp-shot"), readFileSync(join(root, "sandbox/wlp-shot"), "utf8"));
		writeFileSync(join(context, "windlass"), "not a real binary\n");
		const text = describeTemplate(context);
		const shots = describeTemplate(context, true);
		const lines = text.split("\n");
		expect(
			"the template is the Docker image's Dockerfile: Ubuntu 24.04, the same packages",
			/^FROM ubuntu:24\.04/m.test(text) && /bubblewrap git ripgrep/.test(text),
			lines[0],
		);
		expect(
			"it has the user agent, the workspace and Windlass's data directory",
			/useradd --create-home --uid 1000 --shell \/bin\/bash agent/.test(text) &&
				/mkdir -p \/workspace \/home\/agent\/\.local\/share\/windlass/.test(text),
		);
		expect(
			"the base installs Windlass and wlp-run without a browser",
			/COPY .*windlass \/usr\/local\/bin\/windlass/.test(text) &&
				/COPY .*wlp-run \/usr\/local\/bin\/wlp-run/.test(text) &&
				!/playwright-core|wlp-shot|headless.shell/i.test(text),
			lines.filter(line => line.startsWith("COPY")).join(" | "),
		);
		expect(
			"the screenshots template adds the pinned browser, fonts, driver and helper",
			["HEADLESS_SHELL_ARM64_SHA256", "fonts-liberation", "playwright-core", "/usr/local/bin/wlp-shot"].every(word =>
				shots.includes(word),
			) && shots.includes("COPY windlass /usr/local/bin/windlass"),
		);
		const users = lines.filter(line => /^USER /.test(line));
		const workdirs = lines.filter(line => /^WORKDIR /.test(line));
		expect(
			"commands run as agent in /workspace by default",
			users.at(-1) === "USER agent" && workdirs.at(-1) === "WORKDIR /workspace",
			`${users.at(-1)} | ${workdirs.at(-1)}`,
		);
		expect("the line that only keeps a container alive is left out", !/sleep/.test(text));
		const step = /^RUN echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(
			lines.filter(line => line.startsWith("RUN ")).at(-1) ?? "",
		);
		expect(
			"its last step hardens the guest after E2B's provisioning: the provider's script, run as root",
			step !== null && Buffer.from(step[1], "base64").toString("utf8") === GUEST_HARDENING_SCRIPT,
			lines
				.filter(line => line.startsWith("RUN "))
				.at(-1)
				?.slice(0, 80),
		);
	} finally {
		rmSync(context, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------------------------
// A real turn: the fake client's sandboxes are containers of the sandbox image
// ---------------------------------------------------------------------------------------------

/** The stand-in of E2B's egress filter (scripts/e2b-network-standin.mjs) while the network checks run: sandboxes are made on its network. */
let standIn: { network: string; container: string; address: string; ca: string; dir: string } | null = null;

/** A fake sandbox whose commands run in a container, each started the way E2B starts one: a login shell that is given the command as one string. */
class ContainerMachine implements FakeMachine {
	private constructor(readonly container: string) {}

	static async make(id: string, image: string): Promise<ContainerMachine> {
		const name = `wlp-e2bfake-${run}-${id.slice(0, 12)}`;
		// As a session container of the first Docker profile, where bubblewrap works, but on a disk of its own (no
		// volume) and with no network at all: nothing these turns do needs one. The network checks put it on the
		// stand-in's internal network instead, where the filter is the only way anywhere, as E2B's is for a microVM.
		// Stand in for the VM supervisor, which runs outside the agent UID. start() selects agent explicitly.
		const flags = [
			"--init",
			"--user",
			"root",
			"--security-opt",
			"no-new-privileges",
			"--cap-drop",
			"ALL",
			"--network",
			standIn?.network ?? "none",
			"--memory",
			"1024m",
			"--memory-swap",
			"1024m",
			"--cpus",
			"1",
			"--pids-limit",
			"512",
			"--hostname",
			"sandbox",
			...(PROFILE_RUN_FLAGS["docker-windlass-sandbox"] ?? []),
		];
		await docker(["run", "-d", "--pull", "never", "--name", name, "--label", LABEL_ARG, ...flags, image], {
			timeoutMs: 120_000,
			check: true,
		});
		if (standIn !== null) {
			// What a microVM has from E2B: a resolver (8.8.8.8 there, the stand-in's here) and trust in the hosts it reaches.
			await docker(
				[
					"exec",
					"-i",
					"-u",
					"root",
					name,
					"sh",
					"-ec",
					'echo "nameserver $1" > /etc/resolv.conf; cat > /usr/local/share/ca-certificates/wlp-fixture.crt; update-ca-certificates >/dev/null 2>&1',
					"sh",
					standIn.address,
				],
				{ stdin: standIn.ca, check: true },
			);
		}
		return new ContainerMachine(name);
	}

	/** E2B's configuration for this sandbox, handed to the stand-in's filter by the sandbox's address. */
	async network(config: E2bNetworkConfig | null): Promise<void> {
		if (standIn === null) return;
		const address = (
			await docker(
				["inspect", "-f", `{{(index .NetworkSettings.Networks "${standIn.network}").IPAddress}}`, this.container],
				{ check: true },
			)
		).stdout.trim();
		await docker(
			[
				"exec",
				"-i",
				standIn.container,
				"sh",
				"-ec",
				'mkdir -p /tmp/policies; cat > "/tmp/policies/$1.json"',
				"sh",
				address,
			],
			{ stdin: JSON.stringify(config), check: true },
		);
	}

	async start(command: string, options: E2bCommandOptions): Promise<E2bCommand> {
		const envs = Object.entries(options.envs ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
		const child: ChildProcess = spawn(
			"docker",
			[
				"exec",
				...(options.stdin ? ["-i"] : []),
				"-u",
				options.root ? "root" : options.gitUser ? "nobody" : "agent",
				"-w",
				options.cwd,
				...envs,
				this.container,
				"bash",
				"-l",
				"-c",
				command,
			],
			{ stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] },
		);
		child.stdout?.setEncoding("utf8").on("data", (text: string) => options.onStdout?.(text));
		child.stderr?.setEncoding("utf8").on("data", (text: string) => options.onStderr?.(text));
		child.stdin?.on("error", () => undefined);
		const done = new Promise<{ exitCode: number; error?: string }>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", (code, signal) =>
				signal !== null ? reject(new Error("the stream to the command was cut")) : resolve({ exitCode: code ?? -1 }),
			);
		});
		done.catch(() => undefined);
		return {
			pid: child.pid ?? 0,
			sendStdin: data =>
				new Promise<void>((resolve, reject) => child.stdin?.write(data, error => (error ? reject(error) : resolve()))),
			closeStdin: async () => void child.stdin?.end(),
			wait: () => done,
			// As E2B's: this side stops listening, the command goes on in the sandbox.
			disconnect: async () => void child.kill("SIGKILL"),
			kill: async () => void child.kill("SIGKILL"),
		};
	}

	async readFile(path: string): Promise<string> {
		const result = await docker(["exec", "-u", "agent", this.container, "cat", "--", path]);
		if (result.code !== 0) throw new Error(result.stderr.trim());
		return result.stdout;
	}

	async writeFile(path: string, content: string): Promise<void> {
		await docker(
			[
				"exec",
				"-i",
				"-u",
				"agent",
				this.container,
				"sh",
				"-c",
				'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"',
				"sh",
				path,
			],
			{ stdin: content, check: true },
		);
	}

	async paused(): Promise<void> {
		await docker(["pause", this.container]);
	}
	async resumed(): Promise<void> {
		await docker(["unpause", this.container]);
	}
	async killed(): Promise<void> {
		await docker(["rm", "-f", "-v", this.container]);
	}
}

async function stray(container: string): Promise<string[]> {
	const result = await docker(["exec", container, "ps", "-eo", "pid=,args="]);
	return result.stdout
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "" && !/^1 /.test(line) && !/ sleep infinity$/.test(line) && !/ ps -eo/.test(line));
}

type Response = ScriptedModel["responses"][number];
const say = (text: string): Response => [
	{ type: "text", text },
	{ type: "finish", reason: "stop" },
];
const shell = (callId: string, command: string): Response => [
	{ type: "tool_call", callId, name: "shell", input: { command } },
	{ type: "finish", reason: "tool_calls" },
];
const TOKEN = "FAKE-ACCESS-TOKEN-E2B-TEST-not-a-real-token";

if (withDocker) {
	if (!networkOnly)
		await section("a real turn", async () => {
			const image = await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE]);
			if (image.code !== 0) {
				expect(`the sandbox image ${IMAGE} is here`, false, "build it with sandbox/build.sh");
				return;
			}
			const machines = new Map<string, ContainerMachine>();
			const fake = new FakeE2b({
				machine: async id => {
					const machine = await ContainerMachine.make(id, image.stdout.trim());
					machines.set(id, machine);
					return machine;
				},
			});
			const lines: string[] = [];
			let asked = 0;
			const tokens: AccessTokens = {
				current: async () => (asked++, { accessToken: TOKEN, expiresAt: Date.now() + 3_600_000 }),
			};
			const settings: E2bSettings = {
				...SETTINGS,
				deployment: `test-${run}`,
				turnLeaseMs: 3_000,
				idleTimeoutMs: 10 * MINUTE,
			};
			const layer = createE2bSandboxLayer(
				{ logins: { logout: async () => undefined } as unknown as ChatgptLogins, tokens },
				{ client: fake, settings, log: line => lines.push(line) },
			);
			const turn = async (
				handle: E2bSandboxHandle,
				prompt: string,
				script: ScriptedModel | undefined,
				extra: { windlassSessionId?: string; windlass?: typeof layer.windlass } = {},
			) => {
				const events: WindlassEvent[] = [];
				const questions: TurnQuestion[] = [];
				const result: RunTurnResult = await (extra.windlass ?? layer.windlass).runTurn(handle, {
					prompt,
					script,
					windlassSessionId: extra.windlassSessionId,
					onEvent: event => events.push(event),
					// Whatever Windlass asks about is allowed once: the turns here run what this file wrote.
					onQuestion: async question => (
						questions.push(question),
						{ choice: question.choices.find(choice => choice.approve)?.id ?? question.choices[0]?.id ?? "" }
					),
				});
				return { result, events, questions, outcome: (result.summary as { outcome?: string } | null)?.outcome };
			};
			try {
				const id = await layer.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
				const container = machines.get(id)!.container;
				const handle = (await layer.sandboxes.connect(id)) as E2bSandboxHandle;
				const version = await layer.windlass.version();
				const log = await handle.run(
					"git log --oneline | wc -l; git status --short | wc -l; whoami; pwd; echo $LANG $NO_COLOR",
				);
				expect(
					"a new sandbox has an empty git repository in /workspace, and commands run as agent with the image's environment",
					log.exitCode === 0 && log.stdout.trim().split(/\s+/).join(" ") === "1 0 agent /workspace C.UTF-8 1",
					log.stdout.trim(),
				);
				expect(
					"the Windlass version is known once a sandbox was made",
					version !== null && /^\d+\.\d+\.\d+/.test(version),
					String(version),
				);
				const isolated = await handle.run('id -u; pwd; test -z "${GIT_CONFIG_COUNT-}"', {
					gitUser: true,
					cwd: "/workspace",
					env: { GIT_CONFIG_COUNT: "1" },
				});
				expect(
					"Git transport selects the separate uid and clean environment through the E2B command adapter",
					isolated.exitCode === 0 && isolated.stdout === "65534\n/\n",
					isolated.stdout.trim(),
				);
				const odd = ["a b", "it's", "$HOME", 'x"y', "`uname`", "", "é✓", "a\nb", "*", "~", "; echo no"];
				const echoed = await handle.exec(["printf", "[%s]", ...odd]);
				expect(
					"every argument arrives as it was given, whatever is in it",
					echoed.exitCode === 0 && echoed.stdout === odd.map(item => `[${item}]`).join(""),
					echoed.stdout,
				);
				const mixed = await handle.run('cat; echo "to stderr" >&2; echo "$ODD"; exit 3', {
					stdin: "from stdin\n",
					env: { ODD: 'it\'s $x "y"' },
				});
				expect(
					"standard input, both outputs, the environment and the exit code come through",
					mixed.exitCode === 3 && mixed.stdout === 'from stdin\nit\'s $x "y"\n' && mixed.stderr === "to stderr\n",
					JSON.stringify(mixed),
				);

				const controller = new AbortController();
				const began = Date.now();
				const stopping = handle.run("sleep 60 & sleep 60", { signal: controller.signal });
				setTimeout(() => controller.abort(), 700);
				const stopped = await stopping;
				expect(
					"an abort stops the command inside the sandbox, and what it started",
					stopped.aborted &&
						stopped.exitCode === null &&
						Date.now() - began < 8_000 &&
						(await stray(container)).length === 0,
					`${Date.now() - began} ms, ${(await stray(container)).join(" ; ")}`,
				);
				const late = await handle.run("sleep 60", { timeoutMs: 700 });
				expect("so does a timeout", late.timedOut && late.exitCode === null && (await stray(container)).length === 0);

				const secret = `${DATA_DIR}/secret-test.json`;
				await handle.writeSecretFile(secret, `{"accessToken":"${TOKEN}"}`);
				const facts = await handle.run(
					`stat -c '%a %U' ${secret}; cat ${secret} | wc -c; ls ${DATA_DIR} | grep -c tmp`,
				);
				expect(
					"a secret file is written whole, readable by its owner only, with nothing left beside it",
					facts.stdout.trim().split(/\s+/).join(" ") === `600 agent ${`{"accessToken":"${TOKEN}"}`.length} 0`,
					facts.stdout.trim(),
				);
				await handle.removeFiles([secret]);
				expect("and removed again", (await handle.run(`ls ${secret}`)).exitCode !== 0);

				// A scripted turn through turn.ts: Windlass's real engine and real tool calls, a scripted model.
				fake.calls.length = 0;
				const first = await turn(handle, "Write a file and run it", {
					responses: [
						shell("w", "printf 'echo from-the-script\\n' > hello.sh && sh hello.sh"),
						shell("s", "sleep 4; cat hello.sh | wc -l"),
						say("Done."),
					],
				});
				const tools = first.events
					.filter(event => event.type === "tool.settled")
					.map(event => String((event.data as { output?: unknown } | undefined)?.output ?? ""));
				expect(
					"a scripted turn runs to its end through the E2B provider: events, tool output, the summary",
					first.outcome === "succeeded" &&
						first.result.exitCode === 0 &&
						first.result.failure === null &&
						!first.result.aborted &&
						tools.some(output => output.includes("from-the-script")) &&
						first.events.at(-1)?.type === "cli.summary",
					`${first.outcome}, exit ${first.result.exitCode}, ${first.events.length} events, ${first.questions.length} question(s), ${first.result.failure?.message ?? ""} ${first.result.stderrTail}`,
				);
				const pushes = fake.calls.filter(call => call.startsWith(`setTimeout ${id} `));
				expect(
					"while it ran the sandbox's timeout was pushed out, and set back to the short one at the end",
					pushes.length >= 3 &&
						pushes[0] === `setTimeout ${id} 3000` &&
						pushes.at(-1) === `setTimeout ${id} ${10 * MINUTE}` &&
						pushes.slice(0, -1).every(call => call === `setTimeout ${id} 3000`),
					`${pushes.length} calls`,
				);
				expect(
					"a scripted turn is handed no access token",
					asked === 0 && !(await handle.run(`ls ${DATA_DIR}`)).stdout.includes("access-token"),
				);
				expect(
					"it leaves no process and no script file in the sandbox",
					(await stray(container)).length === 0 &&
						(await handle.run("ls /tmp/.wlp-script-* 2>/dev/null | wc -l")).stdout.trim() === "0",
					(await stray(container)).join(" ; "),
				);
				const session = first.result.windlassSessionId;
				const second = await turn(
					handle,
					"And again",
					{ responses: [shell("c", "cat hello.sh"), say("Still there.")] },
					{ windlassSessionId: session ?? undefined },
				);
				expect(
					"the next turn continues the same Windlass session: its data directory is on the sandbox's disk",
					session !== null && second.outcome === "succeeded" && second.result.windlassSessionId === session,
					`${session} -> ${second.result.windlassSessionId}, ${second.result.failure?.message ?? ""}`,
				);

				for (const restart of [true, false]) {
					const controller = new AbortController();
					const events: WindlassEvent[] = [];
					const end = await layer.windlass.runTurn(handle, {
						prompt: "Print ready and wait.",
						signal: controller.signal,
						script: { responses: [shell("wait", "echo ready; sleep 20; echo finished"), say("Done.")] },
						onEvent(event) {
							events.push(event);
							if (event.type === "tool.progress" && String(event.text).includes("ready"))
								controller.abort(restart ? PLATFORM_RESTART : undefined);
						},
					});
					const settled = events.find(e => e.type === "tool.settled");
					const reason = (settled?.data?.display as { interrupted?: string } | undefined)?.interrupted;
					expect(
						restart
							? "restart closes Windlass as a shutdown and preserves partial shell output"
							: "an explicit Stop still records a user interruption",
						end.aborted &&
							reason === (restart ? "shutdown" : "user") &&
							!!settled &&
							(restart
								? String(restartShellResult(settled).data?.output).includes("ready\n" + RESTARTED_COMMAND)
								: String(settled.data?.output).includes("Interrupted by the user")),
						JSON.stringify(settled?.data),
					);
					if (restart && end.windlassSessionId) {
						const next = await turn(
							handle,
							resumePrompt("restart", [], true),
							{ responses: [say("Resumed.")] },
							{ windlassSessionId: end.windlassSessionId },
						);
						expect(
							"the suspended execution accepts the next prompt in the same session",
							next.outcome === "succeeded" && next.result.windlassSessionId === end.windlassSessionId,
							next.result.stderrTail,
						);
					}
				}

				// Suspend, resume: E2B keeps the disk; here the container is paused and unpaused.
				await layer.sandboxes.suspend(id);
				const pausedState = await docker(["container", "inspect", "--format", "{{.State.Status}}", container]);
				expect(
					"suspend pauses the sandbox",
					(await layer.sandboxes.state(id)) === "paused" && pausedState.stdout.trim() === "paused",
				);
				const again = (await layer.sandboxes.connect(id)) as E2bSandboxHandle;
				const third = await turn(
					again,
					"After the pause",
					{ responses: [shell("c", "cat hello.sh"), say("Still there.")] },
					{ windlassSessionId: session ?? undefined },
				);
				expect(
					"after a resume the files and the Windlass session are there",
					third.outcome === "succeeded" &&
						third.result.windlassSessionId === session &&
						third.events.some(
							event =>
								event.type === "tool.settled" &&
								String((event.data as { output?: unknown } | undefined)?.output ?? "").includes("from-the-script"),
						),
				);

				// The sandbox is gone: a new one has no Windlass session to continue.
				await layer.sandboxes.destroy(id);
				const exists = await docker(["container", "inspect", container]);
				expect(
					"destroy removes the sandbox",
					exists.code !== 0 &&
						(await layer.sandboxes.state(id)) === "none" &&
						(await layer.sandboxes.connect(id)) === undefined,
				);
				const fresh = await layer.sandboxes.create({ uid: "u1", sessionId: "s1", profile: "e2b" });
				const freshHandle = (await layer.sandboxes.connect(fresh)) as E2bSandboxHandle;
				const orphan = await turn(
					freshHandle,
					"Go on",
					{ responses: [say("Hello.")] },
					{ windlassSessionId: session ?? undefined },
				);
				expect(
					"a sandbox made in place of one that is gone has no Windlass session to continue: the turn ends with session_not_found",
					orphan.result.failure?.reason === "session_not_found" &&
						orphan.events.length === 0 &&
						layer.sandboxes.sessionsLiveInSandbox,
					`${orphan.result.failure?.reason}: ${orphan.result.failure?.message}`,
				);
				const restart = await turn(freshHandle, "Start again", { responses: [say("Hello.")] });
				expect(
					"and a turn that names none starts a new one there",
					restart.outcome === "succeeded" &&
						restart.result.windlassSessionId !== null &&
						restart.result.windlassSessionId !== session,
				);
				await layer.sandboxes.destroy(fresh);
				expect(
					"every line the provider logged about cost calls it an estimate, and none holds a token",
					lines.filter(line => /\$\d/.test(line)).every(line => line.includes("(estimated)")) &&
						lines.filter(line => /\$\d/.test(line)).length >= 3 &&
						!lines.join("\n").includes(TOKEN),
				);
			} finally {
				for (const machine of machines.values())
					await docker(["rm", "-f", "-v", machine.container]).catch(() => undefined);
				const left = await docker(["ps", "-a", "--filter", `name=^wlp-e2bfake-${run}-`, "--format", "{{.Names}}"]);
				expect("every container this test started is removed", left.stdout.trim() === "", left.stdout.trim());
			}
		});
	await section("network modes through a stand-in of E2B's filter", async () => {
		const image = (await docker(["image", "inspect", "--format", "{{.Id}}", IMAGE])).stdout.trim();
		if (image === "") {
			expect(`the sandbox image ${IMAGE} is here`, false, "build it with sandbox/build.sh");
			return;
		}
		const dir = mkdtempSync(join(tmpdir(), "wlp-e2b-net-"));
		const names = ["github.com", "api.openai.com", "acct.r2.example", "evil.example", "registry.npmjs.org"];
		const ssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
		ssl(
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			"ca.key",
			"-out",
			"ca.crt",
			"-subj",
			"/CN=wlp-fixture-ca",
			"-days",
			"1",
		);
		ssl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=fixture");
		writeFileSync(join(dir, "ext"), `subjectAltName=${names.map(name => `DNS:${name}`).join(",")}\n`);
		ssl(
			"x509",
			"-req",
			"-in",
			"leaf.csr",
			"-CA",
			"ca.crt",
			"-CAkey",
			"ca.key",
			"-CAcreateserial",
			"-out",
			"leaf.crt",
			"-days",
			"1",
			"-extfile",
			"ext",
		);
		execFileSync("chmod", ["-R", "a+rX", dir]);
		const network = `wlp-e2bfake-${run}-net`;
		const container = `wlp-e2bfake-${run}-filter`;
		const machines: ContainerMachine[] = [];
		try {
			await docker(["network", "create", "--internal", "--label", LABEL_ARG, network], { check: true });
			const source = readFileSync(join(root, "scripts/e2b-network-standin.mjs"), "utf8");
			const setup = [
				"cd /tmp && mkdir -p cgi-bin git/acme",
				"git init -q --bare git/acme/demo.git && git -C git/acme/demo.git config http.receivepack true",
				"git init -q seed && git -C seed -c user.name=f -c user.email=f@example.invalid commit -q --allow-empty -m seed && git -C seed push -q /tmp/git/acme/demo.git HEAD:refs/heads/main",
				"printf '%s\\n' '#!/bin/sh' 'export GIT_PROJECT_ROOT=/tmp/git GIT_HTTP_EXPORT_ALL=1' 'exec git http-backend' > cgi-bin/git && chmod +x cgi-bin/git",
				"python3 -m http.server --cgi --bind 127.0.0.1 8081 >/dev/null 2>&1 &",
				'exec node --input-type=module -e "$WLP_STANDIN" -- wlp-e2b-standin "$(hostname -i | cut -d" " -f1)" /fixture/leaf.key /fixture/leaf.crt',
			].join("\n");
			await docker(
				[
					"run",
					"-d",
					"--pull",
					"never",
					"--name",
					container,
					"--label",
					LABEL_ARG,
					"--network",
					network,
					"--user",
					"agent",
					"--sysctl",
					"net.ipv4.ip_unprivileged_port_start=0",
					"--cap-drop",
					"ALL",
					"--security-opt",
					"no-new-privileges",
					"-e",
					`WLP_STANDIN=${source}`,
					"-v",
					`${dir}:/fixture:ro`,
					image,
					"bash",
					"-ec",
					setup,
				],
				{ timeoutMs: 120_000, check: true },
			);
			for (let tries = 0; !(await docker(["logs", container])).stdout.includes("standin ready"); tries += 1) {
				if (tries > 100)
					throw new Error(`the stand-in did not start: ${(await docker(["logs", container])).stderr.slice(-500)}`);
				await sleep(100);
			}
			const address = (
				await docker(["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, container], {
					check: true,
				})
			).stdout.trim();
			standIn = { network, container, address, ca: readFileSync(join(dir, "ca.crt"), "utf8"), dir };
			const bucket = {
				WLP_BUCKET_ENDPOINT: "https://acct.r2.example",
				WLP_BUCKET_NAME: "memory",
				WLP_BUCKET_ACCESS_KEY_ID: "id",
				WLP_BUCKET_SECRET_ACCESS_KEY: "secret",
			};
			const url = "https://github.com/acme/demo.git";
			for (const mode of ["open", "restricted", "none"] as const) {
				const fake = new FakeE2b({
					machine: async id => {
						const machine = await ContainerMachine.make(id, image);
						machines.push(machine);
						return machine;
					},
				});
				const deploymentNetwork = readE2bNetwork({ ...bucket, ...(mode === "open" ? {} : { WLP_E2B_NETWORK: mode }) });
				const sandboxes = e2bSandboxes(
					fake,
					{ ...SETTINGS, deployment: `test-${run}`, idleTimeoutMs: 10 * MINUTE, network: deploymentNetwork },
					{ log: () => {}, pinAddress: address },
				);
				// A repository's list adds a host in restricted; open and none take no list. The fixture certificate does not name these hosts: -k, since what is checked is whether the filter lets them through.
				const repoHosts = ["repo-allowed.example"];
				const id = await sandboxes.create({ uid: "u1", sessionId: `net-${mode}`, profile: "e2b", network: repoHosts });
				const handle = (await sandboxes.connect(id, { network: repoHosts })) as E2bSandboxHandle;
				const sh = async (script: string) => {
					const result = await handle.exec(["sh", "-c", script], { timeoutMs: 60_000 });
					return `${result.stdout}${result.stderr}`.trim();
				};
				// The platform's own steps, with its own code: clone, fetch and push as the transport user.
				const cloned = await cloneWithToken(handle, "fixture-token", { url, branch: "main", directory: "demo" });
				let pushed = "";
				let received = "";
				if (cloned.ok) {
					const fetched = await fetchWithToken(handle, "fixture-token", { url, base: "main" });
					await sh("echo network > proof.txt");
					const branch = `windlass/net-${mode}`;
					const committed = await commitWork(
						handle,
						{
							branch,
							baseSha: fetched.marks.get("base") ?? null,
							sessionId: `net-${mode}`,
							pushed: null,
							author: { name: "Fixture", email: "test@example.invalid" },
						},
						"Fixture commit",
					);
					try {
						if (committed.ok && (await outgoingPatch(handle, committed.attempt)) !== null)
							pushed =
								(await pushWithToken(handle, "fixture-token", { attempt: committed.attempt, url, branch })).marks.get(
									"pushed",
								) ?? "";
					} finally {
						await discardHandover(handle, committed.attempt);
					}
					received = (
						await docker([
							"exec",
							container,
							"git",
							"-C",
							"/tmp/git/acme/demo.git",
							"rev-parse",
							"--verify",
							"-q",
							`refs/heads/${branch}`,
						])
					).stdout.trim();
				}
				// The engine's model requests and the bucket's signed links, as the agent's user sends them; then what a command could try.
				const model = await sh(
					"curl -sS --max-time 10 -o /dev/null -w '%{http_code}' https://api.openai.com/v1/models",
				);
				const upload = await sh(
					"curl -sS --max-time 10 -X PUT --data-binary memory -o /dev/null -w '%{http_code}' 'https://acct.r2.example/memory/u1/net?X-Amz-Signature=fixture'",
				);
				const other = await sh("curl -sS --max-time 10 https://evil.example/; echo exit=$?");
				const direct = await sh(
					`curl -sS --max-time 10 --resolve evil.example:443:${address} https://evil.example/; echo exit=$?`,
				);
				const plain = await sh(
					`curl -sS --max-time 10 --resolve evil.example:80:${address} http://evil.example/; echo exit=$?`,
				);
				const lookup = await sh("getent hosts evil.example; echo exit=$?");
				const said = `clone ${cloned.ok ? "ok" : cloned.failure} | model ${model} | upload ${upload} | other ${other} | direct ${direct} | lookup ${lookup}`;
				if (mode === "open") {
					expect(
						"open: the platform clones and pushes, as before",
						cloned.ok && pushed !== "" && pushed === received,
						said,
					);
					expect(
						"open: every host is reachable, as before",
						model === "401" && upload === "200" && other.includes("fixture evil.example") && /exit=0/.test(lookup),
						said,
					);
				} else {
					expect(
						`${mode}: the model API and the bucket are reachable from the agent's user`,
						model === "401" && upload === "200",
						said,
					);
					expect(
						`${mode}: a command reaches no other host, by name, by address or over plain HTTP`,
						!other.includes("fixture") &&
							/exit=[1-9]/.test(other) &&
							!direct.includes("fixture") &&
							/exit=[1-9]/.test(direct) &&
							!plain.includes("fixture") &&
							/exit=[1-9]/.test(plain),
						said,
					);
					expect(
						`${mode}: an unlisted name does not resolve, and the only resolver is the sandbox's own lookup stub`,
						/exit=[1-9]/.test(lookup) &&
							(await sh("grep nameserver /etc/resolv.conf || true")) === "nameserver 127.0.0.1",
						said,
					);
					const blocked = await handle.blockedHosts();
					expect(
						`${mode}: the lookup stub names the host a command could not reach, and none it may`,
						blocked.includes("evil.example") &&
							!blocked.includes("api.openai.com") &&
							!blocked.includes("repo-allowed.example"),
						blocked.join(","),
					);
					const byRepo = await sh("curl -ksS --max-time 10 https://repo-allowed.example/; echo exit=$?");
					if (mode === "restricted") {
						expect(
							"restricted: a host of the repository's list is reachable",
							byRepo.includes("fixture repo-allowed.example"),
							byRepo,
						);
						const before = await sh("curl -ksS --max-time 10 https://later.example/; echo exit=$?");
						const release = await handle.holdForTurn();
						try {
							const changed = await sandboxes.setNetwork(id, [...repoHosts, "later.example"]);
							const after = await sh("curl -ksS --max-time 10 https://later.example/; echo exit=$?");
							expect(
								"restricted: a host allowed while a turn holds the sandbox is reachable at once, and was not before",
								!before.includes("fixture") && changed && after.includes("fixture later.example"),
								`${before} | ${after}`,
							);
							// Two changes at once, through the provider: they run one after the other, and the last one's list is what E2B and the names file have.
							const pinned = async () =>
								(await sh("grep ' # wlp-network$' /etc/hosts | cut -d' ' -f2 | sort | tr '\\n' ' '")).trim();
							const lists = [
								[...repoHosts, "race-a.example"],
								[...repoHosts, "race-b.example"],
							];
							const changes = await Promise.all(lists.map(list => sandboxes.setNetwork(id, list)));
							const last = fake.sandboxes.get(id)?.network?.allowOut;
							const expected = [...withHosts(deploymentNetwork, lists[1]).network.hosts].sort().join(" ");
							const hosts = await sh("cat /etc/hosts");
							expect(
								"restricted: two changes at once end with the last one's list, in E2B's configuration and in the names file, and localhost stays",
								changes.every(Boolean) &&
									(await pinned()) === expected &&
									JSON.stringify(last) === JSON.stringify(withHosts(deploymentNetwork, lists[1]).network.hosts) &&
									/^127\.0\.0\.1\s+localhost/m.test(hosts),
								`${await pinned()} | ${JSON.stringify(last)} | ${hosts}`,
							);
						} finally {
							await release();
						}
						// The guest script itself, run four at a time as root again and again, as two servers could: its lock keeps the names file whole.
						const machine = machines.at(-1)!;
						let broken = "";
						for (let round = 0; round < 12 && broken === ""; round += 1) {
							await Promise.all(
								["a", "b", "c", "d"].map(tag =>
									docker([
										"exec",
										"-u",
										"root",
										machine.container,
										...guestDnsArgv(
											withHosts(deploymentNetwork, [...repoHosts, `round${round}-${tag}.example`]).network,
											address,
										),
									]),
								),
							);
							const text = (await docker(["exec", machine.container, "cat", "/etc/hosts"])).stdout;
							const pinnedNow = text.split("\n").filter(line => line.endsWith(" # wlp-network"));
							if (!/^127\.0\.0\.1\s+localhost/m.test(text) || pinnedNow.length !== deploymentNetwork.hosts.length + 2)
								broken = `round ${round}: ${text}`;
						}
						expect(
							"restricted: the guest script run four at a time never empties the names file or mixes two lists",
							broken === "",
							broken.slice(0, 600),
						);
					} else expect("none: a repository's list is not applied", !byRepo.includes("fixture"), byRepo);
					if (mode === "restricted")
						expect(
							"restricted: the platform's own clone, fetch and push still work, as the transport user",
							cloned.ok && pushed !== "" && pushed === received,
							said,
						);
					else
						expect(
							"none: the git host is not reachable, which is why repository sessions are refused there",
							!cloned.ok,
							said,
						);
				}
				await sandboxes.destroy(id);
			}
		} finally {
			standIn = null;
			for (const machine of machines) await docker(["rm", "-f", "-v", machine.container]).catch(() => undefined);
			await docker(["rm", "-f", container]).catch(() => undefined);
			await docker(["network", "rm", network]).catch(() => undefined);
			rmSync(dir, { recursive: true, force: true });
			const left = await docker(["ps", "-a", "--filter", `name=^wlp-e2bfake-${run}-`, "--format", "{{.Names}}"]);
			expect(
				"the stand-in and every sandbox of the network checks are removed",
				left.stdout.trim() === "",
				left.stdout.trim(),
			);
		}
	});
} else {
	console.log(
		"\n== a real turn\n      skipped: run with --docker to drive real containers of the sandbox image through the provider",
	);
}

process.exit(tally.summary());
