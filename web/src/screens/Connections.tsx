/**
 * Connections: each agent and every place it runs (Hosted, each paired machine), what pays for it there, and the one
 * action that connects it (lib/connections.ts). Under the grid, who pays for each plan agent (Pay with, saved in the
 * user's actor: server/src/pay-with.ts), the plans' connect commands and the API keys, which moved here from
 * Settings → Models. A link names one cell as the fragment (`/connections#claude-hosted`): the page scrolls to it
 * and marks it.
 */
import {
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	PLAN_NAMES,
	type PayWith,
	type PayWithChoice,
	type PlanProvider,
	type WhenLimited,
} from "@contract";
import { useCallback, useEffect, useState } from "react";
import { THIS_MACHINE_CLAUDE_COMMAND } from "../../../server/src/contract/machine-setup.js";
import { payWithFor } from "../../../server/src/pay-with.js";
import { keyProviders, machineHarness } from "../../../server/src/sandbox/harnesses.js";
import { ChatgptPlan } from "../components/ChatgptPlan";
import { ClaudePlan } from "../components/ClaudePlan";
import { Command } from "../components/Command";
import { Dialog } from "../components/Dialog";
import { CloudIcon, MachineIcon, WarnIcon } from "../components/Icons";
import { KeyDialog, ModelProviders } from "../components/ModelProviders";
import { PlanWait } from "../components/PlanConnect";
import { SettingsGroup, SettingsLayout } from "../components/SettingsGroups";
import { AgentGlyph } from "../components/ui/Pill";
import { StatusTag, type StatusTone, Waiting } from "../components/ui/StatusTag";
import { HARNESS_DISPLAY_ORDER, HARNESS_NAMES } from "../lib/acp";
import {
	type CellAction,
	type ConnectionCell,
	type ConnectionInputs,
	hostedCell,
	machineCell,
	withMachineLoginNote,
} from "../lib/connections";
import { machineLabel, settingsKeyUpgrade } from "../lib/machines";
import { SOURCE_NAMES } from "../lib/models";
import { linkProps, useHash } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useConnectionInputs, usePayWith } from "../state/connections";
import { PROVIDERS_CHANGED } from "../state/hooks";
import { useMachines } from "../state/machines";

const PAY_WITH_WORDS: Record<PayWith, string> = {
	"plan-then-key": "Plan first, then key",
	plan: "Plan only",
	key: "Key only",
};
const WHEN_LIMITED_WORDS: Record<WhenLimited, string> = {
	wait: "Wait for the reset",
	key: "Use my key",
	ask: "Ask me",
};
/** The select's value for "no choice saved": the defaults by origin. */
const DEFAULT_LIMITED = "default";

/** What a cell's action button says. */
function actionWords(action: CellAction, state: ConnectionCell["state"]): string {
	if (action.kind === "plan") return action.reconnect ? "Reconnect" : `Connect ${PLAN_NAMES[action.provider]}`;
	if (action.kind === "key") return `${state === "bad" ? "Replace" : "Add"} ${SOURCE_NAMES[action.provider]} key`;
	return state === "absent" ? "Set up on Machines" : "Open Machines";
}

const TONES: Record<ConnectionCell["state"], StatusTone> = {
	plan: "good",
	key: "good",
	machine: "good",
	bad: "bad",
	none: "off",
	unknown: "warn",
	absent: "quiet",
};

/** What the page opens over itself from a cell: a plan's connect command, or a key's entry. */
type Opened = { kind: "plan"; provider: PlanProvider } | { kind: "key"; provider: ModelProvider; replacing: boolean };

/**
 * A machine's agent that can keep a login of its own there (Claude Code): the plan from Windlass, or that login.
 * Choosing the login shows the command to run on the machine; its runner's report turns the cell over to "kept" by
 * itself. A kept login offers the way back, which the runner carries out (`removeMachineClaudeLogin`).
 */
function OwnLogin({
	harness,
	own,
	onMachines,
}: {
	harness: HarnessId;
	own: NonNullable<ConnectionCell["ownLogin"]>;
	onMachines(list: MachineSummary[]): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [choosing, setChoosing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setChoosing(false);
		setError(null);
	}, [own.state]);
	const plan = machineHarness(harness)?.planProviders[0];
	if (own.state === "kept") {
		const switchBack = () => {
			setBusy(true);
			setError(null);
			client
				.user(auth)
				.removeMachineClaudeLogin({ machineId: own.machineId })
				.then(onMachines, failure => setError(explain(failure)))
				.finally(() => setBusy(false));
		};
		return (
			<div className="conn-own">
				<button
					type="button"
					className="button button-outline button-small conn-action"
					disabled={busy}
					onClick={switchBack}
				>
					{busy ? "Switching back…" : "Switch back to your plan"}
				</button>
				{error ? (
					<p className="field-note tone-bad" role="alert">
						{error}
					</p>
				) : null}
			</div>
		);
	}
	const name = `own-login-${harness}-${own.machineId}`;
	return (
		<fieldset className="conn-own">
			<legend className="visually-hidden">How {HARNESS_NAMES[harness]} pays on this machine</legend>
			<label className="conn-own-option">
				<input type="radio" name={name} checked={!choosing} onChange={() => setChoosing(false)} />
				Your {plan ? PLAN_NAMES[plan] : "plan"}, from Windlass
			</label>
			<label className="conn-own-option">
				<input type="radio" name={name} checked={choosing} onChange={() => setChoosing(true)} />
				This machine's own login — it never leaves this machine
			</label>
			{choosing ? (
				<div className="conn-own-command">
					<Command text={THIS_MACHINE_CLAUDE_COMMAND} label="The command for this machine" />
					<p className="field-note">
						Run it in a terminal on this machine. It runs <code>claude setup-token</code> there and hands the token to
						the machine's runner, not to Windlass.
					</p>
					<Waiting>Waiting for the machine to report the login…</Waiting>
				</div>
			) : null}
		</fieldset>
	);
}

function Cell({
	cell,
	harness,
	target,
	onAct,
	onMachines,
}: {
	cell: ConnectionCell;
	harness: HarnessId;
	target: boolean;
	onAct(action: CellAction, state: ConnectionCell["state"]): void;
	onMachines(list: MachineSummary[]): void;
}) {
	const { action } = cell;
	return (
		<div
			id={cell.id}
			className={`conn-cell${target ? " conn-cell-target" : ""}`}
			data-state={cell.state}
			aria-current={target || undefined}
		>
			<StatusTag tone={TONES[cell.state]} className="conn-state">
				{cell.label}
			</StatusTag>
			{cell.badge ? (
				<StatusTag tone={cell.badge.tone} pill className="conn-badge">
					{cell.badge.text}
				</StatusTag>
			) : null}
			{cell.detail ? <span className="conn-detail">{cell.detail}</span> : null}
			{action?.kind === "machines" ? (
				<a className="link conn-link" {...linkProps({ name: "machines" })}>
					{actionWords(action, cell.state)}
				</a>
			) : action ? (
				<button
					type="button"
					className="button button-outline button-small conn-action"
					onClick={() => onAct(action, cell.state)}
				>
					{actionWords(action, cell.state)}
				</button>
			) : null}
			{cell.ownLogin ? <OwnLogin harness={harness} own={cell.ownLogin} onMachines={onMachines} /> : null}
		</div>
	);
}

function Grid({
	inputs,
	machines,
	onAct,
	onMachines,
}: {
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onAct(action: CellAction, state: ConnectionCell["state"]): void;
	onMachines(list: MachineSummary[]): void;
}) {
	const hash = decodeURIComponent(useHash().slice(1));
	return (
		<div className="conn-scroll">
			<table className="conn-grid">
				<thead>
					<tr>
						<th scope="col">Agent</th>
						<th scope="col">
							<span className="conn-place">
								<CloudIcon size={13} />
								Hosted
							</span>
						</th>
						{machines.map(machine => (
							<th scope="col" key={machine.machineId}>
								<span className="conn-place">
									<MachineIcon size={13} />
									{machineLabel(machine)}
								</span>
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{HARNESS_DISPLAY_ORDER.map(harness => {
						const hosted = withMachineLoginNote(hostedCell(harness, inputs), harness, machines);
						return (
							<tr key={harness} data-agent={harness}>
								<th scope="row">
									<span className="conn-agent">
										<AgentGlyph harness={harness} size={14} />
										{HARNESS_NAMES[harness]}
									</span>
								</th>
								<td data-place="Hosted">
									<Cell
										cell={hosted}
										harness={harness}
										target={hash === hosted.id}
										onAct={onAct}
										onMachines={onMachines}
									/>
								</td>
								{machines.map(machine => {
									const cell = machineCell(harness, machine, hosted);
									return (
										<td key={machine.machineId} data-place={machineLabel(machine)}>
											<Cell
												cell={cell}
												harness={harness}
												target={hash === cell.id}
												onAct={onAct}
												onMachines={onMachines}
											/>
										</td>
									);
								})}
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

/** What the choice means for each kind of turn, in a short sentence (`payWithFor`, the rule the resolver will apply). */
function payWithMeaning(choices: readonly PayWithChoice[], harness: HarnessId, keyName: string, hasKey: boolean) {
	const item = payWithFor(choices, harness, "item", hasKey);
	const session = payWithFor(choices, harness, "interactive", hasKey);
	if (item.payWith === "key") return `Only your ${keyName} key pays. The plan is not used.`;
	if (!hasKey) return `No ${keyName} key saved, so a limited plan waits for its reset.`;
	if (item.payWith === "plan") return "Only the plan pays. At its limit, work waits for the reset.";
	const words: Record<WhenLimited, string> = {
		wait: "wait for the reset",
		key: `switch to your ${keyName} key`,
		ask: "ask you first",
	};
	if (item.whenLimited === session.whenLimited)
		return `At the plan's limit, items and sessions ${words[item.whenLimited]}.`;
	return `At the plan's limit, items ${words[item.whenLimited]} and sessions ${words[session.whenLimited]}.`;
}

function PayWithCard({
	choice,
	choices,
	inputs,
	saving,
	onSave,
}: {
	choice: PayWithChoice;
	choices: readonly PayWithChoice[];
	inputs: ConnectionInputs;
	saving: boolean;
	onSave(patch: Pick<PayWithChoice, "harness" | "payWith" | "whenLimited">): void;
}) {
	const { harness } = choice;
	const keyProvider = keyProviders(harness)[0] ?? "openai";
	const keyName = SOURCE_NAMES[keyProvider];
	const key = inputs.keys.find(one => one.ok && keyProviders(harness).includes(one.provider));
	const planProviders: readonly string[] = machineHarness(harness)?.planProviders ?? [];
	const plan = inputs.plans.plans.find(one => one.ok && planProviders.includes(one.provider));
	const limitedApplies = choice.payWith === "plan-then-key" && key !== undefined;
	const ids = { pay: `pay-${harness}-with`, limited: `pay-${harness}-limited` };
	return (
		<div className="conn-pay" id={`pay-${harness}`}>
			<div className="conn-pay-who">
				<h3 className="conn-agent">
					<AgentGlyph harness={harness} size={14} />
					{HARNESS_NAMES[harness]}
				</h3>
				<p className="conn-pay-what">
					<span>{plan ? (plan.account ?? PLAN_NAMES[plan.provider]) : "No plan"}</span>
					<span>{key ? `${keyName} key …${key.last4}` : `No ${keyName} key`}</span>
				</p>
			</div>
			<div className="conn-pay-field conn-pay-with">
				<label className="label" htmlFor={ids.pay}>
					Pay with
				</label>
				<select
					id={ids.pay}
					className="select"
					value={choice.payWith}
					disabled={saving}
					onChange={event => onSave({ ...choice, payWith: event.target.value as PayWith })}
				>
					{(Object.keys(PAY_WITH_WORDS) as PayWith[]).map(id => (
						<option key={id} value={id}>
							{PAY_WITH_WORDS[id]}
						</option>
					))}
				</select>
			</div>
			<div className="conn-pay-field conn-pay-limited">
				<label className="label" htmlFor={ids.limited}>
					At the plan's limit
				</label>
				<select
					id={ids.limited}
					className="select"
					value={choice.whenLimited ?? DEFAULT_LIMITED}
					disabled={saving || !limitedApplies}
					onChange={event =>
						onSave({
							...choice,
							whenLimited: event.target.value === DEFAULT_LIMITED ? null : (event.target.value as WhenLimited),
						})
					}
				>
					<option value={DEFAULT_LIMITED}>Items wait, sessions ask</option>
					{(Object.keys(WHEN_LIMITED_WORDS) as WhenLimited[]).map(id => (
						<option key={id} value={id}>
							{WHEN_LIMITED_WORDS[id]}
						</option>
					))}
				</select>
			</div>
			<p className="conn-pay-meaning" role="status">
				{payWithMeaning(choices, harness, keyName, key !== undefined)}
			</p>
		</div>
	);
}

export function Connections() {
	const { platform } = useApp();
	const auth = useAuth();
	const { inputs, error } = useConnectionInputs();
	const machinesOffered = Boolean(platform.info?.machines);
	const machines = useMachines(machinesOffered);
	const list = machinesOffered ? (machines.list ?? []) : [];
	const payWith = usePayWith();
	const [opened, setOpened] = useState<Opened | null>(null);
	const close = useCallback(() => setOpened(null), []);
	const act = (action: CellAction, state: ConnectionCell["state"]) => {
		if (action.kind === "plan") setOpened({ kind: "plan", provider: action.provider });
		else if (action.kind === "key") setOpened({ kind: "key", provider: action.provider, replacing: state === "bad" });
	};
	const upgrades = list.flatMap(machine => {
		const note = settingsKeyUpgrade(machine);
		return note ? [{ machine, note }] : [];
	});

	return (
		<main className="home usage repo settings connections">
			<header className="home-head">
				<div className="repo-head">
					<h1 className="display display-small">Connections</h1>
					<p className="home-account">
						What each agent runs on, wherever it runs. Connect it once and every item and session you start uses it.
					</p>
				</div>
			</header>

			<SettingsLayout label="Connections sections">
				<SettingsGroup
					id="connections-agents"
					title="Agents"
					lede="Your plans and keys pay for each agent, hosted and on your machines, as Who pays below says. An agent signed in on a machine uses that sign-in there."
				>
					{inputs === null ? (
						error ? (
							<div className="state state-error" role="alert">
								<WarnIcon size={22} />
								<h3>Your connections could not be read</h3>
								<p>{error}</p>
							</div>
						) : (
							<p className="usage-empty" aria-busy="true">
								Reading your connections…
							</p>
						)
					) : (
						<Grid
							inputs={{ ...inputs, payWith: payWith.choices ?? [] }}
							machines={list}
							onAct={act}
							onMachines={machines.replace}
						/>
					)}
				</SettingsGroup>

				<SettingsGroup
					id="connections-pay"
					title="Who pays"
					lede="For agents with a plan: what pays, and what happens when the plan hits its limit."
				>
					{payWith.choices === null || inputs === null ? (
						payWith.error ? (
							<p className="field-note tone-bad" role="alert">
								{payWith.error}
							</p>
						) : (
							<p className="usage-empty" aria-busy="true">
								Reading who pays…
							</p>
						)
					) : (
						<div className="conn-pays">
							{payWith.choices.map(choice => (
								<PayWithCard
									key={choice.harness}
									choice={choice}
									choices={payWith.choices ?? []}
									inputs={inputs}
									saving={payWith.saving === choice.harness}
									onSave={patch => void payWith.save(patch)}
								/>
							))}
							{payWith.error ? (
								<p className="field-note tone-bad" role="alert">
									{payWith.error}
								</p>
							) : null}
						</div>
					)}
				</SettingsGroup>

				{!auth.profile.demo ? (
					<SettingsGroup
						id="connections-plans"
						title="Plans"
						lede="Connect with one command on your computer. The token stays on Windlass; agents never see it."
					>
						<ul className="settings-list" aria-label="Your plans">
							<ChatgptPlan />
							<ClaudePlan />
						</ul>
					</SettingsGroup>
				) : null}

				<SettingsGroup
					id="connections-keys"
					title="API keys"
					lede={
						<>
							Each key serves every agent that can use it, hosted and on your machines.{" "}
							<a className="link" href="/docs/settings#model-providers">
								How keys are used →
							</a>
						</>
					}
				>
					<ModelProviders />
					{upgrades.length > 0 ? (
						<div className="settings-row settings-row-notes">
							{upgrades.map(({ machine, note }) => (
								<p className="field-note" key={machine.machineId}>
									{machineLabel(machine)}: {note}
								</p>
							))}
						</div>
					) : null}
				</SettingsGroup>
			</SettingsLayout>

			{opened?.kind === "plan" ? (
				<Dialog title={`Connect your ${PLAN_NAMES[opened.provider]}`} onClose={close}>
					<PlanWait provider={opened.provider} onConnected={close} />
				</Dialog>
			) : null}
			{opened?.kind === "key" ? (
				<KeyDialog
					provider={opened.provider}
					replacing={opened.replacing}
					onClose={close}
					onSaved={() => window.dispatchEvent(new Event(PROVIDERS_CHANGED))}
				/>
			) : null}
		</main>
	);
}
