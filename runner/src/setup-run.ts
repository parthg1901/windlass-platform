// Runs the setup wizard in a one-off container with the Docker socket and runner state volume.
import { statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { validMachineName } from "../../server/src/runner/control.js";
import { docker } from "../../server/src/sandbox/docker.js";
import { parseStoreSize } from "../../server/src/sandbox/store-limits.js";
import { pair } from "./control.js";
import { Executor, retirePairingRelays } from "./docker-executor.js";
import { domainList } from "./egress-policy.js";
import { resolveMachineName } from "./machine-name.js";
import { importOpenCode } from "./opencode-import.js";
import { changeProviderLogin, installedProvider, storeProvider, terminalQuestion } from "./opencode-login.js";
import { requestLoginReport } from "./pair-command.js";
import { harnessImage, prepareImages, type MachineHarness } from "./policy.js";
import { laterLogin, setupImageAndMounts, shellCommand } from "./setup.js";
import { HARNESSES, fromFlags, validChoices, type SetupChoices } from "./setup-choices.js";
import { EventPrompter } from "./setup-events.js";
import { LinePrompter } from "./setup-lines.js";
import { TuiPrompter } from "./setup-tui.js";
import { SECTIONS, runWizard, type Mode, type PairEvent, type Section, type WizardEffects } from "./setup-wizard.js";
import { localSizing } from "./sizing.js";
import {
	directory,
	loadPair,
	origin,
	pairingEgress,
	pairingProfiles,
	read,
	releaseLock,
	RunnerError,
	save,
	tryLock,
	VERSION,
} from "./state.js";

type Values = Record<string, string | boolean | string[] | undefined>;
const SERVICE = "windlass-runner";
const ONLINE_WAIT_MS = 180_000;

export async function signInForSetup(
	machine: Executor,
	agent: MachineHarness,
	signal: AbortSignal,
	importFile?: string,
) {
	// Claude Code and Codex pay with the account's plans and keys: setup signs neither in.
	if (agent !== "opencode") return;
	const login = (provider?: string) => changeProviderLogin(machine, true, signal, provider);
	if (
		importFile &&
		(await importOpenCode(
			importFile,
			q => terminalQuestion(q, signal),
			(provider, key) => storeProvider(machine, { provider, key }),
			login,
		))
	)
		return;
	await login();
}

/** Setup with `--harness` keeps the earlier flow: line prompts, then it prints the start command. */
export const wantsWizard = (values: Values) => !(values.harness as string[] | undefined)?.length;

/** The pairing's lines (control.ts `pair`), as the wizard shows them. */
export function pairEvent(line: string): PairEvent {
	let m = /^Open (\S+)\/machines\/add and enter (\S+)$/.exec(line);
	if (m) return { kind: "code", url: m[1]!, code: m[2]! };
	if ((m = /^Machine key: ([^.\s]+)\./.exec(line))) return { kind: "key", key: m[1]! };
	if ((m = /^Paired with (.*)\. If that is not you/.exec(line))) return { kind: "paired", account: m[1]! };
	return { kind: "line", text: line };
}

/** The saved choices, or for a machine set up before setup.json what its pairing keeps. */
function savedChoices(): { saved: boolean; choices: SetupChoices } {
	const stored = read("setup.json");
	if (stored !== undefined) {
		const valid = validChoices(stored);
		if (!valid) throw new RunnerError("Invalid setup.json. Repair or remove that file in the runner state volume.");
		return { saved: true, choices: valid };
	}
	const paired = loadPair();
	if (!paired?.key) return { saved: false, choices: {} };
	const id = paired.current.machineId;
	const egress = read(`egress-${id}.json`) === undefined ? undefined : pairingEgress(id);
	return {
		saved: false,
		choices: {
			windlassSandbox: pairingProfiles(id).includes("docker-windlass-sandbox"),
			...(egress && {
				network: {
					mode: egress.mode,
					...(egress.allow.length && { allow: egress.allow }),
					...(egress.domains && { domains: egress.domains }),
				},
			}),
		},
	};
}

export async function setupWizard(sections: string[], values: Values): Promise<void> {
	if (sections.length > 1 || (sections[0] !== undefined && !(SECTIONS as readonly string[]).includes(sections[0])))
		throw new RunnerError(`Use setup, setup --quick, or setup with one of: ${SECTIONS.join(", ")}.`);
	if (sections.length && values.quick) throw new RunnerError("Use --quick with setup alone.");
	if ((sections.length || values.quick) && values.connect) throw new RunnerError("Use --connect with setup alone.");
	const mode: Mode = sections.length
		? { kind: "section", section: sections[0] as Section }
		: values.quick
			? { kind: "quick" }
			: values.connect
				? { kind: "connect" }
				: { kind: "full" };
	const launch = await setupImageAndMounts();
	const platform = typeof values.platform === "string" ? origin(values.platform) : undefined;
	const loaded = savedChoices();
	const choices = { saved: loaded.saved, choices: fromFlags(values, loaded.choices) };
	const sizing = Object.fromEntries(
		(["slot-cpus", "slot-memory", "sandbox-memory"] as const).flatMap(k =>
			values[k] === undefined ? [] : [[k, values[k] as string]],
		),
	);
	const machine = () => {
		const paired = loadPair();
		if (!paired?.key) throw new RunnerError("Pair this machine first: run setup.");
		return new Executor(paired.current, { slots: localSizing(sizing) });
	};

	const fx: WizardEffects = {
		version: VERSION,
		offered: HARNESSES.filter(id => harnessImage(id)),
		pairing() {
			const p = loadPair();
			return p?.key ? { machineId: p.current.machineId, platform: p.platform } : undefined;
		},
		savedName() {
			const given = values.name as string | undefined,
				saved = read("name.json");
			return given ?? (validMachineName(saved) ? saved : undefined);
		},
		defaultName: () => resolveMachineName(),
		async saveName(name) {
			await resolveMachineName(name);
		},
		checkName: name => (validMachineName(name.trim()) ? undefined : "Give a printable name of 1 to 64 characters."),
		checkPlatform(address) {
			try {
				origin(address);
			} catch (error) {
				return (error as Error).message;
			}
		},
		choices: () => choices,
		saveChoices(c) {
			save("setup.json", c);
		},
		slotsDefault: () => localSizing(sizing).max,
		checkSlots(slots) {
			try {
				localSizing({ ...sizing, slots: String(slots) });
			} catch (error) {
				return (error as Error).message.replaceAll("--slots (or --max-turns)", "the slots");
			}
		},
		checkSize(value, free) {
			const bytes = parseStoreSize(value);
			if (bytes === null || (!free && bytes === 0))
				return `Give a size such as 20GB or 512MB${free ? " (0GB keeps nothing free)" : ""}.`;
		},
		checkDomains(list) {
			try {
				domainList(list);
			} catch (error) {
				return (error as Error).message.replace(/^Use --egress-domains with restricted and/, "Give");
			}
		},
		async service() {
			const found = await docker(["container", "inspect", "--format", "{{.State.Running}}", SERVICE]);
			return found.code !== 0 ? "absent" : found.stdout.trim() === "true" ? "running" : "stopped";
		},
		holdState: () => tryLock(),
		releaseState: releaseLock,
		async stopService() {
			await docker(["stop", SERVICE], { check: true });
		},
		async restartService() {
			await docker(["start", SERVICE], { check: true });
		},
		async pair(address, name, show, signal) {
			const prior = loadPair();
			const result = await pair(address, signal, line => show(pairEvent(line)), name, undefined, true);
			if (!result.paired) return { ok: false, message: result.idle! };
			if (prior) await retirePairingRelays(new Executor(prior.current, { slots: localSizing(sizing) }));
			return { ok: true };
		},
		async prepare(agents, update) {
			// Docker's pull progress goes to stderr: show its last line, not every line.
			const write = process.stderr.write;
			let pending = "";
			process.stderr.write = ((chunk: string | Uint8Array) => {
				pending += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
				const lines = pending.split(/\r?\n/);
				pending = lines.pop()!;
				const last = lines
					.map(l => l.trim())
					.filter(Boolean)
					.at(-1);
				if (last) update(last.slice(0, 100));
				return true;
			}) as typeof process.stderr.write;
			try {
				await prepareImages(agents, !!choices.choices.screenshots, "setup");
			} finally {
				process.stderr.write = write;
			}
		},
		async signInState(agent) {
			if (agent !== "opencode") return "unknown";
			try {
				return (await installedProvider(machine())) ? "signed-in" : "signed-out";
			} catch {
				return "unknown";
			}
		},
		async signIn(agent: MachineHarness) {
			const m = machine();
			const abort = new AbortController();
			const stop = () => abort.abort();
			process.on("SIGINT", stop);
			try {
				await signInForSetup(m, agent, abort.signal, launch.importFile);
				return { ok: true as const };
			} catch (error) {
				if (abort.signal.aborted) return "stopped";
				// Only the runner's own messages are shown: another error's text could hold a credential-bearing URL.
				return {
					ok: false as const,
					reason: error instanceof RunnerError ? error.message : "the sign-in did not finish.",
				};
			} finally {
				process.off("SIGINT", stop);
			}
		},
		laterLogin,
		startCommand(flags) {
			// One option to a line, as the Machines page shows a command.
			const words = [...launch.command, "run", ...flags];
			const image = launch.command.length - 1;
			return words
				.map(
					(word, i) =>
						(i > 0 &&
						(word === "-v" ||
							word === "-e" ||
							i === image ||
							(i > image + 1 && /^--/.test(word)) ||
							(word === "--log-driver" && i < image))
							? " \\\n  "
							: i
								? " "
								: "") + shellCommand([word]),
				)
				.join("");
		},
		async start(flags, replace) {
			if (replace) await docker(["rm", "-f", SERVICE], { check: true });
			const [, ...args] = launch.command;
			const started = await docker([...args, "run", ...flags], { timeoutMs: 120_000 });
			if (started.code !== 0) throw new RunnerError(started.stderr.trim().split("\n").at(-1) || "docker run failed.");
		},
		async waitOnline(signal, update) {
			const since = Date.now() - 2000,
				file = join(directory, "status.json");
			let last = "Starting",
				checks = 0;
			while (!signal.aborted && Date.now() - since < ONLINE_WAIT_MS) {
				await wait(1000, undefined, { signal }).catch(() => {});
				let connection: string | undefined;
				try {
					if (statSync(file).mtimeMs >= since)
						connection = (read("status.json") as { connection?: unknown } | undefined)?.connection as
							| string
							| undefined;
				} catch {}
				if (typeof connection === "string" && connection !== last) {
					last = connection;
					if (last !== "Online") update(connection.slice(0, 160));
				}
				if (last === "Online") return { ok: true, message: "Online" };
				if (++checks % 3 === 0 && (await fx.service()) !== "running")
					return { ok: false, message: "The runner stopped. Read why with: docker logs windlass-runner" };
			}
			return {
				ok: false,
				message: `The runner is not online after ${ONLINE_WAIT_MS / 60_000} minutes (last: ${last}). Follow it with: docker logs -f windlass-runner`,
			};
		},
		reportLogin: () => requestLoginReport(true),
	};

	const tui = !!process.stdin.isTTY && !!process.stdout.isTTY && !values["no-tui"];
	const prompter = mode.kind === "connect" ? new EventPrompter() : tui ? new TuiPrompter() : new LinePrompter();
	const result = await runWizard(prompter, fx, mode, { platform });
	if (result.outcome !== "done") process.exitCode = 1;
	if (result.message && result.outcome === "done") prompter.log("info", result.message);
}
