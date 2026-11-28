// Setup prompts and navigation. WizardEffects owns pairing, sign-in and Docker operations.
import { BACK, CANCEL, type Answer, type Prompter } from "./setup-prompt.js";
import {
	HARNESS_LABELS,
	PRESET_DOMAINS,
	networkLine,
	startFlags,
	storeDefaults,
	type SetupChoices,
} from "./setup-choices.js";
import type { MachineHarness } from "./policy.js";

export type SignInState = "signed-in" | "signed-out" | "unknown";
export type PairEvent =
	| { kind: "code"; url: string; code: string }
	| { kind: "key"; key: string }
	| { kind: "paired"; account: string }
	| { kind: "line"; text: string };
export type ServiceState = "running" | "stopped" | "absent";
export type Pairing = { machineId: string; platform: string };

export interface WizardEffects {
	version: string;
	offered: MachineHarness[];
	pairing(): Pairing | undefined;
	savedName(): string | undefined;
	defaultName(): Promise<string>;
	saveName(name: string): Promise<void>;
	checkName(name: string): string | undefined;
	checkPlatform(address: string): string | undefined;
	/** What setup.json holds, or, for a machine set up before it, what its pairing has saved. */
	choices(): { saved: boolean; choices: SetupChoices };
	saveChoices(choices: SetupChoices): void;
	slotsDefault(): number;
	checkSlots(slots: number): string | undefined;
	checkSize(value: string, free: boolean): string | undefined;
	checkDomains(list: string): string | undefined;
	service(): Promise<ServiceState>;
	/** Takes the state lock. False while a runner service holds it. */
	holdState(): boolean;
	releaseState(): void;
	stopService(): Promise<void>;
	restartService(): Promise<void>;
	pair(
		platform: string,
		name: string,
		show: (event: PairEvent) => void,
		signal: AbortSignal,
	): Promise<{ ok: true } | { ok: false; message: string }>;
	prepare(agents: MachineHarness[], update: (line: string) => void): Promise<void>;
	signInState(agent: MachineHarness): Promise<SignInState>;
	/** Setup continues on a failed sign-in. Only a safe reason may be displayed. */
	signIn(agent: MachineHarness): Promise<{ ok: true } | { ok: false; reason: string } | "stopped">;
	laterLogin(agent: MachineHarness): string;
	startCommand(flags: string[]): string;
	start(flags: string[], replace: boolean): Promise<void>;
	waitOnline(signal: AbortSignal, update: (status: string) => void): Promise<{ ok: boolean; message: string }>;
	reportLogin(): Promise<void>;
}

export const SECTIONS = ["name", "agents", "opencode", "profile", "network", "limits"] as const;
/** The agents setup signs in: OpenCode's own logins. Claude Code and Codex pay with the account's plans and keys. */
const SIGNS_IN: readonly MachineHarness[] = ["opencode"];
export type Section = (typeof SECTIONS)[number];
/** `connect`: `npx @windlassai/cli connect --machine`, with nobody to answer: every default, every agent the image has and no sign-in. */
export type Mode = { kind: "full" } | { kind: "quick" } | { kind: "connect" } | { kind: "section"; section: Section };
export type Outcome = { outcome: "done" | "cancelled" | "failed"; message?: string };

type Step = "welcome" | "pair" | "name" | "agents" | "profile" | "network" | "limits" | "summary" | "start";
type Move = "next" | "back" | "cancel" | "skip" | Outcome;

export const WINDLASS_SANDBOX_NOTE =
	"Its container runs with looser Docker limits (no AppArmor profile, unmasked system paths, a wider seccomp filter) so Windlass can sandbox each command inside it, with no network.";
const DESKTOP_NAMES = new Set(["docker-desktop", "orbstack", "colima", "rancher-desktop"]);

async function chooseNetwork(p: Prompter, fx: WizardEffects, draft: SetupChoices, skipSaved: boolean): Promise<Move> {
	if (skipSaved && draft.network !== undefined) return "skip";
	for (;;) {
		const current = draft.network;
		const mode = await p.select({
			message: "What may the agents' commands reach on the network?",
			initial: current?.domains?.length
				? "domains"
				: current?.mode === "open"
					? "open"
					: current?.mode === "none"
						? "none"
						: "restricted",
			options: [
				{
					value: "restricted",
					label: "Restricted (recommended)",
					hint: "public sites through the runner's proxy, not your local network or this computer",
				},
				{ value: "domains", label: "Only some public hosts", hint: "a list such as @npm,@pypi,@github,example.com" },
				{ value: "open", label: "Open", hint: "the internet and your local network, directly" },
				...(current?.mode === "none"
					? [{ value: "none", label: "None", hint: "no network; an agent here cannot have a repository" }]
					: []),
			],
		});
		if (mode === BACK) return "back";
		if (mode === CANCEL) return "cancel";
		if (mode !== "domains") {
			draft.network = {
				mode: mode as "restricted" | "open" | "none",
				...(mode === "restricted" && current?.allow?.length && { allow: current.allow }),
			};
			return "next";
		}
		const list = await p.text({
			message: "Public hosts commands may reach",
			initial: current?.domains?.join(",") || PRESET_DOMAINS,
			validate: fx.checkDomains,
			hint: "Comma-separated names, *.name for subdomains, or @npm, @pypi, @github, @crates, @go. The platform's git and model hosts are always added.",
		});
		if (list === CANCEL) return "cancel";
		if (list === BACK) continue;
		draft.network = {
			mode: "restricted",
			...(current?.allow?.length && { allow: current.allow }),
			domains: list
				.split(",")
				.map(s => s.trim())
				.filter(Boolean),
		};
		return "next";
	}
}

async function chooseLimits(p: Prompter, fx: WizardEffects, draft: SetupChoices, skipSaved: boolean): Promise<Move> {
	if (skipSaved && draft.limits !== undefined) return "skip";
	const auto = fx.slotsDefault();
	const l = {
		slots: draft.limits?.slots ?? auto,
		snapshotDisk: draft.limits?.snapshotDisk ?? storeDefaults.snapshotDisk,
		keepFree: draft.limits?.keepFree ?? storeDefaults.keepFree,
	};
	const keep = () => {
		draft.limits = { ...(l.slots !== auto && { slots: l.slots }), snapshotDisk: l.snapshotDisk, keepFree: l.keepFree };
		return "next" as const;
	};
	for (;;) {
		const choice = await p.select({
			message: `Limits: ${l.slots} turn ${l.slots === 1 ? "slot" : "slots"}, ${l.snapshotDisk} for setup snapshots, keep ${l.keepFree} of disk free`,
			initial: "keep",
			options: [
				{ value: "keep", label: "Use these limits" },
				{ value: "change", label: "Change them" },
			],
		});
		if (choice === BACK) return "back";
		if (choice === CANCEL) return "cancel";
		if (choice === "keep") return keep();
		const fields = [
			{
				message: "Turn slots (1 to 64)",
				get: () => String(l.slots),
				set: (v: string) => {
					l.slots = Number(v);
				},
				validate: (v: string) =>
					/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= 64
						? fx.checkSlots(Number(v))
						: "Give a whole number from 1 to 64.",
				hint: `Each slot runs one turn at a time. ${auto} suits this computer.`,
			},
			{
				message: "Disk for setup snapshots",
				get: () => l.snapshotDisk,
				set: (v: string) => {
					l.snapshotDisk = v.trim();
				},
				validate: (v: string) => fx.checkSize(v.trim(), false),
				hint: "A size such as 20GB or 512MB.",
			},
			{
				message: "Disk to keep free",
				get: () => l.keepFree,
				set: (v: string) => {
					l.keepFree = v.trim();
				},
				validate: (v: string) => fx.checkSize(v.trim(), true),
				hint: "Below this, snapshots are evicted oldest first. 0GB keeps nothing free.",
			},
		];
		let i = 0;
		while (i >= 0 && i < fields.length) {
			const f = fields[i]!;
			const value = await p.text({ message: f.message, initial: f.get(), validate: f.validate, hint: f.hint });
			if (value === CANCEL) return "cancel";
			if (value === BACK) {
				i--;
				continue;
			}
			f.set(value);
			i++;
		}
		if (i === fields.length) return keep();
	}
}

export async function runWizard(
	p: Prompter,
	fx: WizardEffects,
	mode: Mode,
	given: { platform?: string } = {},
): Promise<Outcome> {
	const loaded = fx.choices();
	const draft: SetupChoices = structuredClone(loaded.choices);
	const quick = mode.kind === "quick";
	const connect = mode.kind === "connect";
	let paired = fx.pairing();
	let platform = given.platform ?? paired?.platform;
	let name = fx.savedName() ?? (await fx.defaultName());
	let holding = false,
		stopped = false;
	/** What happened to each agent's sign-in in this run. */
	const signIns = new Map<MachineHarness, "signed-in" | "failed" | "skipped" | "kept">();
	/** Each offered agent's sign-in as the agents step found it. */
	const states = new Map<MachineHarness, SignInState>();
	const offered = fx.offered;

	if (mode.kind === "section" && !paired) return { outcome: "failed", message: "Pair this machine first: run setup." };
	const steps: Step[] =
		mode.kind === "section"
			? [mode.section === "opencode" ? "agents" : (mode.section as Step), "summary", "start"]
			: ["welcome", "pair", "name", "agents", "profile", "network", "limits", "summary", "start"];

	const ask = async <T>(answer: Promise<Answer<T>>, then: (value: T) => Move | Promise<Move>): Promise<Move> => {
		const value = await answer;
		return value === BACK ? "back" : value === CANCEL ? "cancel" : then(value);
	};

	const welcome = async (): Promise<Move> => {
		if (!platform) {
			const typed = await p.text({ message: "Platform address", initial: "https://", validate: fx.checkPlatform });
			if (typed === CANCEL) return "cancel";
			if (typed === BACK) return "back";
			platform = new URL(typed).origin;
		}
		p.note("Welcome", [
			"Platform     " + platform,
			paired
				? `This machine is paired as ${paired.machineId}.`
				: "This pairs this computer with your account, then starts the runner in the background.",
			...(p.keys ? [p.keys] : []),
		]);
		return ask(
			p.select({
				message: paired ? "Go through this machine's settings?" : "Set up this machine?",
				options: [
					{ value: "go", label: paired ? "Yes, go through them" : "Yes, set it up" },
					{ value: "stop", label: "Cancel" },
				],
			}),
			v => (v === "go" ? "next" : "cancel"),
		);
	};

	const pairStep = async (): Promise<Move> => {
		const same = paired && paired.platform === platform;
		if (same && quick) return "skip";
		if (same && connect) {
			// A running runner is left as it is: its settings may have come from flags this mode would not keep.
			if ((await fx.service()) === "running") {
				p.outro(
					`This machine is already paired as ${paired!.machineId} and its runner is running. Nothing was changed. To change its settings or pair it again, run setup.`,
				);
				return { outcome: "done" };
			}
			p.log("info", `This machine is already paired as ${paired!.machineId}. Keeping that pairing.`);
			return "next";
		}
		if (same) {
			const move = await ask(
				p.select({
					message: "Pairing",
					initial: "keep",
					options: [
						{ value: "keep", label: `Keep this pairing (${paired!.machineId})` },
						{ value: "again", label: "Pair again", hint: "a new machine key; the platform shows it as a new machine" },
					],
				}),
				v => (v === "keep" ? ("next" as const) : ("skip" as const)),
			);
			if (move !== "skip") return move;
		} else if (paired)
			p.log("info", `This machine is paired with ${paired.platform}. Pair it with ${platform} instead.`);
		if (!holding && !(holding = fx.holdState())) {
			const move = await ask(
				p.select({
					message: "The runner is running on this machine. Stop it to pair again? Setup restarts it at the end.",
					options: [
						{ value: "stop", label: "Stop it and pair" },
						{ value: "cancel", label: "Cancel" },
					],
				}),
				v => (v === "stop" ? ("next" as const) : ("cancel" as const)),
			);
			if (move !== "next") return move;
			await fx.stopService();
			stopped = true;
			if (!(holding = fx.holdState()))
				return {
					outcome: "failed",
					message: "Another runner command is using this state volume. Wait for it to finish, then run setup again.",
				};
		}
		for (;;) {
			let code: Extract<PairEvent, { kind: "code" }> | undefined, account: string | undefined;
			const result = await p.wait("Waiting for you to enter the code (it expires in 10 minutes)", (signal, update) =>
				fx.pair(
					platform!,
					name,
					event => {
						if (event.kind === "code") code = event;
						else if (event.kind === "key" && code && p.pairing) p.pairing(code.code, event.key);
						else if (event.kind === "key" && code)
							p.note(
								"Pair this machine",
								[
									"1. Open      " + code.url + "/machines/add",
									"2. Enter     " + code.code,
									"3. Check     the page shows machine key " + event.key,
									"Only enter a code this terminal printed. If someone gave you a code, stop.",
								],
								[code.code, event.key],
							);
						else if (event.kind === "paired") account = event.account;
						else if (event.kind === "line") update(event.text);
					},
					signal,
				),
			);
			if (result === CANCEL || result === BACK) return "cancel";
			if (result.ok) {
				paired = fx.pairing();
				p.log(
					"success",
					`Paired with ${account ?? "your account"}. If that is not you, run setup again and pair again.`,
				);
				return "next";
			}
			p.log("error", result.message);
			if (!p.interactive) return { outcome: "failed" };
			const again = await ask(
				p.select({
					message: "Try again?",
					options: [
						{ value: "again", label: "Get a new code" },
						{ value: "stop", label: "Cancel" },
					],
				}),
				v => (v === "again" ? ("next" as const) : ("cancel" as const)),
			);
			if (again !== "next") return again;
		}
	};

	const nameStep = async (): Promise<Move> => {
		if (quick && fx.savedName() !== undefined) return "skip";
		return ask(
			p.text({
				message: "Machine name",
				initial: name,
				validate: fx.checkName,
				hint: DESKTOP_NAMES.has(name)
					? `"${name}" is the name of Docker's VM on every computer that runs it. Give this computer a name you will know it by.`
					: "How the Machines page shows this computer.",
			}),
			async (value): Promise<Move> => {
				name = value.trim();
				await fx.saveName(name);
				return "next";
			},
		);
	};

	const signInQuestion = async (agent: MachineHarness, state: SignInState): Promise<Move> => {
		const label = HARNESS_LABELS[agent];
		const later = "Sign it in later with: " + fx.laterLogin(agent);
		if (!p.interactive) {
			p.log("warn", `${label} is not signed in: signing in needs a terminal. ${later}`);
			signIns.set(agent, "skipped");
			return "next";
		}
		const signedIn = state === "signed-in";
		return ask(
			p.select({
				message: `${label}: ${signedIn ? "signed in on this machine" : "sign in now?"}`,
				initial: signedIn ? "keep" : "now",
				options: signedIn
					? [
							{ value: "keep", label: "Keep this sign-in" },
							{ value: "now", label: "Sign in again" },
						]
					: [
							{ value: "now", label: "Sign in now" },
							{ value: "skip", label: "Skip for now", hint: "sign it in later" },
						],
			}),
			async (v): Promise<Move> => {
				if (v === "keep") {
					signIns.set(agent, "kept");
					return "next";
				}
				if (v === "skip") {
					signIns.set(agent, "skipped");
					p.log("info", `${label} is not signed in. ${later}`);
					return "next";
				}
				p.log("step", `Signing in to ${label}. Follow its steps below.`);
				const result = await fx.signIn(agent);
				if (result === "stopped") return "cancel";
				if (result.ok) {
					signIns.set(agent, "signed-in");
					p.log("success", `${label}: signed in.`);
				} else {
					// As the line-by-line setup: the machine is paired already, so one agent does not stop the others.
					signIns.set(agent, "failed");
					p.log("error", `${label} was not signed in: ${result.reason} Setup carries on. ${later}`);
				}
				return "next";
			},
		);
	};

	const agentsStep = async (): Promise<Move> => {
		const only = mode.kind === "section" && mode.section !== "agents" ? (mode.section as MachineHarness) : undefined;
		if (only && !offered.includes(only))
			return { outcome: "failed", message: `This runner image has no ${HARNESS_LABELS[only]}.` };
		if (!offered.length) {
			p.log("info", "This runner image has no other agents. Windlass is always offered.");
			draft.agents = [];
			return "next";
		}
		if (connect) {
			// The agents pay with the account's plans and keys (Connections), so none signs in on the machine.
			const agents =
				loaded.saved && draft.agents !== undefined ? draft.agents.filter(id => offered.includes(id)) : offered;
			draft.agents = [...agents];
			if (
				agents.length &&
				(await p.wait("Fetching the agents' images (the first time takes a few minutes)", (_, update) =>
					fx.prepare(agents, update),
				)) === CANCEL
			)
				return "cancel";
			p.log(
				"info",
				`Agents: ${["Windlass", ...agents.map(id => HARNESS_LABELS[id])].join(", ")}. They use the plans and keys connected to your account.`,
			);
			return "next";
		}
		for (const id of offered.filter(id => SIGNS_IN.includes(id))) states.set(id, await fx.signInState(id));
		const stateLine = (id: MachineHarness) =>
			states.get(id) === "signed-in" ? "signed in" : states.get(id) === "unknown" ? "sign-in unknown" : "not signed in";
		for (;;) {
			let agents: MachineHarness[];
			if (only) agents = [only];
			else if (quick && loaded.saved && draft.agents !== undefined) agents = draft.agents;
			else {
				const picked = await p.multiselect({
					message: "Which agents should this machine offer? Windlass is always offered.",
					initial: (draft.agents ?? []).filter(id => offered.includes(id)),
					options: offered.map(id => ({
						value: id,
						label: HARNESS_LABELS[id],
						hint: SIGNS_IN.includes(id) ? stateLine(id) : "uses your plans and keys",
					})),
				});
				if (picked === BACK) return "back";
				if (picked === CANCEL) return "cancel";
				agents = picked;
			}
			const signing = agents.filter(id => SIGNS_IN.includes(id));
			const asked = quick ? signing.filter(id => states.get(id) !== "signed-in") : signing;
			if (quick && !asked.length && draft.agents !== undefined) return "skip";
			draft.agents = only ? [...new Set([...(draft.agents ?? []), only])].filter(id => offered.includes(id)) : agents;
			const fetched = quick ? asked : agents;
			if (
				fetched.length &&
				(await p.wait("Fetching the agents' images (the first time takes a few minutes)", (_, update) =>
					fx.prepare(fetched, update),
				)) === CANCEL
			)
				return "cancel";
			let i = 0;
			while (i < asked.length) {
				const move = await signInQuestion(asked[i]!, states.get(asked[i]!)!);
				if (move === "cancel" || typeof move === "object") return move;
				if (move === "back") {
					if (i === 0) break;
					i--;
					continue;
				}
				i++;
			}
			if (i === asked.length) return "next";
			if (only || (quick && loaded.saved)) return "back";
		}
	};

	const profileStep = async (): Promise<Move> => {
		if (quick && loaded.saved && draft.windlassSandbox !== undefined) return "skip";
		return ask(
			p.select({
				message: "Which Docker profiles may agents use here? Hardened Docker is always allowed.",
				initial: draft.windlassSandbox ?? true,
				options: [
					{
						value: true,
						label: "Hardened Docker and Docker + Windlass sandbox (recommended)",
						hint: WINDLASS_SANDBOX_NOTE,
					},
					{ value: false, label: "Hardened Docker only" },
				],
			}),
			v => {
				draft.windlassSandbox = v;
				return "next";
			},
		);
	};

	const flags = () => startFlags(platform!, draft);
	const summaryStep = async (): Promise<Move> => {
		for (const id of connect ? [] : (draft.agents ?? []).filter(id => SIGNS_IN.includes(id)))
			if (!signIns.has(id) && !states.has(id)) states.set(id, await fx.signInState(id));
		const agentLine = (draft.agents ?? []).map(id => {
			const s = signIns.get(id) ?? states.get(id);
			if (!SIGNS_IN.includes(id)) return HARNESS_LABELS[id];
			return (
				HARNESS_LABELS[id] +
				(s === "signed-in" || s === "kept"
					? " (signed in)"
					: s === "failed"
						? " (sign-in failed)"
						: s === "unknown"
							? ""
							: " (not signed in)")
			);
		});
		const l = draft.limits ?? {};
		const slots = l.slots ?? fx.slotsDefault();
		p.note("Summary", [
			"Platform     " + platform,
			"Machine      " + name + (paired ? ` (${paired.machineId})` : ""),
			"Agents       " + ["Windlass", ...agentLine].join(", "),
			"Profiles     " + (draft.windlassSandbox ? "Hardened Docker, Docker + Windlass sandbox" : "Hardened Docker"),
			"Network      " + networkLine(draft.network),
			"Limits       " +
				`${slots} ${slots === 1 ? "slot" : "slots"}, ${l.snapshotDisk ?? storeDefaults.snapshotDisk} snapshots, keep ${l.keepFree ?? storeDefaults.keepFree} free`,
			"",
			"Setup starts the runner in the background with:",
			fx.startCommand(flags()),
		]);
		return ask(
			p.select({
				message: "Start the runner with these settings?",
				options: [
					{ value: "start", label: "Start the runner" },
					{ value: "back", label: "Go back" },
					{ value: "cancel", label: "Cancel" },
				],
			}),
			(v): Move => {
				if (v === "start") {
					fx.saveChoices(draft);
					return "next";
				}
				return v === "back" ? "back" : "cancel";
			},
		);
	};

	const startStep = async (): Promise<Move> => {
		const existing = stopped ? "stopped" : await fx.service();
		if (existing !== "absent" && !stopped) {
			const move = await ask(
				p.select({
					message: `A windlass-runner container ${existing === "running" ? "is running" : "exists"}. Replace it with these settings? The machine stays paired.`,
					options: [
						{ value: "replace", label: "Replace it" },
						{ value: "keep", label: "Keep it and stop here" },
					],
				}),
				v => (v === "replace" ? ("next" as const) : ("skip" as const)),
			);
			if (move === "skip") {
				if (existing === "running" && [...signIns.values()].includes("signed-in")) await fx.reportLogin();
				p.outro(
					existing === "running"
						? "Kept the running runner. Run setup again to apply new settings."
						: "Kept the container. Start it with: docker start windlass-runner",
				);
				return { outcome: "done" };
			}
			if (move !== "next") return move;
		}
		const replace = existing !== "absent";
		if (holding) {
			fx.releaseState();
			holding = false;
		}
		const started = await p
			.wait("Starting the runner", async () => {
				await fx.start(flags(), replace);
				return true;
			})
			.catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
		if (started instanceof Error) return { outcome: "failed", message: "The runner did not start: " + started.message };
		stopped = false;
		if (started === CANCEL || started === BACK)
			return {
				outcome: "done",
				message: "The runner is still starting in the background. Follow it with: docker logs -f windlass-runner",
			};
		const online = await p.wait("Waiting for the runner to come online", (signal, update) =>
			fx.waitOnline(signal, update),
		);
		if (online === CANCEL || online === BACK) {
			p.outro("The runner is still starting in the background. Follow it with: docker logs -f windlass-runner");
			return { outcome: "done" };
		}
		if (!online.ok) return { outcome: "failed", message: online.message };
		p.log("success", "Online");
		p.outro(
			`See this machine at ${platform}/machines. To change a setting later, run setup again (or setup agents, setup network, setup limits).`,
		);
		return { outcome: "done" };
	};

	const run: Record<Step, () => Promise<Move>> = {
		welcome,
		pair: pairStep,
		name: nameStep,
		agents: agentsStep,
		profile: profileStep,
		network: () => chooseNetwork(p, fx, draft, quick && loaded.saved),
		limits: () => chooseLimits(p, fx, draft, quick && loaded.saved),
		summary: summaryStep,
		start: startStep,
	};
	p.intro(
		`Windlass runner ${fx.version} · setup${mode.kind === "quick" ? " (only what is missing)" : mode.kind === "section" ? " · " + mode.section : connect ? " (connect)" : ""}`,
	);
	if ((await p.wait("Checking the runner's images", (_, update) => fx.prepare([], update))) === CANCEL)
		return { outcome: "cancelled" };
	let i = 0,
		direction = 1;
	try {
		while (i < steps.length) {
			const move = await run[steps[i]!]();
			if (typeof move === "object") {
				if (move.outcome === "failed" && move.message) p.log("error", move.message);
				return move;
			}
			if (move === "cancel") {
				p.outro(
					"Setup cancelled. Nothing more was changed." +
						(paired ? " The pairing is kept: run setup again to carry on." : ""),
				);
				return { outcome: "cancelled" };
			}
			if (move !== "skip") direction = move === "back" ? -1 : 1;
			else if (i === 0) direction = 1;
			i = Math.max(0, i + direction);
		}
		return { outcome: "done" };
	} finally {
		if (holding) fx.releaseState();
		if (stopped)
			await fx
				.restartService()
				.catch(() => p.log("warn", "Could not restart the runner. Start it with: docker start windlass-runner"));
	}
}
