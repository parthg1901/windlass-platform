/**
 * Whether an agent can do a kind of work at a place: one pure function over the agents' records (harnesses.ts),
 * what the place says of itself (hosted profiles; a machine's `MachineSummary`) and what the account can pay
 * with. A refusal is one rule: a code, one sentence, and what to do about it where something can be done.
 * Browser-safe: it imports only what web/src already imports from the server.
 *
 * It answers what is true of the place's last report, at filing or launch. It does not answer "now": whether
 * the machine is online or has a free slot, or the plan is at its limit (pay-with.ts `decidePayer`), is a turn's
 * question.
 */
import {
	machineLabel,
	type EgressMode,
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	type PayWithChoice,
	type PlanProvider,
	type SandboxProfile,
	type SandboxProfileId,
} from "../contract.js";
import { isolationName } from "../contract/isolation.js";
import { payWithFor } from "../pay-with.js";
import {
	PAY_WITH_HINT,
	type AcpProfile,
	type HostedCredential,
	anyOf,
	capabilitiesOf,
	harnessName,
	hostedHarness,
	hostedPayer,
	itemModeOf,
	itemProfiles,
	itemSignInMethodProblem,
	keyProviders,
	machineHarness,
	machineHarnesses,
	machinePayerProblem,
	selectedKey,
	signInWords,
	worksWithoutAsking,
} from "./harnesses.js";

export const ROLES = [
	"session",
	"quick",
	"planner",
	"part",
	"reviewer",
	"critic",
	"summary",
	"repair",
	"setup",
] as const;
/** The work a turn does: a person's session, a Quick item's build, or a step of a Plan-first item or of Repo setup. */
export type Role = (typeof ROLES)[number];

/** Nobody watches these: the agent must be paid for already, and must have a mode that never asks. */
const unattended = (role: Role) => role !== "session";

const acpRoles = (agent: AcpProfile): readonly Role[] => [
	"session",
	...(agent.items ? (["quick"] as const) : []),
	...(agent.items && agent.subtasks ? (["part", "repair"] as const) : []),
];
/** The work each agent may do, from its record's `items` and `subtasks`. Windlass does every step. */
export const AGENT_ROLES: Readonly<Record<HarnessId, readonly Role[]>> = {
	windlass: ROLES,
	claude: acpRoles(machineHarnesses.claude),
	opencode: acpRoles(machineHarnesses.opencode),
	codex: acpRoles(machineHarnesses.codex),
};

/** A machine as the Machines page lists it: the runner's report with the account's keys and plans applied (`listedHarness`). */
export type MachineFacts = Pick<
	MachineSummary,
	"name" | "os" | "arch" | "profiles" | "allowedProfiles" | "harnesses" | "egress" | "warnings"
>;
export type HostedProfile = Pick<SandboxProfile, "id" | "available" | "platformKeys" | "unavailableReason">;
export type Place =
	| { kind: "hosted"; profiles: readonly HostedProfile[]; egress?: EgressMode }
	| { kind: "machine"; machine: MachineFacts };

/** What the account can pay with. A machine's report already says what pays for its agents; these decide Hosted, and Windlass anywhere. */
export interface Credentials {
	/** Providers with a saved, checked key. */
	keys: readonly ModelProvider[];
	/** Connected plans the account may use. */
	plans?: readonly PlanProvider[];
	/** Whether the ChatGPT plan is connected (Windlass's own models). Absent: not judged. */
	chatgpt?: boolean;
	/** Connections → Pay with. Absent: the defaults. */
	payWith?: readonly PayWithChoice[];
}

export interface Ask {
	agent: HarnessId;
	role: Role;
	place: Place;
	/** Absent: any profile of the place it can run in. */
	profile?: SandboxProfileId;
	credentials: Credentials;
	model?: string;
	/** Whether the work clones a repository. Absent: a session has none, every other role has one. */
	repo?: boolean;
}

export type Code =
	| "role_is_windlass_only"
	| "agent_quick_only"
	| "agent_sessions_only"
	| "agent_needs_isolation"
	| "profile_unknown"
	| "profile_unavailable"
	| "profile_not_allowed"
	| "no_relay"
	| "nothing_pays"
	| "windlass_not_connected"
	| "runner_outdated"
	| "runner_signing_disabled"
	| "machine_not_connected"
	| "machine_lacks_agent"
	| "sandbox_check_missing"
	| "not_signed_in"
	| "sign_in_unknown"
	| "sign_in_method"
	| "model_not_payable"
	| "no_network_for_repo";

/** What is allowed but differs from Windlass, and would otherwise go unsaid. */
export type NoteCode =
	| "works_without_asking"
	| "leaving_sandbox_ends_step"
	| "no_screenshots"
	| "publish_asks_every_time"
	| "checks_left_to_ci"
	| "own_mcp_servers_not_passed"
	| "first_prompt_refused";

export interface Note {
	code: NoteCode;
	message: string;
	/** The person confirms it before the work starts (a part or repair the planner placed). */
	confirm?: true;
}
export interface Fix {
	text: string;
	/** Where it is done: a page of the app, a shell on the machine, or by whoever runs the deployment. */
	where: "here" | "connections" | "machines" | "machine-shell" | "deployment";
}
export type Availability =
	| { ok: true; profile: SandboxProfileId; notes: Note[] }
	| { ok: false; code: Code; message: string; fix?: Fix };

interface Words {
	agent: string;
	id: HarnessId;
	/** "on Hosted", "on “mac”". */
	place: string;
	hosted: boolean;
	isolation: string;
	profile: SandboxProfileId;
	role: Role;
	detail?: string;
	/** A second value some sentences name: the isolations or sign-ins that would do. */
	allowed?: string;
}

const STEPS: Partial<Record<Role, string>> = {
	planner: "planning",
	reviewer: "review",
	critic: "plan review",
	summary: "summary",
	setup: "repository setup",
};

const here = (text: string): Fix => ({ text, where: "here" });
const connect: Fix = { text: PAY_WITH_HINT, where: "connections" };

/** One sentence and one fix per rule. */
const RULES: Record<Code, { says: (w: Words) => string; fix?: (w: Words) => Fix }> = {
	role_is_windlass_only: {
		says: w => `Windlass does the ${STEPS[w.role] ?? "step"} for now, whatever agent builds.`,
	},
	agent_quick_only: {
		says: w => `${w.agent} runs Quick items only for now, not Plan-first parts.`,
		fix: () => here("Choose Quick, or another agent for the parts."),
	},
	agent_sessions_only: {
		says: w => `${w.agent} runs sessions only for now, not work items.`,
		fix: w => here(`Start a ${w.agent} session instead.`),
	},
	agent_needs_isolation: {
		says: w => `${w.agent} runs only in ${w.allowed} isolation ${w.place}.`,
		fix: w => here(`Choose ${w.allowed} isolation.`),
	},
	profile_unknown: {
		says: w => `${w.isolation} isolation is not offered ${w.place}.`,
		fix: () => here("Choose an isolation from the list."),
	},
	profile_unavailable: {
		says: w => `${w.isolation} isolation can't be used ${w.place} now.${w.detail ? " " + w.detail : ""}`,
	},
	profile_not_allowed: {
		says: w => `The owner of the machine has not allowed ${w.isolation} isolation ${w.place}.`,
		fix: w => ({
			text: `Restart the runner with --allow-profile ${w.profile}, or choose Open.`,
			where: "machine-shell",
		}),
	},
	no_relay: {
		says: w => `${w.isolation} isolation ${w.place} can't use your plans or keys, which ${w.agent} needs.`,
		fix: () => ({ text: "Ask whoever runs this deployment, or run it on one of your machines.", where: "deployment" }),
	},
	nothing_pays: {
		says: w => `Nothing connected can pay for ${w.agent} ${w.place}.`,
		fix: () => connect,
	},
	windlass_not_connected: {
		says: () => "Windlass needs your ChatGPT plan or a key to run.",
		fix: () => connect,
	},
	runner_outdated: {
		says: w => `The runner ${w.place} is too old for this platform.`,
		fix: () => ({ text: "Update it with the command on the Machines page.", where: "machines" }),
	},
	runner_signing_disabled: {
		says: w => `The runner ${w.place} needs signed connections, which this deployment has turned off.`,
		fix: () => ({ text: "Ask whoever runs this deployment to turn them on.", where: "deployment" }),
	},
	machine_not_connected: {
		says: w => `The runner ${w.place} has not connected yet.`,
		fix: () => ({ text: "Start it, and wait until the Machines page shows it online.", where: "machine-shell" }),
	},
	machine_lacks_agent: {
		says: w => `The runner ${w.place} was not started with ${w.agent}.`,
		fix: w => ({ text: `Restart it with --harness ${w.id} added.`, where: "machine-shell" }),
	},
	sandbox_check_missing: {
		says: w =>
			`${w.agent} can't use ${w.isolation} isolation ${w.place}: the runner's check of ${w.agent}'s own sandbox has not passed there.`,
		fix: () => ({ text: "Restart the runner to check again, or choose Open.", where: "machine-shell" }),
	},
	not_signed_in: {
		says: w => `${w.agent} is not signed in ${w.place}.`,
		fix: w => ({
			text: `On that machine, run: docker exec -it windlass-runner windlass-runner login ${w.id}`,
			where: "machine-shell",
		}),
	},
	sign_in_unknown: {
		says: w =>
			`The runner ${w.place} couldn't check whether ${w.agent} is signed in, and work nobody watches runs only where it is.`,
		fix: () => ({ text: "Check that Docker is running on the machine.", where: "machine-shell" }),
	},
	sign_in_method: {
		says: w => `${w.agent} ${w.place} pays with ${w.detail}, and its work items run only on ${w.allowed} for now.`,
		fix: () => connect,
	},
	model_not_payable: {
		says: w => `Nothing connected ${w.place} can pay for ${w.detail} with ${w.agent}.`,
		fix: () => ({ text: "Add a key for its provider on Connections, or choose another model.", where: "connections" }),
	},
	no_network_for_repo: {
		says: w => `Sandboxes ${w.place} have no network, so they can't clone a repository.`,
		fix: w =>
			w.hosted
				? { text: "Run it on one of your machines, or start without a repository.", where: "machines" }
				: {
						text: "Restart the runner with --egress restricted, or start without a repository.",
						where: "machine-shell",
					},
	},
};

const placeWords = (place: Place) => (place.kind === "hosted" ? "on Hosted" : `on “${machineLabel(place.machine)}”`);

const isolationsOf = (profiles: readonly SandboxProfileId[]) => anyOf([...new Set(profiles.map(isolationName))]);

/** What can pay on Hosted, as a turn counts it (`hostedPayer`), less what Pay with rules out. */
function hostedCredentials(agent: AcpProfile["id"], credentials: Credentials): HostedCredential[] {
	const keys = credentials.keys.map(provider => ({ provider, checkedAt: 0 }));
	const plans = (credentials.plans ?? []).map(provider => ({ provider, checkedAt: 0, plan: true as const }));
	const hasKey = keys.some(key => keyProviders(agent).includes(key.provider));
	const rule = payWithFor(credentials.payWith ?? [], agent, "item", hasKey).payWith;
	return [...(rule === "plan" ? [] : keys), ...(rule === "key" ? [] : plans)];
}

/** Windlass, at any place: its own models run on the ChatGPT plan, a `provider/…` model on that provider's key. */
function windlassPayer(credentials: Credentials, model: string | undefined): Code | null {
	const qualified = model?.includes("/") ? selectedKey("windlass", model, keyProviders("windlass")) : undefined;
	if (qualified) return credentials.keys.includes(qualified) ? null : "nothing_pays";
	return credentials.chatgpt === false && credentials.keys.length === 0 ? "windlass_not_connected" : null;
}

function notesFor(ask: Ask, profile: SandboxProfileId): Note[] {
	const { agent, role, place } = ask;
	const acp = machineHarness(agent);
	const caps = capabilitiesOf(agent);
	const name = harnessName(agent);
	const notes: Note[] = [];
	const sandboxed = place.kind === "machine" && !!acp?.sandboxedOn.includes(profile);
	if (unattended(role) && worksWithoutAsking(agent, profile))
		notes.push({
			code: "works_without_asking",
			message: `${name} runs every command and edit without asking you.`,
			...((role === "part" || role === "repair") && { confirm: true as const }),
		});
	if (unattended(role) && sandboxed)
		notes.push({ code: "leaving_sandbox_ends_step", message: `If ${name} asks to leave its sandbox, the step ends.` });
	if (unattended(role) && !caps.reportScreenshots)
		notes.push({ code: "no_screenshots", message: `${name} files no screenshots with its report.` });
	if (acp && caps.platformTools.includes("publish"))
		notes.push({ code: "publish_asks_every_time", message: `${name} asks you every time it wants to publish.` });
	if (caps.checks === "none" || (caps.checks === "platform" && sandboxed))
		notes.push({ code: "checks_left_to_ci", message: "Your repository's saved checks are not run here: CI decides." });
	if (caps.userServers === "none")
		notes.push({ code: "own_mcp_servers_not_passed", message: `Your own MCP servers are not passed to ${name}.` });
	const entry = place.kind === "machine" ? place.machine.harnesses?.find(h => h.id === agent) : undefined;
	if (entry?.signIn === "none")
		notes.push({
			code: "first_prompt_refused",
			message: `Nothing can pay for ${name} ${placeWords(place)} yet, so its first prompt will be refused.`,
		});
	return notes;
}

/** A refusal as one line: the rule, then what to do about it. */
export const refusalText = (refused: Extract<Availability, { ok: false }>) =>
	refused.fix ? `${refused.message} ${refused.fix.text}` : refused.message;

type Refusal = { code: Code; detail?: string; allowed?: string };

/** The first rule that refuses this agent, role, place and profile; null when none does. */
function refusal(ask: Ask, profile: SandboxProfileId): Refusal | null {
	const { agent, role, place, credentials, model } = ask;
	const acp = machineHarness(agent);
	const repo = ask.repo ?? unattended(role);

	if (!AGENT_ROLES[agent].includes(role)) {
		if (role === "quick") return { code: "agent_sessions_only" };
		return { code: role === "part" || role === "repair" ? "agent_quick_only" : "role_is_windlass_only" };
	}

	if (place.kind === "hosted") {
		const hosted = acp && hostedHarness(acp.id);
		if (hosted && !hosted.profiles.includes(profile))
			return { code: "agent_needs_isolation", allowed: isolationsOf(hosted.profiles) };
		const offered = place.profiles.find(p => p.id === profile);
		if (!offered) return { code: "profile_unknown" };
		if (!offered.available) return { code: "profile_unavailable", detail: offered.unavailableReason };
		// A hosted ACP agent is paid for through the deployment's model relay only (`hostedHarness`).
		if (acp && !offered.platformKeys) return { code: "no_relay" };
		if (acp && !hostedPayer(acp.id, model, hostedCredentials(acp.id, credentials))) return { code: "nothing_pays" };
		const payer = acp ? null : windlassPayer(credentials, model);
		if (payer) return { code: payer };
		return repo && place.egress === "none" ? { code: "no_network_for_repo" } : null;
	}

	const machine = place.machine;
	if (machine.warnings.some(w => w.kind === "signing-disabled")) return { code: "runner_signing_disabled" };
	if (machine.warnings.some(w => w.kind === "outdated")) return { code: "runner_outdated" };
	if (machine.profiles.length === 0) return { code: "machine_not_connected" };
	const entry = acp ? machine.harnesses?.find(h => h.id === acp.id) : undefined;
	if (acp && !entry) return { code: "machine_lacks_agent" };
	if (acp) {
		const profiles = unattended(role) ? itemProfiles(agent).filter(p => acp.profiles.includes(p)) : acp.profiles;
		if (!profiles.includes(profile)) return { code: "agent_needs_isolation", allowed: isolationsOf(profiles) };
	}
	if (machine.allowedProfiles && !machine.allowedProfiles.some(id => id === profile))
		return { code: "profile_not_allowed" };
	const offered = machine.profiles.find(p => p.id === profile);
	if (!offered) return { code: "profile_unknown" };
	if (!offered.available) return { code: "profile_unavailable", detail: offered.unavailableReason };
	if (acp && entry) {
		// Where its commands run in its own sandbox, the runner must have checked the mode it starts in.
		const mode = itemModeOf(agent, profile);
		if (acp.sandboxedOn.includes(profile) && !(mode && entry.modes?.includes(mode)))
			return { code: "sandbox_check_missing" };
		if (unattended(role)) {
			// An agent a plan pays for is connected on Connections; the others sign in on the machine.
			if (entry.signIn === "none") return { code: acp.planProviders.length ? "nothing_pays" : "not_signed_in" };
			if (entry.signIn === "unknown") return { code: "sign_in_unknown" };
			if (itemSignInMethodProblem(acp, machine.name, entry.method))
				return {
					code: "sign_in_method",
					detail: signInWords(entry.method),
					allowed: anyOf((acp.itemSignIns ?? []).map(signInWords)),
				};
			if (machinePayerProblem(entry, model, entry.platformKeys ?? []))
				return { code: "model_not_payable", detail: model };
		}
	} else {
		const payer = windlassPayer(credentials, model);
		if (payer) return { code: payer };
	}
	return repo && machine.egress === "none" ? { code: "no_network_for_repo" } : null;
}

function judge(ask: Ask, profile: SandboxProfileId): Availability {
	const found = refusal(ask, profile);
	if (!found) return { ok: true, profile, notes: notesFor(ask, profile) };
	const words: Words = {
		agent: harnessName(ask.agent),
		id: ask.agent,
		place: placeWords(ask.place),
		hosted: ask.place.kind === "hosted",
		isolation: isolationName(profile),
		profile,
		role: ask.role,
		detail: found.detail,
		allowed: found.allowed,
	};
	const rule = RULES[found.code];
	const fix = rule.fix?.(words);
	return { ok: false, code: found.code, message: rule.says(words), ...(fix && { fix }) };
}

/** The profiles the place lists, the agent's own default for unattended work first (`itemProfiles`: Codex's is Strict). */
function candidates(ask: Omit<Ask, "profile">): SandboxProfileId[] {
	const listed = (ask.place.kind === "hosted" ? ask.place.profiles : ask.place.machine.profiles).map(p => p.id);
	const first = unattended(ask.role) && ask.place.kind === "machine" ? itemProfiles(ask.agent) : [];
	return [...first.filter(id => listed.includes(id)), ...listed.filter(id => !first.includes(id))];
}

/** Every profile of the place this agent can do this work in, its default first. */
export function availableProfiles(ask: Omit<Ask, "profile">): SandboxProfileId[] {
	return candidates(ask).filter(profile => judge(ask, profile).ok);
}

/**
 * Whether the agent can do this work at this place. With a profile: in that one. Without: in the first it can
 * (the result names it), else why not.
 */
export function availability(ask: Ask): Availability {
	if (ask.profile) return judge(ask, ask.profile);
	const tried = candidates(ask).map(profile => judge(ask, profile));
	return (
		tried.find(result => result.ok) ??
		// "It needs Open" says nothing when Open is what failed: prefer the reason of a profile the agent could use.
		tried.find(result => !result.ok && result.code !== "agent_needs_isolation") ??
		tried[0] ??
		judge(ask, ask.place.kind === "hosted" ? "e2b-open" : "docker-hardened")
	);
}
