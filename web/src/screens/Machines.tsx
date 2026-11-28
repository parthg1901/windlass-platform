import {
	MACHINE_CONNECT_COMMAND,
	MAX_MACHINES,
	type MachineClaim,
	type MachineSummary,
	type MachineWarning,
	type MachinesInfo,
} from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { hasReason } from "../api/client";
import { CopyButton } from "../components/Copy";
import { Command } from "../components/Command";
import { Waiting } from "../components/ui/StatusTag";
import { Dialog } from "../components/Dialog";
import {
	CheckIcon,
	ChevronIcon,
	InfoIcon,
	MachineIcon,
	Mark,
	PencilIcon,
	PlusIcon,
	TrashIcon,
	WarnIcon,
} from "../components/Icons";
import { HARNESS_NAMES, loginCommand, signInWords } from "../lib/acp";
import { absoluteTime, clockTime, plural, relativeTime, spelledDuration } from "../lib/format";
import { linkProps, navigate } from "../lib/router";
import { cellId } from "../lib/connections";
import { useApp, useAuth } from "../state/app";
import { useAccount, useNow } from "../state/hooks";
import { DefaultPlace, DefaultPlaceSkeleton } from "../components/RunSettings";
import { LoadError, Segmented, SkeletonRows } from "../components/ui";
import { SOURCE_NAMES } from "../lib/models";
import {
	MAX_WHEN_TO_USE,
	diskSize,
	machineDetailsProblem,
	machineHostNote,
	machineLabel,
	sandboxLimit,
	settingsKeyUpgrade,
	storeLimits,
	tagsOf,
} from "../lib/machines";
import { MachineState, SandboxLine } from "../components/MachineState";
import { type MachinesState, useMachines } from "../state/machines";
import { ORCHESTRATOR_CHOICES, orchestratorNote, orchestratorOf, type Orchestrator } from "../lib/placement";
import { Check } from "../components/ui/Check";
import { AgentGlyph } from "../components/ui/Pill";

/** The command that starts the runner on a machine, as `MachinesInfo` describes it; null while no runner image is published. */
function installCommand(
	info: MachinesInfo,
	agents: { claude?: boolean; openCode?: boolean; codex?: boolean; windlassSandbox?: boolean } = {},
	setup?: { importKeys: boolean },
): string | null {
	if (info.runnerImage === null) return null;
	return [
		(setup
			? "docker run -it --rm" + (agents.codex ? " --log-driver none" : "")
			: "docker run -d --name windlass-runner --restart unless-stopped") + " \\",
		...(setup ? [] : ["  --log-driver json-file --log-opt max-size=16m --log-opt max-file=3 \\"]),
		"  -v /var/run/docker.sock:/var/run/docker.sock \\",
		"  -v windlass-runner:/var/lib/windlass-runner \\",
		...(agents.openCode && setup?.importKeys
			? ['  --mount "type=bind,src=$HOME/.local/share/opencode,dst=/import/opencode,readonly" \\']
			: []),
		`  ${info.runnerImage}${setup ? " setup" : ""} --platform ${info.platformUrl}${agents.claude ? " --harness claude" : ""}${agents.openCode ? " --harness opencode" : ""}${agents.codex ? " --harness codex" : ""}${agents.windlassSandbox ? " --allow-profile docker-windlass-sandbox" : " --allow-profile docker-hardened"}`,
	].join("\n");
}

/** The one-line install the platform serves (server/src/install-script.ts); null while no runner image is published. */
export function oneLineInstall(info: MachinesInfo): string | null {
	return info.runnerImage === null ? null : `curl -fsSL ${info.platformUrl}/install.sh | sh`;
}

/** A code as it is typed: the eight characters the runner printed, in two groups of four. */
function formatCode(typed: string): string {
	const characters = typed
		.toUpperCase()
		.replace(/[^0-9A-Z]/g, "")
		.slice(0, 8);
	return characters.length > 4 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : characters;
}

/** What the runner reported that needs the user, each only while it holds. */
function Warning({
	warning,
	machine,
	info,
	now,
}: {
	warning: MachineWarning;
	machine: MachineSummary;
	info: MachinesInfo;
	now: number;
}) {
	if (warning.kind === "signing-disabled")
		return (
			<p className="callout callout-warn" role="status">
				<WarnIcon />
				This runner requires signed connections. Ask the platform operator to enable them.
			</p>
		);
	if (warning.kind === "outdated") {
		const install = installCommand(info);
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-text">
						This machine's runner is {machine.runnerVersion}, so it cannot connect. Update your runner to{" "}
						{info.minRunnerVersion} or later.{" "}
						{install
							? info.platformFingerprint
								? "Update it on the machine and pair again to pin the platform key."
								: "Update it on the machine: its volume keeps the key, so it stays paired."
							: "No newer runner is published yet."}
					</p>
					{install ? <Command text={`docker rm -f windlass-runner\n${install}`} label="The update command" /> : null}
				</div>
			</div>
		);
	}
	if (warning.kind === "docker") {
		return (
			<div className="callout callout-warn" role="status">
				<WarnIcon />
				<div>
					<p className="callout-text">
						The runner cannot reach Docker on this machine, so no agent can start here. The runner reports:
					</p>
					<p className="callout-detail">{warning.reason}</p>
				</div>
			</div>
		);
	}
	if (warning.kind === "clock") {
		const off = spelledDuration(Math.abs(warning.offsetSeconds) * 1000);
		return (
			<p className="callout callout-warn" role="status">
				<WarnIcon />
				<span>
					This machine's clock is {off} {warning.offsetSeconds > 0 ? "ahead of" : "behind"} the platform's, so a turn's
					access token can read as expired too early or too late. Set the clock from the network, for example with{" "}
					<code>timedatectl set-ntp true</code>.
				</span>
			</p>
		);
	}
	return (
		<p className="callout callout-warn" role="status">
			<WarnIcon />
			<span>
				This machine's key was used from two places at{" "}
				<span title={absoluteTime(warning.at)}>{clockTime(warning.at, now)}</span>; if you did not copy it, remove the
				machine.
			</span>
		</p>
	);
}

/** The switch that says whether saved secrets go to the machine: changed at once, and the list it answers with says what it is. */
function SecretsSwitch({ machine, onChanged }: { machine: MachineSummary; onChanged(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const set = (send: boolean) => {
		setBusy(true);
		setError(null);
		client
			.user(auth)
			.setMachineSecrets({ machineId: machine.machineId, send })
			.then(
				list => {
					onChanged(list);
					setBusy(false);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(false);
				},
			);
	};
	return (
		<div>
			<Check checked={machine.sendSecrets} disabled={busy} onChange={on => set(on)}>
				<span className="check-name">Send saved secrets to this machine</span>
				<span className="check-means">
					{machine.sendSecrets
						? "Each turn of an agent here gets the saved secrets it is allowed, the repository's and the account's. Turned off, none are sent, and what needs one fails on this machine."
						: "No saved secret is sent here, so what needs one fails on this machine. Turned on, each agent gets them from its next turn."}
				</span>
			</Check>
			{error ? (
				<p className="field-note tone-bad" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

/**
 * Whether features may place subtasks on the machine (`MachineSummary.orchestrator`): a segmented
 * choice of three, saved as soon as it is chosen with `setMachineDetails`, which keeps the note and tags.
 */
function PlacementPolicy({ machine, onChanged }: { machine: MachineSummary; onChanged(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<Orchestrator | null>(null);
	const [error, setError] = useState<string | null>(null);
	const ids = { label: useId(), means: useId() };
	const saved = orchestratorOf(machine);
	const shown = busy ?? saved;
	const set = (orchestrator: Orchestrator) => {
		if (orchestrator === saved || busy) return;
		setBusy(orchestrator);
		setError(null);
		client
			.user(auth)
			.setMachineDetails({
				machineId: machine.machineId,
				whenToUse: machine.whenToUse ?? "",
				tags: machine.tags ?? [],
				orchestrator,
			})
			.then(
				list => {
					onChanged(list);
					setBusy(null);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(null);
				},
			);
	};
	return (
		<div className="machine-policy">
			<p className="machine-policy-label" id={ids.label}>
				Subtasks of features
			</p>
			<Segmented
				className="machine-policy-choice"
				size="sm"
				aria-labelledby={ids.label}
				aria-describedby={ids.means}
				value={shown}
				disabled={busy !== null}
				onChange={set}
				options={ORCHESTRATOR_CHOICES.map(choice => ({ value: choice.id, label: choice.label, title: choice.means }))}
			/>
			<p className={`field-note${error ? " tone-bad" : ""}`} id={ids.means} role={error ? "alert" : undefined}>
				{error ?? ORCHESTRATOR_CHOICES.find(choice => choice.id === shown)!.means}
			</p>
		</div>
	);
}

function machineCapacity({ slots, turns, host }: MachineSummary) {
	const parts: string[] = [];
	if (slots) {
		const memory = Number((slots.unit.memoryBytes / 2 ** 30).toFixed(2));
		parts.push(`${slots.max} slot${slots.max === 1 ? "" : "s"} × ${slots.unit.cpus} CPU · ${memory} GB`);
		parts.push(`${slots.busy} busy${slots.queued ? `, ${slots.queued} queued` : ""}`);
	} else if (turns) {
		parts.push(
			`${turns.running} of ${turns.max ?? "any number of"} turns running${turns.queued ? `, ${turns.queued} queued` : ""}`,
		);
	}
	if (host) {
		const cpus = slots ? `${host.cpus} CPUs` : `${host.sandboxCpus} of ${host.cpus} CPUs for sandboxes`;
		parts.push(`${cpus}, ${diskSize(host.memoryFreeBytes)} of ${diskSize(host.memoryBytes)} memory free`);
	}
	return parts.join(" · ");
}

function MachineAgents({ machine }: { machine: MachineSummary }) {
	const harnesses = machine.harnesses ?? [];
	if (harnesses.length === 0) return null;
	return (
		<ul className="machine-agents" aria-label="Agents on this machine">
			{harnesses.map(harness => {
				const command = harness.signIn === "none" ? loginCommand(harness) : null;
				return (
					<li key={harness.id} className={`machine-agent machine-agent-${harness.signIn}`}>
						<span className="machine-agent-name">
							<AgentGlyph harness={harness.id} size={11} inline />
							{HARNESS_NAMES[harness.id]}
						</span>
						{harness.signIn === "token" ? (
							<span className="machine-agent-state">
								{" "}
								<CheckIcon size={13} />
								{signInWords(harness)}
							</span>
						) : harness.signIn === "none" ? (
							<span className="machine-agent-state">: {signInWords(harness)}</span>
						) : (
							// Unknown is the runner's check failing, not a sign-in to redo: its reason, where it gave one, and no login prompt.
							<span className="machine-agent-state" title={harness.signInReason}>
								: {signInWords(harness)}
								{harness.signInReason ? ` (${harness.signInReason})` : ""}
							</span>
						)}
						{command ? (
							<span className="machine-agent-command">
								<code>{command}</code>
								<CopyButton text={command} label={`Copy the command that signs ${HARNESS_NAMES[harness.id]} in`} />
							</span>
						) : null}
						{harness.paysWith ? (
							<span className="machine-agent-paid">
								Paid with your plan or key ·{" "}
								<a
									className="link"
									{...linkProps({ name: "connections", section: cellId(harness.id, machine.machineId) })}
								>
									{harness.signIn === "none" ? "Connect on Connections" : "Change on Connections"}
								</a>
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * What the owner says of the machine for the planner of a feature: when to use it, and tags. One
 * quiet line in its card, edited in place; saved with `setMachineDetails`, checked first as the
 * server checks it.
 */
function MachineUse({ machine, onChanged }: { machine: MachineSummary; onChanged(list: MachineSummary[]): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [tagText, setTagText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { text: useId(), tags: useId(), note: useId() };
	const whenToUse = machine.whenToUse ?? "";
	const tags = machine.tags ?? [];
	const typedTags = tagsOf(tagText);
	const problem = editing ? machineDetailsProblem(text.trim(), typedTags) : null;
	const changed = text.trim() !== whenToUse || JSON.stringify(typedTags) !== JSON.stringify(tags);
	const edit = () => {
		setText(whenToUse);
		setTagText(tags.join(", "));
		setError(null);
		setEditing(true);
	};
	const save = (event: FormEvent) => {
		event.preventDefault();
		if (problem || busy) return;
		setBusy(true);
		setError(null);
		client
			.user(auth)
			.setMachineDetails({ machineId: machine.machineId, whenToUse: text.trim(), tags: typedTags })
			.then(
				list => {
					onChanged(list);
					setBusy(false);
					setEditing(false);
				},
				(failure: unknown) => {
					setError(explain(failure));
					setBusy(false);
				},
			);
	};
	if (!editing) {
		return (
			<div className="machine-use">
				{whenToUse === "" && tags.length === 0 ? (
					<span className="machine-use-empty">No note on when to use it.</span>
				) : (
					<>
						{whenToUse !== "" ? <span className="machine-use-text">{whenToUse}</span> : null}
						{tags.map(tag => (
							<span key={tag} className="machine-tag">
								{tag}
							</span>
						))}
					</>
				)}
				<button
					type="button"
					className="link machine-use-edit"
					onClick={edit}
					aria-label={`Edit when to use ${machineLabel(machine)}`}
				>
					<PencilIcon size={11} />
					{whenToUse === "" && tags.length === 0 ? "Add" : "Edit"}
				</button>
			</div>
		);
	}
	return (
		<form className="machine-use-form" onSubmit={save}>
			<div className="machine-use-fields">
				<div>
					<label className="label" htmlFor={ids.text}>
						When to use it
					</label>
					<input
						id={ids.text}
						className="input"
						value={text}
						maxLength={MAX_WHEN_TO_USE + 50}
						placeholder="Builds and browser tests; it has the GPU"
						onChange={event => setText(event.target.value)}
						readOnly={busy}
						aria-describedby={ids.note}
						data-autofocus
						autoFocus
					/>
				</div>
				<div>
					<label className="label" htmlFor={ids.tags}>
						Tags<span className="label-optional">comma or space between</span>
					</label>
					<input
						id={ids.tags}
						className="input input-mono"
						value={tagText}
						placeholder="gpu, big-build"
						onChange={event => setTagText(event.target.value)}
						readOnly={busy}
						aria-describedby={ids.note}
						aria-invalid={problem !== null || undefined}
					/>
				</div>
			</div>
			<p
				className={`field-note${problem || error ? " tone-bad" : ""}`}
				id={ids.note}
				role={problem || error ? "alert" : undefined}
			>
				{problem ??
					error ??
					"The planner of a feature reads this, with the machine's OS, capacity and what it can run, when it splits the work."}
			</p>
			<div className="machine-use-actions">
				<button
					type="submit"
					className="button button-primary button-small"
					disabled={busy || problem !== null || !changed}
				>
					{busy ? "Saving…" : "Save"}
				</button>
				<button
					type="button"
					className="button button-quiet button-small"
					onClick={() => setEditing(false)}
					disabled={busy}
				>
					Cancel
				</button>
			</div>
		</form>
	);
}

function MachineRow({
	machine,
	info,
	now,
	onChanged,
	onRemove,
}: {
	machine: MachineSummary;
	info: MachinesInfo;
	now: number;
	onChanged(list: MachineSummary[]): void;
	onRemove(machine: MachineSummary): void;
}) {
	const upgrade = settingsKeyUpgrade(machine);
	const [open, setOpen] = useState(false);
	const details = useId();
	const reported = machine.commandSandbox !== null;
	const paired = relativeTime(machine.since, now);

	const host = machineHostNote(machine);
	const outdated = machine.warnings.some(warning => warning.kind === "outdated");
	const limited =
		machine.providerAccounts?.filter(account => account.state === "limited" && (account.limitedUntil ?? 0) > now) ?? [];
	return (
		<li className={`usage-kept-row machine-row machine-row-${outdated ? "outdated" : machine.status}`}>
			<div className="machine-head">
				<span className="machine-glyph" aria-hidden="true">
					<MachineIcon size={17} />
				</span>
				<div className="machine-name">
					<h3 className="usage-kept-title">{machineLabel(machine)}</h3>
					{host === null ? (
						<>
							<span className="chip">{machine.os}</span>
							<span className="chip">{machine.arch}</span>
						</>
					) : (
						<span className="machine-host">host {host}</span>
					)}
					{outdated && <span className="machine-update">Update available</span>}
				</div>
				<MachineState machine={machine} now={now} />
				<button
					type="button"
					className="button button-outline button-small machine-remove"
					onClick={() => onRemove(machine)}
				>
					<TrashIcon size={13} />
					<span>
						Remove<span className="visually-hidden"> {machineLabel(machine)}</span>…
					</span>
				</button>
			</div>

			<div className="machine-part">
				<MachineUse machine={machine} onChanged={onChanged} />
			</div>
			{machine.harnesses?.length || upgrade || limited.length > 0 ? (
				<div className="machine-part">
					<MachineAgents machine={machine} />
					{upgrade && <p className="field-note">{upgrade}</p>}
					{limited.map(a => (
						<p className="field-note" key={a.key}>
							{a.provider ? `Your ${SOURCE_NAMES[a.provider]} key` : HARNESS_NAMES[a.harness]} is rate-limited until{" "}
							{new Date(a.limitedUntil!).toISOString().slice(11, 16)} UTC
						</p>
					))}
				</div>
			) : null}

			{machine.status === "waiting" || machine.warnings.length > 0 ? (
				<div className="machine-notes">
					{machine.status === "waiting" && machine.warnings.length === 0 ? (
						<p className="usage-note">
							Paired {paired === "now" ? "a moment ago" : paired}; its runner has not connected since. Check{" "}
							<code>docker logs windlass-runner</code> on the machine. A runner that lost its key before it connected
							never will: remove this machine and add it again.
						</p>
					) : null}
					{machine.warnings.map(warning => (
						<Warning key={warning.kind} warning={warning} machine={machine} info={info} now={now} />
					))}
				</div>
			) : null}

			<p className="agent-meta machine-foot">
				{orchestratorNote(machine) ? (
					<span
						className={`machine-policy-note machine-policy-note-${orchestratorOf(machine)}`}
						title={ORCHESTRATOR_CHOICES.find(choice => choice.id === orchestratorOf(machine))!.means}
					>
						{orchestratorNote(machine)}
					</span>
				) : null}
				<span>
					{machine.sandboxes.length === 0
						? "No kept sandboxes"
						: plural(machine.sandboxes.length, "kept sandbox", "kept sandboxes")}
					{machine.maxSandboxes ? (
						<span
							className="machine-meter"
							role="img"
							aria-label={`${machine.sandboxes.length} of at most ${machine.maxSandboxes} kept`}
						>
							<span style={{ width: `${Math.min(100, (machine.sandboxes.length / machine.maxSandboxes) * 100)}%` }} />
						</span>
					) : null}
				</span>
				<span className="machine-foot-end">
					<button
						type="button"
						className="link machine-toggle"
						aria-expanded={open}
						aria-controls={details}
						onClick={() => setOpen(value => !value)}
					>
						<ChevronIcon size={11} className="machine-chevron" />
						{open ? "Hide details" : "Details"}
					</button>
				</span>
			</p>
			<div id={details} className="machine-details" hidden={!open}>
				<div>
					<h4 className="eyebrow">Sandboxes</h4>
					{machine.sandboxes.length === 0 ? (
						<p className="usage-lede">
							{reported ? "No agent's sandbox is on it." : "Its runner has not reported yet."}
						</p>
					) : (
						<ul className="machine-sandboxes">
							{machine.sandboxes.map(sandbox => (
								<SandboxLine
									key={sandbox.sessionId}
									sandbox={sandbox}
									now={now}
									offlineSince={machine.status === "offline" ? machine.since : null}
								/>
							))}
						</ul>
					)}
				</div>
				<dl className="machine-facts">
					<div>
						<dt>Commands sandboxed by Windlass</dt>
						<dd>
							{machine.commandSandbox === null ? (
								<span className="tone-faint">not reported yet</span>
							) : machine.commandSandbox.ok ? (
								"yes"
							) : (
								<>no: {machine.commandSandbox.reason}</>
							)}
						</dd>
					</div>
					{machine.slots || machine.turns || machine.host ? (
						<div>
							<dt>Capacity</dt>
							<dd>{machineCapacity(machine)}</dd>
						</div>
					) : null}
					<div>
						<dt>Free disk</dt>
						<dd>
							{machine.freeDiskBytes === null ? (
								<span className="tone-faint">not reported yet</span>
							) : (
								diskSize(machine.freeDiskBytes)
							)}
						</dd>
					</div>
					<div>
						<dt>Snapshot storage</dt>
						<dd>
							{machine.storeLimits ? (
								storeLimits(machine.storeLimits)
							) : (
								<span className="tone-faint">not reported yet</span>
							)}
							<p className="field-note">
								Set on the machine.{" "}
								<a className="link" href="/docs/runner#run-options">
									Runner reference →
								</a>
							</p>
						</dd>
					</div>
					<div>
						<dt>Sandbox limit</dt>
						<dd>
							{reported ? sandboxLimit(machine) : <span className="tone-faint">not reported yet</span>}
							<p className="field-note">
								Set on the machine.{" "}
								<a className="link" href="/docs/runner#run-options">
									Runner reference →
								</a>
							</p>
						</dd>
					</div>
				</dl>
				<PlacementPolicy machine={machine} onChanged={onChanged} />
				<SecretsSwitch machine={machine} onChanged={onChanged} />
			</div>
		</li>
	);
}

type AddStep = { step: "command" } | { step: "code" } | { step: "confirm"; claim: MachineClaim };

/** Pairing a machine: the command that starts its runner, the code the runner prints, and what that machine says it is. */
function AddDialog({
	info,
	machines,
	onClose,
	onAdded,
}: {
	info: MachinesInfo;
	/** The user's machines as the page keeps them, live: a machine paired from the connect page arrives here. */
	machines: MachinesState;
	onClose(): void;
	onAdded(machine: MachineSummary): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [step, setStep] = useState<AddStep>({ step: "command" });
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Whether the code itself was refused, rather than the asking failing. */
	const [unknown, setUnknown] = useState(false);
	/** The control each step after the first starts on: the field, or the button that decides. */
	const start = useRef<HTMLElement | null>(null);
	const aim = (element: HTMLElement | null) => {
		start.current = element;
	};
	const ids = { form: useId(), code: useId(), codeNote: useId(), trust: useId() };
	const [claude, setClaude] = useState(false);
	const [codex, setCodex] = useState(false);
	const [openCode, setOpenCode] = useState(false);
	const [importKeys, setImportKeys] = useState(false);
	// Windlass's command sandbox, the second wall around each command (`docker-windlass-sandbox`): on unless the person turns it off.
	const [windlassSandbox, setWindlassSandbox] = useState(true);
	/** The person says the runner's terminal shows the same machine key (or, for a runner that prints none, that they started it). */
	const [keyMatches, setKeyMatches] = useState(false);
	const offersCodex = info.runnerHarnesses?.includes("codex") === true;
	const offersOpenCode = info.runnerHarnesses?.includes("opencode") === true;
	const offersClaude = info.runnerHarnesses?.includes("claude") ?? true;
	const agents = {
		codex: offersCodex && codex,
		claude: offersClaude && claude,
		openCode: offersOpenCode && openCode,
		windlassSandbox,
	};
	const setup = installCommand(info, agents, { importKeys });
	const install = installCommand(info, agents);
	const oneLine = oneLineInstall(info);
	const complete = code.replace(/-/g, "").length === 8;
	const paired = useNewMachine(machines, step.step === "command");

	const shown = useRef(step.step);
	useEffect(() => {
		if (shown.current === step.step) return;
		shown.current = step.step;
		start.current?.focus();
	}, [step.step]);

	const go = (next: AddStep) => {
		setError(null);
		setStep(next);
	};

	const check = async (event?: FormEvent) => {
		event?.preventDefault();
		if (!complete || busy) return;
		setBusy(true);
		setError(null);
		try {
			const claim = await client.user(auth).claimMachine({ code });
			setKeyMatches(false);
			setStep({ step: "confirm", claim });
		} catch (failure) {
			setError(explain(failure));
			setUnknown(hasReason(failure, "pairing_not_found"));
		} finally {
			setBusy(false);
		}
	};

	const connect = async () => {
		if (!keyMatches) return;
		setBusy(true);
		setError(null);
		try {
			onAdded(await client.user(auth).confirmMachine({ code, keyConfirmed: true }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	const failed = error ? (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	) : null;

	if (step.step === "confirm") {
		const { claim } = step;
		return (
			<Dialog
				title="Add a machine"
				lede={<>Connect “{machineLabel(claim)}” to your account?</>}
				onClose={onClose}
				dismissable={!busy}
				footer={
					<>
						<button type="button" className="button button-quiet" onClick={() => go({ step: "code" })} disabled={busy}>
							Back
						</button>
						<button
							type="button"
							className="button button-primary"
							onClick={connect}
							disabled={busy || !keyMatches}
							aria-describedby={ids.trust}
						>
							{busy ? "Connecting…" : "Connect"}
						</button>
					</>
				}
			>
				<div className="machine-dialog">
					<div className="machine-key">
						<p className="eyebrow">Machine key</p>
						<p className="machine-key-value">{claim.keyFingerprint ?? <span className="tone-faint">not known</span>}</p>
						<Check checked={keyMatches} disabled={busy} onChange={on => setKeyMatches(on)} inputRef={aim}>
							{claim.keyPrinted ? (
								<>
									<span className="check-name">The runner's terminal shows the same machine key</span>
									<span className="check-means">
										The runner prints it under the code. If it shows another key, or someone gave you this code, press
										Back: connecting would send your agents' work to their machine.
									</span>
								</>
							) : (
								<>
									<span className="check-name">I started this runner myself, in the last few minutes</span>
									<span className="check-means">
										Runner {claim.runnerVersion} does not print its machine key, so it cannot be compared. A newer
										runner prints it under the code. If someone gave you this code, press Back: connecting would send
										your agents' work to their machine.
									</span>
								</>
							)}
						</Check>
					</div>
					<div>
						<p className="eyebrow">What the machine says about itself</p>
						<dl className="machine-claim">
							<dt>Name</dt>
							<dd>
								{claim.name || <span className="tone-faint">none reported</span>}
								{machineHostNote(claim) === null ? null : (
									<span className="field-note machine-claim-note">Shown as “{machineLabel(claim)}”.</span>
								)}
							</dd>
							<dt>OS</dt>
							<dd>{claim.os}</dd>
							<dt>Architecture</dt>
							<dd>{claim.arch}</dd>
							<dt>Runner</dt>
							<dd>{claim.runnerVersion}</dd>
						</dl>
						<p className="field-note">
							Nobody has checked these: connect it only if it is the machine you started the runner on.
						</p>
					</div>
					<p id={ids.trust}>
						It will run the agents you start on it and receive what they need: your repository's files, its saved
						secrets and a one-hour ChatGPT token for each turn. The platform does not control this machine, and what a
						session there shows of checks and changes is what the machine reports.
					</p>
					{failed}
				</div>
			</Dialog>
		);
	}

	if (step.step === "code") {
		return (
			<Dialog
				title="Add a machine"
				lede="The runner prints a code. Enter it here."
				onClose={onClose}
				dismissable={!busy}
				footer={
					<>
						<button
							type="button"
							className="button button-quiet"
							onClick={() => go({ step: "command" })}
							disabled={busy}
						>
							Back
						</button>
						<button type="submit" form={ids.form} className="button button-primary" disabled={!complete || busy}>
							{busy ? "Checking…" : "Check code"}
						</button>
					</>
				}
			>
				<form id={ids.form} className="machine-dialog" onSubmit={check}>
					<div>
						<label className="label" htmlFor={ids.code}>
							Code
						</label>
						<input
							id={ids.code}
							className={`input input-mono machine-code${unknown ? " input-invalid" : ""}`}
							value={code}
							placeholder="XXXX-XXXX"
							inputMode="text"
							autoComplete="one-time-code"
							autoCapitalize="characters"
							spellCheck={false}
							maxLength={9}
							aria-describedby={ids.codeNote}
							aria-invalid={unknown || undefined}
							readOnly={busy}
							onChange={event => {
								setCode(formatCode(event.target.value));
								setError(null);
								setUnknown(false);
							}}
							ref={aim}
						/>
						<p className="field-note" id={ids.codeNote}>
							Setup prints the code in your terminal. For a background runner, read{" "}
							<code>docker logs windlass-runner</code>. The code lasts ten minutes.
						</p>
					</div>
					{failed}
				</form>
			</Dialog>
		);
	}

	return (
		<Dialog
			title="Add a machine"
			lede="Use a terminal on your Mac, Linux computer or Windows machine (WSL) with Docker."
			onClose={onClose}
			footer={
				paired ? (
					<button type="button" className="button button-primary" onClick={onClose}>
						Done
					</button>
				) : (
					<button type="button" className="button button-quiet" onClick={onClose} ref={aim}>
						Cancel
					</button>
				)
			}
		>
			<div className="machine-dialog">
				{oneLine ? (
					<>
						<div>
							<Command text={MACHINE_CONNECT_COMMAND} label="The connect command" />
							<p className="field-note">
								Run it on the machine; it needs Docker and Node. It opens a page here to approve the machine, then runs
								in the background. Its agents use your plans and keys from{" "}
								<a className="link" {...linkProps({ name: "connections" })}>
									Connections
								</a>
								.
							</p>
							{paired ? (
								<p className="machine-wait machine-paired" role="status">
									<CheckIcon size={15} />
									Paired: {machineLabel(paired)}.
								</p>
							) : (
								<Waiting className="machine-wait">Waiting for your machine…</Waiting>
							)}
						</div>
						<details className="panel-more machine-no-node">
							<summary>
								<ChevronIcon size={12} className="panel-more-chevron" />
								No Node?
							</summary>
							<div className="machine-other-ways-body">
								<Command text={oneLine} label="The install command" />
								<p className="field-note">
									Setup asks for a name, signs in your agents and sets network access, isolation and limits, then starts
									the machine software in the background.{" "}
									<a href={`${info.platformUrl}/install.sh`} target="_blank" rel="noreferrer">
										Read the script
									</a>
									. It prints a code: enter it here, then confirm the machine key.
								</p>
								<p>
									<button type="button" className="button button-outline" onClick={() => go({ step: "code" })}>
										Enter the code
									</button>
								</p>
							</div>
						</details>
					</>
				) : (
					<p className="callout callout-info">
						<InfoIcon />
						<span>
							The runner is not published yet, so there is nothing to install from here. Once it is, its command is
							shown here.
						</span>
					</p>
				)}
				{oneLine && setup && install ? (
					<details className="panel-more machine-other-ways">
						<summary>
							<ChevronIcon size={12} className="panel-more-chevron" />
							Other ways
						</summary>
						<div className="machine-other-ways-body">
							<div>
								<p className="machine-step">Set it up with Docker</p>
								<div className="machine-setup-agents">
									{offersClaude && <Check checked={claude} onChange={setClaude} label="Enable Claude Code" />}
									{offersCodex && <Check checked={codex} onChange={setCodex} label="Enable Codex" />}
									{offersOpenCode && <Check checked={openCode} onChange={setOpenCode} label="Enable OpenCode" />}
									{agents.openCode && importKeys && (
										<p>
											If you use a custom XDG data directory, replace the source path in the setup command with your
											OpenCode directory.
										</p>
									)}
									{agents.openCode && (
										<Check
											checked={importKeys}
											onChange={setImportKeys}
											label="Import existing OpenCode API keys during setup"
										/>
									)}
									<Check
										checked={windlassSandbox}
										onChange={setWindlassSandbox}
										label="Allow locked-down commands (recommended for Windlass and Codex)"
									/>
									<p>
										{windlassSandbox
											? "Commands can run without internet access."
											: "Only unrestricted commands are available on this machine."}
									</p>
								</div>
								<Command text={setup} label="The setup command" />
								<p className="field-note">
									Follow the prompts to pair the machine and sign in your agents.{" "}
									<a className="link" href="/docs/runner">
										Runner reference →
									</a>
								</p>
							</div>
							<div>
								<p className="machine-step">Or start the runner in the background</p>
								<Command text={install} label="The background command" />
								<p className="field-note">
									Where rootless Docker works, use it: the runner then gets less of your machine. Mount{" "}
									<code>$XDG_RUNTIME_DIR/docker.sock</code> in place of <code>/var/run/docker.sock</code>.
								</p>
							</div>
						</div>
					</details>
				) : null}
			</div>
		</Dialog>
	);
}

/**
 * A machine that joined the list after the dialog's first step was shown (paired from the connect page the
 * command opens); null until one does. The page's list follows the user's actor; it is read again when the person
 * comes back to this tab from that page.
 */
function useNewMachine(machines: MachinesState, watching: boolean): MachineSummary | null {
	const known = useRef<Set<string> | null>(null);
	const [found, setFound] = useState<MachineSummary | null>(null);
	const { list, reload } = machines;
	useEffect(() => {
		if (!watching) return;
		window.addEventListener("focus", reload);
		return () => window.removeEventListener("focus", reload);
	}, [watching, reload]);
	useEffect(() => {
		if (list === null || found) return;
		if (known.current === null) {
			known.current = new Set(list.map(machine => machine.machineId));
			return;
		}
		if (!watching) return;
		const fresh = list.find(machine => !known.current?.has(machine.machineId));
		if (fresh) setFound(fresh);
	}, [list, watching, found]);
	return found;
}

function RemoveDialog({
	machine,
	onClose,
	onRemoved,
}: {
	machine: MachineSummary;
	onClose(): void;
	onRemoved(list: MachineSummary[]): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [sandboxes, setSandboxes] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const agents = machine.agents;

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			onRemoved(await client.user(auth).removeMachine({ machineId: machine.machineId, removeSandboxes: sandboxes }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title={`Remove “${machineLabel(machine)}”?`}
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={remove} disabled={busy}>
						{busy ? "Removing…" : "Remove machine"}
					</button>
				</>
			}
		>
			<p>
				Its key stops working at once.{" "}
				{agents === 0
					? "No agent was launched on it."
					: `${agents === 1 ? "The agent on it keeps its conversation" : `The ${agents} agents on it keep their conversations`} here but cannot run again; ${agents === 1 ? "its" : "their"} files stay on the machine unless you also remove its sandboxes.`}
			</p>
			{agents > 0 || machine.sandboxes.length > 0 ? (
				<Check className="machine-remove-check" checked={sandboxes} disabled={busy} onChange={on => setSandboxes(on)}>
					<span className="check-name">Also remove the agents' sandboxes on it</span>
					<span className="check-means">
						{machine.status === "online"
							? "Its runner removes them now."
							: "Its runner removes them when it is next online."}
					</span>
				</Check>
			) : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/**
 * How many machines the account may pair: its plan's where the deployment has billing, MAX_MACHINES otherwise; null
 * until that is known, so no limit is said that then changes.
 */
function useMachineLimit(): number | null {
	const { platform, client } = useApp();
	const [limit, setLimit] = useState<number | null>(null);
	const auth = useAuth();
	const billed = Boolean(platform.info?.billing);
	useEffect(() => {
		if (!billed) return;
		let current = true;
		client
			.user(auth)
			.billing()
			.then(
				view => {
					if (current)
						setLimit(
							view.enabled ? (view.plans.find(plan => plan.id === view.plan)?.machines ?? MAX_MACHINES) : MAX_MACHINES,
						);
				},
				() => current && setLimit(MAX_MACHINES),
			);
		return () => {
			current = false;
		};
	}, [billed, client, auth]);
	if (platform.info === null) return null;
	return billed ? limit : MAX_MACHINES;
}

export function Machines({ adding }: { adding: boolean }) {
	const { platform } = useApp();
	const machines = useMachines();
	const account = useAccount();
	const now = useNow(30_000);
	const [removing, setRemoving] = useState<MachineSummary | null>(null);
	const info = platform.info?.machines ?? null;
	const { list } = machines;
	const maxMachines = useMachineLimit();
	const full = list !== null && maxMachines !== null && list.length >= maxMachines;
	const add = () => navigate({ name: "machines", add: true });
	const closingAdd = useRef(false);
	const closeAdd = useCallback(() => {
		// Pairing the last allowed machine can also close the dialog through the limit check below.
		if (closingAdd.current) return;
		closingAdd.current = true;
		if (history.state?.fromPage) history.back();
		else navigate({ name: "machines" }, { replace: true });
	}, []);
	// The address a runner prints opens the dialog once what it needs is known; an account that cannot add another goes to its list.
	const canAdd = (list !== null || machines.error !== null) && maxMachines !== null && !full;
	useEffect(() => {
		if (!adding) closingAdd.current = false;
		else if (full) closeAdd();
	}, [adding, full, closeAdd]);

	return (
		<main className="home usage repo machines">
			<header className="home-head">
				<div className="repo-head">
					<p className="eyebrow">account</p>
					<h1 className="display display-small">Machines</h1>
					<p className="home-account">
						Run agents on your own computer with Docker (Mac, Linux or Windows with WSL). No inbound connection is
						needed.
					</p>
				</div>
				<div className="machines-add">
					<button type="button" className="button button-outline" onClick={add} disabled={info === null || full}>
						<PlusIcon />
						Add a machine
					</button>
					{full && maxMachines !== null ? (
						<p className="field-note">
							Your account can connect up to {maxMachines} machines.
							{maxMachines < 10 && platform.info?.billing ? " Pro connects up to 10." : ""}
						</p>
					) : null}
				</div>
			</header>

			{list === null || info === null ? (
				machines.error || (platform.error && info === null) ? (
					<section className="usage-section">
						<LoadError
							level={2}
							subject="Your machines"
							error={machines.error ?? platform.error}
							reload={() => {
								if (info === null) platform.reload();
								machines.reload();
							}}
						/>
					</section>
				) : (
					// The page's own shape while it loads: where work runs, then the list.
					<>
						<section className="usage-section" aria-labelledby="machines-default">
							<h2 className="usage-title" id="machines-default">
								Where work runs
							</h2>
							<p className="usage-lede">
								Your default for work items and new agents. A repository or an item can choose another place.
							</p>
							<div className="usage-card run-card">
								<DefaultPlaceSkeleton />
							</div>
						</section>
						<section className="usage-section">
							<SkeletonRows label="Loading your machines" rows={2} chips={2} />
						</section>
					</>
				)
			) : (
				<>
					{machines.error ? <LoadError inline stale error={machines.error} reload={machines.reload} /> : null}

					<section className="usage-section" aria-labelledby="machines-default">
						<h2 className="usage-title" id="machines-default">
							Where work runs
						</h2>
						<p className="usage-lede">
							Your default for work items and new agents. A repository or an item can choose another place.
						</p>
						<div className="usage-card run-card">
							<DefaultPlace account={account} />
						</div>
					</section>

					<section className="usage-section" aria-labelledby="machines-list">
						<h2 className="usage-title" id="machines-list">
							My machines
							{list.length > 0 ? (
								<span className="usage-count">
									{maxMachines === null ? String(list.length) : `${list.length} of ${maxMachines}`}
								</span>
							) : null}
						</h2>
						{list.length === 0 ? (
							<div className="state state-empty">
								<Mark size={44} />
								<p>No machine is connected yet. Add one, and the agents you launch can run there.</p>
								<button type="button" className="button button-outline" onClick={add}>
									<PlusIcon />
									Add a machine
								</button>
							</div>
						) : (
							<>
								<ul className="usage-kept">
									{list.map(machine => (
										<MachineRow
											key={machine.machineId}
											machine={machine}
											info={info}
											now={now}
											onChanged={machines.replace}
											onRemove={setRemoving}
										/>
									))}
								</ul>
								<p className="usage-note">Windlass sends a machine only what its agents need.</p>
							</>
						)}
					</section>
				</>
			)}

			{adding && info !== null && canAdd ? (
				<AddDialog
					info={info}
					machines={machines}
					onClose={closeAdd}
					onAdded={machine =>
						machines.replace([...(list ?? []).filter(one => one.machineId !== machine.machineId), machine])
					}
				/>
			) : null}
			{removing ? (
				<RemoveDialog machine={removing} onClose={() => setRemoving(null)} onRemoved={machines.replace} />
			) : null}
		</main>
	);
}
