/**
 * Run from server with npx tsx --test src/sandbox/availability.test.ts.
 *
 * availability.golden.md is what `availability` decides for a hosted deployment and a set of machines, one table
 * per kind of work. A change to a rule shows there as a changed cell: rewrite it with UPDATE_GOLDEN=1 and read
 * the diff. The second test holds `availability` equal to the rules the server applies today, wherever those can
 * be called without an actor.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
	HARNESS_IDS,
	machineLabel,
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	type PlanProvider,
	type SandboxProfile,
	type SandboxProfileId,
} from "../contract.js";
import { ISOLATION_NAMES, PROFILE_ISOLATION, isolationName } from "../contract/isolation.js";
import { checkRunPlace, placeProblem } from "../factory/default-place.js";
import { agentProfileProblem } from "../factory/feature-plan.js";
import { choosePlacement } from "../factory/placement.js";
import { resolveRun } from "../factory/resolve-run.js";
import { plannerMachines } from "../machines/details.js";
import { machineProfiles } from "../machines/profiles.js";
import {
	type Ask,
	type Availability,
	type Credentials,
	type Place,
	type Role,
	availability,
	availableProfiles,
} from "./availability.js";
import { reportedCodexModes } from "./codex-modes.js";
import {
	type HostedCredential,
	harnessName,
	hostedAgentProblem,
	itemHarnessProblem,
	itemProfileProblem,
	listedHarness,
	machineHarness,
	machinePayerProblem,
	subtaskHarnessProblem,
	worksWithoutAsking,
} from "./harnesses.js";

// Places and credentials

const profile = (id: SandboxProfileId, own: Partial<SandboxProfile> = {}): SandboxProfile => ({
	id,
	name: ISOLATION_NAMES[PROFILE_ISOLATION[id]],
	summary: "",
	layers: [],
	approval: PROFILE_ISOLATION[id] === "strict" ? "auto" : "full",
	commandNetwork: PROFILE_ISOLATION[id] === "open",
	commandsCanReadAccessToken: PROFILE_ISOLATION[id] === "open",
	available: true,
	...own,
});

type Hosted = Place & { kind: "hosted" };
/** A hosted deployment whose Open profiles can use the account's plans and keys; Strict takes Windlass only. */
const hosted: Hosted = {
	kind: "hosted",
	egress: "open",
	profiles: [profile("e2b"), profile("e2b-open", { platformKeys: true }), profile("daytona", { platformKeys: true })],
};
const hostedNoRelay: Hosted = { kind: "hosted", egress: "open", profiles: [profile("e2b"), profile("e2b-open")] };

const everything: Credentials = { chatgpt: true, keys: ["openai", "anthropic"], plans: ["openai", "anthropic"] };
const chatgptOnly: Credentials = { chatgpt: true, keys: [] };
const keysOnly: Credentials = { chatgpt: false, keys: ["openai", "anthropic"] };

interface MachineOptions {
	agents?: Exclude<HarnessId, "windlass">[];
	signedIn?: boolean;
	strictAllowed?: boolean;
	codexChecked?: boolean;
	codexMethod?: boolean;
	unknown?: boolean;
	commandSandbox?: boolean;
	egress?: MachineSummary["egress"];
	warnings?: MachineSummary["warnings"];
	keys?: ModelProvider[];
	plans?: PlanProvider[];
}

/** A machine as the Machines page lists it: a runner's report through the server's `machineProfiles` and `listedHarness`. */
function machineOf(name: string, options: MachineOptions = {}): MachineSummary {
	const {
		agents = ["claude", "opencode", "codex"],
		signedIn = true,
		strictAllowed = true,
		codexChecked = true,
		codexMethod = true,
		unknown = false,
		commandSandbox = true,
		egress = "open",
		warnings = [],
		keys = [],
		plans = [],
	} = options;
	const signIn = unknown ? ("unknown" as const) : signedIn ? ("token" as const) : ("none" as const);
	const base = { adapter: "a", image: "i", keyRelay: true as const, signIn };
	const raw = {
		claude: { ...base, id: "claude" as const },
		opencode: { ...base, id: "opencode" as const, machineProviders: signedIn ? ["anthropic"] : [] },
		codex: {
			...base,
			id: "codex" as const,
			...(signedIn && codexMethod && { method: "chatgpt" as const }),
			modes: reportedCodexModes(codexChecked),
		},
	};
	// The runner always allows Open, and the server refuses a report that does not (runner/control.ts).
	const allowedProfiles: MachineSummary["allowedProfiles"] = strictAllowed
		? ["docker-hardened", "docker-windlass-sandbox"]
		: ["docker-hardened"];
	const sandbox = commandSandbox
		? { ok: true as const }
		: { ok: false as const, reason: "Bubblewrap could not start." };
	return {
		machineId: name,
		name,
		os: "linux",
		arch: "x64",
		runnerVersion: "9.9.9",
		status: "online",
		since: 0,
		agents: 0,
		sandboxes: [],
		commandSandbox: sandbox,
		freeDiskBytes: 100 * 2 ** 30,
		slots: { max: 4, unit: { cpus: 2, memoryBytes: 4 * 2 ** 30, pids: 512 }, busy: 0, queued: 0 },
		sendSecrets: true,
		egress,
		allowedProfiles,
		warnings,
		profiles: machineProfiles(name, {
			docker: { ok: true },
			commandSandbox: sandbox,
			allowedProfiles,
			egress,
		} as never),
		harnesses: agents.map(id => listedHarness(raw[id], keys, plans)),
	};
}

const machines = {
	ready: machineOf("ready"),
	strictDenied: machineOf("strict-denied", { strictAllowed: false }),
	codexUnchecked: machineOf("codex-unchecked", { codexChecked: false }),
	noCommandSandbox: machineOf("no-command-sandbox", { commandSandbox: false, codexChecked: false }),
	noClaude: machineOf("no-claude", { agents: ["opencode", "codex"] }),
	signedOut: machineOf("signed-out", { signedIn: false }),
	signedOutKeys: machineOf("signed-out-keys", { signedIn: false, keys: ["openai", "anthropic"] }),
	signedOutPlans: machineOf("signed-out-plans", { signedIn: false, plans: ["openai", "anthropic"] }),
	signInUnknown: machineOf("sign-in-unknown", { unknown: true }),
	codexMethodUnknown: machineOf("codex-method-unknown", { codexMethod: false }),
	noNetwork: machineOf("no-network", { egress: "none" }),
	outdated: machineOf("outdated", { warnings: [{ kind: "outdated" }] }),
};
const on = (machine: MachineSummary): Place => ({ kind: "machine", machine });

// The matrix

const cell = (result: Availability) => (result.ok ? "yes" : result.code);

function table(role: Role, places: Place[], credentials: Credentials): string[] {
	const columns = places.flatMap(place =>
		(place.kind === "hosted" ? place.profiles : place.machine.profiles).map(p => ({
			place,
			profile: p.id,
			label:
				place.kind === "hosted"
					? `Hosted ${isolationName(p.id)} (${p.id})`
					: `${machineLabel(place.machine)} ${isolationName(p.id)}`,
		})),
	);
	return [
		`| ${role} | ${columns.map(c => c.label).join(" | ")} |`,
		`| --- | ${columns.map(() => "---").join(" | ")} |`,
		...HARNESS_IDS.map(
			agent =>
				`| ${agent} | ${columns
					.map(c => cell(availability({ agent, role, place: c.place, profile: c.profile, credentials })))
					.join(" | ")} |`,
		),
		"",
	];
}

const SECTIONS: [string, Place[], Credentials][] = [
	["Hosted, ChatGPT plan, OpenAI and Anthropic keys and plans", [hosted], everything],
	["Hosted, ChatGPT plan only", [hosted], chatgptOnly],
	["Hosted where no profile can use plans or keys, keys only", [hostedNoRelay], keysOnly],
	["Machines: ready; owner has not allowed Strict", [machines.ready, machines.strictDenied].map(on), everything],
	[
		`Machines: ${harnessName("codex")}'s sandbox not checked; no command sandbox; runner started without ${harnessName("claude")}`,
		[machines.codexUnchecked, machines.noCommandSandbox, machines.noClaude].map(on),
		everything,
	],
	[
		"Machines, agents signed out: nothing connected; keys; plans",
		[machines.signedOut, machines.signedOutKeys, machines.signedOutPlans].map(on),
		everything,
	],
	[
		`Machines: sign-in could not be checked; ${harnessName("codex")} signed in by a method the runner did not report`,
		[machines.signInUnknown, machines.codexMethodUnknown].map(on),
		everything,
	],
	["Machines: no network; runner too old", [machines.noNetwork, machines.outdated].map(on), everything],
];

/** The roles with a table of their own: the other steps of a Plan-first item answer as the planner does. */
const TABLE_ROLES: Role[] = ["session", "quick", "part", "planner"];

function rendered(): string {
	const lines = [
		"# What `availability` decides",
		"",
		"Written by availability.test.ts (UPDATE_GOLDEN=1). `yes`, or the code of the rule that refuses. A session here has",
		"no repository; every other kind of work has one.",
		"",
	];
	for (const [heading, places, credentials] of SECTIONS) {
		lines.push(`## ${heading}`, "");
		for (const role of TABLE_ROLES) lines.push(...table(role, places, credentials));
	}
	lines.push("## Notes on what is allowed", "", "| agent | work | place | notes |", "| --- | --- | --- | --- |");
	for (const agent of HARNESS_IDS)
		for (const role of ["session", "quick", "part"] as const)
			for (const [label, place, id] of [
				["Hosted Open", hosted, "e2b-open"],
				["machine Open", on(machines.ready), "docker-hardened"],
				["machine Strict", on(machines.ready), "docker-windlass-sandbox"],
			] as const) {
				const result = availability({ agent, role, place, profile: id, credentials: everything });
				if (result.ok)
					lines.push(
						`| ${agent} | ${role} | ${label} | ${result.notes.map(n => n.code + (n.confirm ? " (confirm)" : "")).join(", ") || "none"} |`,
					);
			}
	lines.push("", "## Profiles when none is named, the one taken first", "");
	lines.push(
		"| agent | work | Hosted | ready | strict-denied | codex-unchecked |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const agent of HARNESS_IDS)
		for (const role of ["session", "quick"] as const)
			lines.push(
				`| ${agent} | ${role} | ${[hosted, ...[machines.ready, machines.strictDenied, machines.codexUnchecked].map(on)]
					.map(place => availableProfiles({ agent, role, place, credentials: everything }).join(", ") || "none")
					.join(" | ")} |`,
			);
	return lines.join("\n") + "\n";
}

test("the matrix is the committed one", () => {
	const golden = new URL("./availability.golden.md", import.meta.url);
	const now = rendered();
	if (process.env.UPDATE_GOLDEN) writeFileSync(golden, now);
	assert.equal(now, readFileSync(golden, "utf8"));
});

// Today's rules

const ROLE_CODES = ["role_is_windlass_only", "agent_quick_only", "agent_sessions_only"];
/** Rules that answer before an agent's profile is looked at. */
const EARLIER = [
	...ROLE_CODES,
	"runner_outdated",
	"runner_signing_disabled",
	"machine_not_connected",
	"machine_lacks_agent",
];
const PAYER_CODES = ["nothing_pays", "not_signed_in", "sign_in_unknown", "model_not_payable"];
const MACHINE_PROFILES: SandboxProfileId[] = ["docker-hardened", "docker-windlass-sandbox"];

const part = (agent: HarnessId, id: SandboxProfileId) =>
	({
		key: "t",
		title: "t",
		brief: "",
		acceptance: [],
		dependsOn: [],
		owns: [],
		budget: { tokens: 1 },
		agent: { harness: agent },
		needs: { profile: id },
	}) as never;

const hostedList = (credentials: Credentials): HostedCredential[] => [
	...credentials.keys.map(provider => ({ provider, checkedAt: 0 })),
	...(credentials.plans ?? []).map(provider => ({ provider, checkedAt: 0, plan: true as const })),
];

const placed = (chosen: ReturnType<typeof choosePlacement>) => "decision" in chosen;

test("it decides as today's rules do", () => {
	const differences: string[] = [];
	let compared = 0;
	const same = (rule: string, where: string, ask: Ask, today: boolean, ours: boolean) => {
		compared++;
		if (today !== ours)
			differences.push(
				`${rule}: ${ask.agent} ${ask.role} ${where} ${ask.profile ?? ""}: today ${today ? "allows" : "refuses"}, availability ${ours ? "allows" : "refuses"}`,
			);
	};
	const not = (result: Availability, codes: string[]) => result.ok || !codes.includes(result.code);

	for (const [name, machine] of Object.entries(machines)) {
		const place = on(machine);
		for (const agent of HARNESS_IDS) {
			const entry = machineHarness(agent) && machine.harnesses?.find(h => h.id === agent);
			for (const id of MACHINE_PROFILES) {
				const ask = (role: Role): Ask => ({ agent, role, place, profile: id, credentials: everything });
				const quick = availability(ask("quick"));
				const built = availability(ask("part"));

				same("itemHarnessProblem", name, ask("quick"), itemHarnessProblem(agent) === null, not(quick, ROLE_CODES));
				same("subtaskHarnessProblem", name, ask("part"), subtaskHarnessProblem(agent) === null, not(built, ROLE_CODES));
				if (not(quick, EARLIER))
					same(
						"itemProfileProblem",
						name,
						ask("quick"),
						itemProfileProblem(agent, id) === null,
						not(quick, ["agent_needs_isolation"]),
					);
				if (entry && (quick.ok || PAYER_CODES.includes(quick.code)))
					same(
						"machinePayerProblem",
						name,
						ask("quick"),
						machinePayerProblem(entry, undefined, entry.platformKeys ?? [], machine.name) === null,
						quick.ok,
					);
				if (quick.ok)
					same(
						"worksWithoutAsking",
						name,
						ask("quick"),
						worksWithoutAsking(agent, id),
						quick.notes.some(n => n.code === "works_without_asking"),
					);
				const run = resolveRun(
					{ item: { place: { machine: machine.machineId }, harness: agent, machineProfile: id } },
					"builder",
				);
				same("checkRunPlace", name, ask("quick"), !checkRunPlace(run, [machine]).wait, quick.ok);
				same(
					"choosePlacement",
					name,
					ask("part"),
					placed(
						choosePlacement(
							part(agent, id),
							{ preferred: { kind: "machine", machineId: machine.machineId }, alternatives: [] },
							{ machines: plannerMachines([machine]), hostedProfiles: [], hostedCredentials: hostedList(everything) },
						),
					),
					built.ok,
				);
				if (built.ok || built.code === "agent_needs_isolation" || !EARLIER.includes(built.code))
					same(
						"agentProfileProblem",
						name,
						ask("part"),
						agentProfileProblem(part(agent, id)) === null,
						not(built, ["agent_needs_isolation"]),
					);
			}
		}
	}

	const hostedPlaces: [string, Hosted, Credentials][] = [
		["hosted, everything", hosted, everything],
		["hosted, ChatGPT only", hosted, chatgptOnly],
		["hosted, keys only", hosted, keysOnly],
		["hosted without a relay, keys only", hostedNoRelay, keysOnly],
	];
	for (const [name, place, credentials] of hostedPlaces) {
		const keyProfiles = place.profiles.filter(p => p.available && p.platformKeys).map(p => p.id);
		for (const agent of HARNESS_IDS) {
			const acp = machineHarness(agent);
			for (const { id } of place.profiles) {
				const ask = (role: Role): Ask => ({ agent, role, place, profile: id, credentials });
				const quick = availability(ask("quick"));
				const built = availability(ask("part"));
				if (not(quick, ROLE_CODES))
					same(
						"itemProfileProblem",
						name,
						ask("quick"),
						itemProfileProblem(agent, id) === null,
						not(quick, ["agent_needs_isolation"]),
					);
				if (quick.ok)
					same(
						"worksWithoutAsking",
						name,
						ask("quick"),
						worksWithoutAsking(agent, id),
						quick.notes.some(n => n.code === "works_without_asking"),
					);
				if (not(built, EARLIER))
					same(
						"agentProfileProblem",
						name,
						ask("part"),
						agentProfileProblem(part(agent, id)) === null,
						not(built, ["agent_needs_isolation"]),
					);
				same(
					"choosePlacement",
					name,
					ask("part"),
					placed(
						choosePlacement(
							part(agent, id),
							{ preferred: { kind: "hosted" }, alternatives: [] },
							{
								machines: [],
								hostedProfiles: place.profiles.filter(p => p.available).map(p => p.id),
								keyProfiles,
								hostedCredentials: hostedList(credentials),
								hostedEgress: place.egress,
							},
						),
					),
					built.ok,
				);
			}
			// The picker's rule is for the agent on Hosted, whichever profile.
			if (acp) {
				const ask: Ask = { agent, role: "session", place, credentials };
				same(
					"hostedAgentProblem",
					name,
					ask,
					hostedAgentProblem(acp.id, hostedList(credentials), keyProfiles.length > 0) === null,
					availability(ask).ok,
				);
			}
		}
	}

	assert.deepEqual(differences, []);
	assert.ok(compared > 600, `only ${compared} comparisons ran`);
});

// Sentences

test("a refusal is one sentence and what to do about it", () => {
	const strict = availability({
		agent: "claude",
		role: "quick",
		place: on(machines.ready),
		profile: "docker-windlass-sandbox",
		credentials: everything,
	});
	assert.deepEqual(strict, {
		ok: false,
		code: "agent_needs_isolation",
		message: `${harnessName("claude")} runs only in Open isolation on “ready”.`,
		fix: { text: "Choose Open isolation.", where: "here" },
	});

	const missing = availability({
		agent: "claude",
		role: "session",
		place: on(machines.noClaude),
		credentials: everything,
	});
	assert.deepEqual(missing, {
		ok: false,
		code: "machine_lacks_agent",
		message: `The runner on “no-claude” was not started with ${harnessName("claude")}.`,
		fix: { text: "Restart it with --harness claude added.", where: "machine-shell" },
	});

	const denied = availability({
		agent: "codex",
		role: "session",
		place: on(machines.strictDenied),
		profile: "docker-windlass-sandbox",
		credentials: everything,
	});
	assert.equal(denied.ok, false);
	assert.equal(
		!denied.ok && denied.fix?.text,
		"Restart the runner with --allow-profile docker-windlass-sandbox, or choose another isolation.",
	);

	// An agent a plan pays for is connected on Connections; OpenCode signs in on the machine.
	const unpaid = (agent: HarnessId) =>
		availability({
			agent,
			role: "quick",
			place: on(machines.signedOut),
			profile: "docker-hardened",
			credentials: everything,
		});
	assert.equal(cell(unpaid("claude")), "nothing_pays");
	assert.equal(cell(unpaid("opencode")), "not_signed_in");
	const opencode = unpaid("opencode");
	assert.equal(
		!opencode.ok && opencode.fix?.text,
		"On that machine, run: docker exec -it windlass-runner windlass-runner login opencode",
	);

	const planner = availability({ agent: "claude", role: "planner", place: hosted, credentials: everything });
	assert.equal(!planner.ok && planner.message, "Windlass does the planning for now, whatever agent builds.");
});

test("without a profile it takes the agent's own default, else says why not", () => {
	const quick = (agent: HarnessId, machine: MachineSummary) =>
		availability({ agent, role: "quick", place: on(machine), credentials: everything });
	const codex = quick("codex", machines.ready);
	assert.equal(codex.ok && codex.profile, "docker-windlass-sandbox");
	const unchecked = quick("codex", machines.codexUnchecked);
	assert.equal(unchecked.ok && unchecked.profile, "docker-hardened");
	// "It needs Open" says nothing when Open is what cannot be used.
	assert.equal(cell(quick("claude", machines.signedOut)), "nothing_pays");
});

test("a work item's place says the rule and what to do, not a list of things to check", () => {
	const claude = harnessName("claude");
	const strict = `${claude} runs only in Open isolation on “ready”. Choose Open isolation.`;
	const run = resolveRun(
		{ item: { place: { machine: "ready" }, harness: "claude", machineProfile: "docker-windlass-sandbox" } },
		"builder",
	);
	assert.equal(checkRunPlace(run, [machines.ready]).wait, strict);
	assert.equal(
		placeProblem({ place: { machine: "ready" }, harness: "claude", machineProfile: "docker-windlass-sandbox" }, [
			machines.ready,
		]),
		strict,
	);
	// A machine whose runner was not started with the agent says so, with the flag to add.
	const missing = resolveRun({ item: { place: { machine: "no-claude" }, harness: "claude" } }, "builder");
	assert.equal(
		checkRunPlace(missing, [machines.noClaude]).wait,
		`The runner on “no-claude” was not started with ${claude}. Restart it with --harness claude added.`,
	);
	assert.equal(
		placeProblem({ place: "any-machine", harness: "claude" }, [machines.noClaude, machines.outdated]),
		`None of your machines can run this. The runner on “no-claude” was not started with ${claude}. Restart it with --harness claude added.`,
	);
	assert.equal(placeProblem({ place: "any-machine", harness: "claude" }, [machines.noClaude, machines.ready]), null);
});
