import type { ModelPlanStatus, PlanProvider } from "@contract";
import { type ReactNode, useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { planBadge } from "../lib/connections";
import { PROVIDERS_CHANGED, useNow } from "../state/hooks";
import { AnthropicLogo, OpenAILogo } from "./AgentLogos";
import { Command } from "./Command";
import { StatusTag, Waiting } from "./ui/StatusTag";

/** The command a terminal runs to connect each plan (the `cli/` package); the connect page names them too. */
export const CONNECT_COMMANDS: Record<PlanProvider, string> = {
	anthropic: "npx @windlassai/cli connect claude",
	openai: "npx @windlassai/cli connect codex",
};
const POLL_MS = 2_000;

/**
 * One plan as `modelPlans` has it, and whether the account may connect plans. `wait` starts watching for the plan to
 * arrive from the command: a new or replaced plan (its `addedAt` changed) ends the wait and lets the pickers know.
 * `refresh` reads the plans again when it changes.
 */
export function usePlanConnect(provider: PlanProvider, refresh?: unknown) {
	const { client } = useApp();
	const auth = useAuth();
	const [allowed, setAllowed] = useState(false);
	const [plan, setPlan] = useState<ModelPlanStatus | null>(null);
	/** Whether the plans were read once: before that `plan` is null whether one is connected or not. */
	const [loaded, setLoaded] = useState(false);
	/** Set by `wait`: the plan's `addedAt` then. */
	const [waiting, setWaiting] = useState<{ since: number | null } | null>(null);

	useEffect(() => {
		let live = true;
		const read = () =>
			client
				.user(auth)
				.modelPlans()
				.then(
					found => {
						if (!live) return;
						setAllowed(found.allowed);
						setPlan(found.plans.find(p => p.provider === provider) ?? null);
						setLoaded(true);
					},
					() => undefined,
				);
		void read();
		if (!waiting) return () => void (live = false);
		const timer = setInterval(read, POLL_MS);
		return () => {
			live = false;
			clearInterval(timer);
		};
	}, [client, auth, provider, waiting, refresh]);

	useEffect(() => {
		if (waiting && plan && plan.addedAt !== waiting.since) {
			setWaiting(null);
			window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		}
	}, [waiting, plan]);

	return {
		allowed,
		loaded,
		plan,
		setPlan,
		waiting: waiting !== null,
		wait: () => setWaiting({ since: plan?.addedAt ?? null }),
		cancel: () => setWaiting(null),
	};
}

/** What the command does, said under it. */
export const CONNECT_NOTES: Record<PlanProvider, ReactNode> = {
	anthropic: (
		<>
			Run it in a terminal on your computer. It opens a page here to approve, then runs <code>claude setup-token</code>.
		</>
	),
	openai:
		"Run it in a terminal on your computer. It opens a page here to approve, then signs in to ChatGPT in your browser.",
};

/**
 * A plan's connect on its own, outside its row (a Connections cell's dialog, the first-run setup): the command,
 * waiting for the plan from the moment it is shown. `onConnected` is told once a new or replaced plan arrives.
 */
export function PlanWait({ provider, onConnected }: { provider: PlanProvider; onConnected?(): void }) {
	const { loaded, waiting, wait } = usePlanConnect(provider);
	const [started, setStarted] = useState(false);
	useEffect(() => {
		if (!loaded || started) return;
		setStarted(true);
		wait();
	}, [loaded, started, wait]);
	useEffect(() => {
		if (started && !waiting) onConnected?.();
	}, [started, waiting, onConnected]);
	if (started && !waiting) return null;
	return <PlanCommand provider={provider}>{CONNECT_NOTES[provider]}</PlanCommand>;
}

/** The command to run for a plan, with a copy button, while its row waits for the plan. `children` says what it does. */
export function PlanCommand({ provider, children }: { provider: PlanProvider; children: ReactNode }) {
	return (
		<div className="plan-connect">
			<Command text={CONNECT_COMMANDS[provider]} label="The connect command" />
			<p className="field-note">{children}</p>
			<Waiting>Waiting for your plan…</Waiting>
		</div>
	);
}

/** A plan's state in a tag: its health where the relays saw a problem, else connected or not. */
export function PlanState({ connected, plan }: { connected: boolean; plan: ModelPlanStatus | null }) {
	const now = useNow(60_000);
	const badge = connected ? planBadge(plan ?? undefined, now) : null;
	if (badge)
		return (
			<StatusTag tone={badge.tone} pill className="provider-state">
				{badge.text}
			</StatusTag>
		);
	return (
		<StatusTag tone={connected ? "good" : "off"} className="provider-state">
			{connected ? "Connected" : "Not connected"}
		</StatusTag>
	);
}

/**
 * A plan's row on Connections (ClaudePlan, ChatgptPlan): its name and who it is connected as, its state, and its
 * actions; while it waits for the plan, the command to run.
 */
export function PlanRow({
	provider,
	className,
	dataProvider,
	title,
	line,
	extra,
	connected,
	plan,
	waiting,
	busy,
	error,
	onConnect,
	onCancel,
	onDisconnect,
}: {
	provider: PlanProvider;
	className: string;
	/** What the row is found by (`data-provider`). */
	dataProvider: string;
	title: string;
	line: string;
	extra?: ReactNode;
	connected: boolean;
	plan: ModelPlanStatus | null;
	waiting: boolean;
	busy: boolean;
	error: string | null;
	onConnect(): void;
	onCancel(): void;
	onDisconnect(): void;
}) {
	return (
		<li
			className={`usage-kept-row provider-row plan-row ${className}`}
			id={`plan-${provider}`}
			data-provider={dataProvider}
		>
			<div className="usage-kept-main">
				<span className="usage-kept-title provider-name">
					{provider === "anthropic" ? <AnthropicLogo /> : <OpenAILogo />}
					{title}
				</span>
				<p className="plan-row-line">{line}</p>
				{extra}
				{waiting ? <PlanCommand provider={provider}>{CONNECT_NOTES[provider]}</PlanCommand> : null}
				{error ? (
					<p className="field-note tone-bad" role="alert">
						{error}
					</p>
				) : null}
			</div>
			<PlanState connected={connected} plan={plan} />
			<div className="provider-actions">
				{waiting ? (
					<button type="button" className="button button-quiet button-small" onClick={onCancel}>
						Cancel
					</button>
				) : connected ? (
					<>
						<button type="button" className="button button-outline button-small" disabled={busy} onClick={onConnect}>
							Reconnect
						</button>
						<button type="button" className="button button-quiet button-small" disabled={busy} onClick={onDisconnect}>
							Disconnect
						</button>
					</>
				) : (
					<button type="button" className="button button-outline button-small" disabled={busy} onClick={onConnect}>
						Connect
					</button>
				)}
			</div>
		</li>
	);
}
