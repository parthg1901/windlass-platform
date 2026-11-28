/**
 * The steps of `windlass-runner setup` (runner/src/setup-wizard.ts) driven by scripted answers, with fake
 * effects: no Docker, no platform, no terminal.
 *
 *   cd server && npx tsx --test ../scripts/runner-wizard-check.ts
 *
 * What it holds to: Back goes to the step before and keeps what was chosen; a failed or a skipped sign-in
 * is shown and setup carries on; Escape cancels, starts nothing and starts again a runner it stopped; the
 * start command is built from the answers; a re-run offers the saved answers; --quick asks only what is
 * missing; a section asks only its own questions; an expired code can be tried again; `--connect` asks
 * nothing, offers every agent without a sign-in and says what happens as events, stopping when pairing fails.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BACK, CANCEL, type Answer, type Choice, type Prompter } from "../runner/src/setup-prompt.js";
import { fromFlags, startFlags, storeDefaults, validChoices, type SetupChoices } from "../runner/src/setup-choices.js";
import { runWizard, type Mode, type WizardEffects, type SignInState } from "../runner/src/setup-wizard.js";
import type { MachineHarness } from "../runner/src/policy.js";
import { EventPrompter } from "../runner/src/setup-events.js";
import { parseSetupEvent, type SetupEvent } from "../server/src/contract/machine-setup.js";

type Step = {
	kind: "select" | "multiselect" | "text";
	match: RegExp;
	answer: unknown;
	check?: (question: any) => void;
};
const select = (match: RegExp, answer: unknown, check?: Step["check"]): Step => ({
	kind: "select",
	match,
	answer,
	check,
});
const multi = (match: RegExp, answer: unknown, check?: Step["check"]): Step => ({
	kind: "multiselect",
	match,
	answer,
	check,
});
const text = (match: RegExp, answer: unknown, check?: Step["check"]): Step => ({ kind: "text", match, answer, check });

class Script implements Prompter {
	readonly logs: string[] = [];
	readonly notes: { title: string; lines: string[] }[] = [];
	constructor(
		private readonly steps: Step[],
		readonly interactive = true,
	) {}
	private next(kind: Step["kind"], question: { message: string }) {
		const step = this.steps.shift();
		assert.ok(step, `no answer scripted for ${kind} "${question.message}"`);
		assert.equal(kind, step.kind, `expected a ${step.kind} matching ${step.match}, got ${kind} "${question.message}"`);
		assert.match(question.message, step.match);
		step.check?.(question);
		return step.answer;
	}
	done() {
		assert.deepEqual(
			this.steps.map(s => s.match.source),
			[],
			"answers left unasked",
		);
	}
	intro() {}
	outro(message: string) {
		this.logs.push("outro: " + message);
	}
	note(title: string, lines: string[]) {
		this.notes.push({ title, lines });
	}
	log(kind: string, message: string) {
		this.logs.push(kind + ": " + message);
	}
	async select<T>(q: { message: string; options: Choice<T>[]; initial?: T }) {
		return this.next("select", q) as Answer<T>;
	}
	async multiselect<T>(q: { message: string; options: Choice<T>[]; initial: T[] }) {
		return this.next("multiselect", q) as Answer<T[]>;
	}
	async text(q: { message: string; initial: string; validate?: (value: string) => string | undefined }) {
		const answer = this.next("text", q);
		if (typeof answer === "string") assert.equal(q.validate?.(answer), undefined, `"${answer}" refused`);
		return answer as Answer<string>;
	}
	async wait<T>(_: string, work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>) {
		return work(new AbortController().signal, () => {});
	}
}

const platform = "https://windlass.example.org";
function machine(
	o: {
		paired?: boolean;
		saved?: SetupChoices;
		service?: "running" | "stopped" | "absent";
		signedIn?: MachineHarness[];
		pairResults?: ({ ok: true } | { ok: false; message: string })[];
		failSignIn?: MachineHarness[];
		stopSignIn?: MachineHarness[];
		lock?: boolean[];
	} = {},
) {
	const did: string[] = [];
	let paired = o.paired ?? false,
		name: string | undefined = o.saved ? "Studio Mac" : undefined,
		service = o.service ?? "absent";
	let saved = o.saved;
	const locks = [...(o.lock ?? [])];
	const fx: WizardEffects = {
		version: "0.3.5",
		offered: ["claude", "opencode", "codex"],
		pairing: () => (paired ? { machineId: "m_" + "a".repeat(16), platform } : undefined),
		savedName: () => name,
		defaultName: async () => "docker-desktop",
		async saveName(n) {
			did.push("name " + n);
			name = n;
		},
		checkName: n => (n.trim() ? undefined : "Give a name."),
		checkPlatform: () => undefined,
		choices: () => ({ saved: saved !== undefined, choices: saved ?? {} }),
		saveChoices(c) {
			did.push("save " + JSON.stringify(c));
			saved = c;
		},
		slotsDefault: () => 2,
		checkSlots: n => (n > 8 ? "Too many slots for this computer." : undefined),
		checkSize: v => (/^\d+(GB|MB)$/.test(v) ? undefined : "Give a size such as 20GB."),
		checkDomains: list => (list.includes(" ") ? "Give DNS names." : undefined),
		service: async () => service,
		holdState() {
			const ok = locks.length ? locks.shift()! : true;
			did.push("lock " + ok);
			return ok;
		},
		releaseState() {
			did.push("unlock");
		},
		async stopService() {
			did.push("stop");
			service = "stopped";
		},
		async restartService() {
			did.push("restart");
			service = "running";
		},
		async pair(address, n, show) {
			did.push(`pair ${address} ${n}`);
			const result = o.pairResults?.shift() ?? { ok: true };
			if (result.ok) {
				show({ kind: "code", url: address, code: "WXYZ-1210" });
				show({ kind: "key", key: "K7Q2M-XR4TD" });
				show({ kind: "paired", account: "octocat" });
				paired = true;
			}
			return result;
		},
		async prepare(agents) {
			did.push("prepare " + agents.join(","));
		},
		signInState: async (id): Promise<SignInState> => (o.signedIn?.includes(id) ? "signed-in" : "signed-out"),
		async signIn(id) {
			did.push("sign in " + id);
			if (o.stopSignIn?.includes(id)) return "stopped";
			return o.failSignIn?.includes(id) ? { ok: false, reason: "Choose 1 or 2." } : { ok: true };
		},
		laterLogin: id => "docker exec -it windlass-runner windlass-runner login " + id,
		startCommand: flags => "docker run -d … run " + flags.join(" "),
		async start(flags, replace) {
			did.push(`start${replace ? " replace" : ""} ${flags.join(" ")}`);
			service = "running";
		},
		async waitOnline() {
			did.push("wait online");
			return { ok: true, message: "Online" };
		},
		async reportLogin() {
			did.push("report login");
		},
	};
	return { fx, did };
}
const run = (p: Script, fx: WizardEffects, mode: Mode = { kind: "full" }) => runWizard(p, fx, mode, { platform });

test("a first setup: Back keeps choices, a failed and a skipped sign-in carry on, and the runner starts with the answers", async () => {
	const { fx, did } = machine({ failSignIn: ["opencode"] });
	const p = new Script([
		select(/Set up this machine/, "go"),
		text(/Machine name/, BACK, q => {
			assert.equal(q.initial, "docker-desktop");
			assert.match(q.hint, /name of Docker's VM/);
		}),
		select(/^Pairing$/, "keep"),
		text(/Machine name/, "Studio Mac"),
		// Only OpenCode signs in: Claude Code and Codex pay with the account's plans and keys.
		multi(/Which agents/, ["claude", "opencode"], q => assert.deepEqual(q.initial, [])),
		select(/OpenCode: sign in now/, "now"),
		select(/Docker profiles/, BACK, q => assert.equal(q.initial, true)),
		multi(/Which agents/, ["claude", "opencode"], q => assert.deepEqual(q.initial, ["claude", "opencode"])),
		select(/OpenCode: sign in now/, BACK),
		multi(/Which agents/, ["codex", "opencode"]),
		select(/OpenCode: sign in now/, "skip"),
		select(/Docker profiles/, false),
		select(/network/, "domains", q => assert.equal(q.initial, "restricted")),
		text(/Public hosts/, BACK, q => {
			assert.equal(q.initial, "@npm,@pypi,@github");
			assert.equal(q.validate("@npm, bad host"), "Give DNS names.");
		}),
		select(/network/, "domains"),
		text(/Public hosts/, "@npm,example.com"),
		select(/^Limits: 2 turn slots, 10GB for setup snapshots, keep 40GB of disk free$/, "change"),
		text(/Turn slots/, "3", q => {
			assert.equal(q.validate("9"), "Too many slots for this computer.");
			assert.match(q.validate("0")!, /1 to 64/);
		}),
		text(/snapshots/, BACK),
		text(/Turn slots/, "4", q => assert.equal(q.initial, "3")),
		text(/snapshots/, "20GB"),
		text(/keep free/, "0GB"),
		select(/Start the runner with these settings/, "start"),
	]);
	assert.deepEqual(await run(p, fx), { outcome: "done" });
	p.done();
	assert.ok(
		p.logs.includes(
			"error: OpenCode was not signed in: Choose 1 or 2. Setup carries on. Sign it in later with: docker exec -it windlass-runner windlass-runner login opencode",
		),
		p.logs.join("\n"),
	);
	assert.ok(
		p.logs.includes(
			"info: OpenCode is not signed in. Sign it in later with: docker exec -it windlass-runner windlass-runner login opencode",
		),
	);
	assert.ok(p.logs.includes("success: Paired with octocat. If that is not you, run setup again and pair again."));
	const pairing = p.notes.find(n => n.title === "Pair this machine")!;
	assert.deepEqual(pairing.lines.slice(0, 3), [
		`1. Open      ${platform}/machines/add`,
		"2. Enter     WXYZ-1210",
		"3. Check     the page shows machine key K7Q2M-XR4TD",
	]);
	const summary = p.notes.find(n => n.title === "Summary")!.lines.join("\n");
	assert.match(summary, /Agents {7}Windlass, Codex, OpenCode \(not signed in\)/);
	assert.match(summary, /Limits {7}4 slots, 20GB snapshots, keep 0GB free/);
	const choices = {
		agents: ["codex", "opencode"],
		windlassSandbox: false,
		network: { mode: "restricted", domains: ["@npm", "example.com"] },
		limits: { slots: 4, snapshotDisk: "20GB", keepFree: "0GB" },
	};
	const flags = `--platform ${platform} --harness codex --harness opencode --allow-profile docker-hardened --egress restricted --egress-domains @npm,example.com --slots 4 --snapshot-disk 20GB --keep-free 0GB`;
	assert.deepEqual(did, [
		"prepare ",
		"lock true",
		`pair ${platform} docker-desktop`,
		"name Studio Mac",
		"prepare claude,opencode",
		"sign in opencode",
		"prepare claude,opencode",
		"prepare codex,opencode",
		"save " + JSON.stringify(choices),
		"unlock",
		"start " + flags,
		"wait online",
	]);
	assert.ok(validChoices(JSON.parse(JSON.stringify(choices))));
});

test("Escape cancels: nothing more starts, and a runner setup stopped to pair again runs again", async () => {
	const { fx, did } = machine({ paired: true, service: "running", lock: [false, true], saved: { agents: [] } });
	const p = new Script([
		select(/Go through this machine's settings/, "go"),
		select(/^Pairing$/, "again"),
		select(/runner is running on this machine\. Stop it to pair again/, "stop"),
		text(/Machine name/, CANCEL),
	]);
	assert.deepEqual(await run(p, fx), { outcome: "cancelled" });
	p.done();
	assert.deepEqual(did, [
		"prepare ",
		"lock false",
		"stop",
		"lock true",
		`pair ${platform} Studio Mac`,
		"unlock",
		"restart",
	]);
	assert.match(p.logs.at(-1)!, /Setup cancelled\. Nothing more was changed\. The pairing is kept/);
});

test("a re-run offers the saved answers, keeps the pairing and replaces the runner only when asked", async () => {
	const saved: SetupChoices = {
		agents: ["claude", "opencode"],
		windlassSandbox: false,
		network: { mode: "restricted", allow: ["git.internal"], domains: ["@npm", "example.com"] },
		limits: { slots: 4, snapshotDisk: "20GB", keepFree: "0GB" },
	};
	const { fx, did } = machine({ paired: true, saved, service: "running" });
	const p = new Script([
		select(/Go through/, "go"),
		select(/^Pairing$/, "keep", q => assert.equal(q.initial, "keep")),
		text(/Machine name/, "Studio Mac", q => assert.equal(q.initial, "Studio Mac")),
		multi(/Which agents/, ["claude", "opencode"], q => {
			assert.deepEqual(q.initial, ["claude", "opencode"]);
			assert.deepEqual(
				q.options.map((o: Choice<string>) => o.hint),
				["uses your plans and keys", "not signed in", "uses your plans and keys"],
			);
		}),
		select(/OpenCode: sign in now/, "now"),
		select(/Docker profiles/, false, q => assert.equal(q.initial, false)),
		select(/network/, "domains", q => assert.equal(q.initial, "domains")),
		text(/Public hosts/, "@npm,example.com", q => assert.equal(q.initial, "@npm,example.com")),
		select(/^Limits: 4 turn slots, 20GB for setup snapshots, keep 0GB of disk free$/, "keep"),
		select(/Start the runner/, "start"),
		select(/A windlass-runner container is running\. Replace it/, "keep"),
	]);
	assert.deepEqual(await run(p, fx), { outcome: "done" });
	p.done();
	// The private names given to an earlier run command stay; no lock is taken beside the running runner.
	assert.ok(did.some(d => d.startsWith("save ") && JSON.parse(d.slice(5)).network.allow[0] === "git.internal"));
	assert.ok(!did.some(d => d.startsWith("lock") || d.startsWith("start") || d.startsWith("pair")), did.join("\n"));
	assert.deepEqual(did.slice(-1), ["report login"]);
});

test("stopping a sign-in with Ctrl+C stops setup", async () => {
	const { fx, did } = machine({ paired: true, saved: { agents: ["opencode"] }, stopSignIn: ["opencode"] });
	const p = new Script([select(/OpenCode: sign in now/, "now")]);
	assert.deepEqual(await run(p, fx, { kind: "section", section: "opencode" }), { outcome: "cancelled" });
	p.done();
	assert.ok(!did.some(d => d.startsWith("save") || d.startsWith("start")), did.join("\n"));
});

test("--quick asks only what is missing", async () => {
	const saved: SetupChoices = {
		agents: ["claude", "opencode"],
		windlassSandbox: true,
		network: { mode: "open" },
		limits: {},
	};
	const { fx, did } = machine({ paired: true, saved, service: "stopped" });
	const p = new Script([
		select(/Go through/, "go"),
		select(/OpenCode: sign in now/, "now"),
		select(/Start the runner/, "start"),
		select(/A windlass-runner container exists\. Replace it/, "replace"),
	]);
	assert.deepEqual(await run(p, fx, { kind: "quick" }), { outcome: "done" });
	p.done();
	assert.deepEqual(did, [
		"prepare ",
		"prepare opencode",
		"sign in opencode",
		"save " + JSON.stringify(saved),
		`start replace --platform ${platform} --harness claude --harness opencode --allow-profile docker-hardened --allow-profile docker-windlass-sandbox --egress open`,
		"wait online",
	]);
});

test("a section asks only its own questions, and needs a pairing", async () => {
	const saved: SetupChoices = { agents: ["codex"], windlassSandbox: true, network: { mode: "restricted" } };
	const { fx, did } = machine({ paired: true, saved, service: "absent" });
	const p = new Script([select(/OpenCode: sign in now/, "now"), select(/Start the runner/, "start")]);
	assert.deepEqual(await run(p, fx, { kind: "section", section: "opencode" }), { outcome: "done" });
	p.done();
	assert.ok(
		did.includes(
			`start --platform ${platform} --harness codex --harness opencode --allow-profile docker-hardened --allow-profile docker-windlass-sandbox --egress restricted`,
		),
		did.join("\n"),
	);
	const unpaired = machine();
	const q = new Script([]);
	assert.deepEqual(await run(q, unpaired.fx, { kind: "section", section: "limits" }), {
		outcome: "failed",
		message: "Pair this machine first: run setup.",
	});
});

test("an expired code can be tried again; without a terminal it ends setup", async () => {
	const expired = {
		ok: false as const,
		message: "The pairing code expired, so re-run the setup command to get a new code.",
	};
	const { fx, did } = machine({ pairResults: [expired] });
	const p = new Script([
		select(/Set up this machine/, "go"),
		select(/Try again/, "again"),
		text(/Machine name/, CANCEL),
	]);
	assert.deepEqual(await run(p, fx), { outcome: "cancelled" });
	p.done();
	assert.ok(p.logs.includes("error: " + expired.message));
	assert.equal(did.filter(d => d.startsWith("pair ")).length, 2);
	const quiet = machine({ pairResults: [expired] });
	const lines = new Script([select(/Set up this machine/, "go")], false);
	assert.deepEqual(await run(lines, quiet.fx), { outcome: "failed" });
	assert.ok(lines.logs.includes("error: " + expired.message));
	lines.done();
});

/** The connect mode's prompter, writing its events where the check reads them back. */
function events() {
	const lines: string[] = [];
	const out = { write: (chunk: string) => lines.push(...chunk.split("\n").filter(Boolean)) };
	const prompter = new EventPrompter(out as unknown as NodeJS.WritableStream);
	const read = (): SetupEvent[] =>
		lines.map(line => {
			const event = parseSetupEvent(line);
			assert.ok(event, `not an event: ${line}`);
			return event;
		});
	return { prompter, read };
}

test("--connect asks nothing, offers every agent without a sign-in and starts the runner", async () => {
	const { fx, did } = machine({ service: "running" });
	const { prompter, read } = events();
	assert.deepEqual(await runWizard(prompter, fx, { kind: "connect" }, { platform }), { outcome: "done" });
	const said = read();
	assert.deepEqual(
		said.filter(e => e.event === "pairing"),
		[{ event: "pairing", code: "WXYZ-1210", key: "K7Q2M-XR4TD" }],
	);
	assert.ok(!did.some(d => d.startsWith("sign in")));
	assert.ok(did.includes("prepare claude,opencode,codex"));
	assert.deepEqual(validChoices(JSON.parse(did.find(d => d.startsWith("save "))!.slice(5))), {
		agents: ["claude", "opencode", "codex"],
		windlassSandbox: true,
		network: { mode: "restricted" },
		limits: storeDefaults,
	});
	// The running runner is stopped to pair again, then replaced with the new settings.
	const start = did.find(d => d.startsWith("start "));
	assert.match(start ?? "", /^start replace --platform \S+ --harness claude --harness opencode --harness codex /);
	assert.ok(did.indexOf("stop") < did.findIndex(d => d.startsWith("pair ")));
	assert.ok(said.some(e => e.event === "log" && /plans and keys connected to your account/.test(e.text)));
	assert.equal(said.at(-1)?.event, "done");
});

test("--connect stops when the pairing is denied, keeps a pairing it has and leaves a running runner alone", async () => {
	const denied = {
		ok: false as const,
		message: "The pairing code expired or was denied, so re-run the setup command to get a new code.",
	};
	const refused = machine({ pairResults: [denied] });
	const first = events();
	assert.deepEqual(await runWizard(first.prompter, refused.fx, { kind: "connect" }, { platform }), {
		outcome: "failed",
	});
	assert.ok(first.read().some(e => e.event === "log" && e.level === "error" && e.text === denied.message));
	assert.equal(refused.did.filter(d => d.startsWith("pair ")).length, 1);
	assert.ok(!refused.did.some(d => /^(save|start|prepare \w)/.test(d)), refused.did.join("; "));
	const kept = machine({ paired: true, saved: { agents: ["codex"], windlassSandbox: false } });
	const again = events();
	assert.deepEqual(await runWizard(again.prompter, kept.fx, { kind: "connect" }, { platform }), { outcome: "done" });
	assert.ok(!kept.did.some(d => d.startsWith("pair ")));
	assert.ok(again.read().some(e => e.event === "log" && /already paired/.test(e.text)));
	assert.match(
		kept.did.find(d => d.startsWith("start ")) ?? "",
		/--harness codex --allow-profile docker-hardened --egress/,
	);
	// A paired machine whose runner runs is left alone.
	const running = machine({ paired: true, service: "running" });
	const quiet = events();
	assert.deepEqual(await runWizard(quiet.prompter, running.fx, { kind: "connect" }, { platform }), {
		outcome: "done",
	});
	assert.deepEqual(running.did, ["prepare "]);
	const last = quiet.read().at(-1);
	assert.ok(last?.event === "done" && /Nothing was changed/.test(last.text));
});

test("the start flags come from the choices", () => {
	assert.deepEqual(startFlags(platform, {}), [
		"--platform",
		platform,
		"--allow-profile",
		"docker-hardened",
		"--egress",
		"restricted",
	]);
	assert.deepEqual(
		startFlags(platform, {
			agents: ["claude"],
			screenshots: true,
			windlassSandbox: true,
			network: { mode: "open", allow: ["a.internal"], domains: ["x.org"] },
			limits: { snapshotDisk: "10GB", keepFree: "40GB" },
			extra: ["--slot-cpus", "2"],
		}),
		[
			"--platform",
			platform,
			"--harness",
			"claude",
			"--screenshots",
			"--allow-profile",
			"docker-hardened",
			"--allow-profile",
			"docker-windlass-sandbox",
			"--egress",
			"open",
			"--slot-cpus",
			"2",
		],
	);
	assert.deepEqual(
		startFlags(platform, {
			network: { mode: "restricted", allow: ["a.internal"] },
			limits: { slots: 3, snapshotDisk: "5GB", keepFree: "40000MB" },
		}),
		[
			"--platform",
			platform,
			"--allow-profile",
			"docker-hardened",
			"--egress",
			"restricted",
			"--egress-allow",
			"a.internal",
			"--slots",
			"3",
			"--snapshot-disk",
			"5GB",
		],
	);
	// The Machines page's commands: the sandbox box turned off says --allow-profile docker-hardened, and setup starts with it off.
	assert.equal(fromFlags({ "allow-profile": ["docker-hardened"] }, { windlassSandbox: true }).windlassSandbox, false);
	assert.equal(fromFlags({ "allow-profile": ["docker-windlass-sandbox"] }, {}).windlassSandbox, true);
	assert.equal(fromFlags({}, {}).windlassSandbox, undefined);
	assert.equal(validChoices({ agents: ["windlass"] }), null);
	assert.equal(validChoices({ limits: { slots: 0 } }), null);
	assert.equal(validChoices({ network: { mode: "everything" } }), null);
	assert.equal(validChoices([]), null);
});
