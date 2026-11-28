/**
 * One agent: the conversation and composer in the main column, the session's facts beside it.
 *
 * An agent on one of the user's machines says so beside its title, and above the composer says when
 * that machine is offline, stopped answering in the middle of a turn, or was removed. What the session
 * last found is in its snapshot (`SessionSnapshot.machine`) and then in its `machine` event, each time
 * that changes. Whether the machine is offline or gone is also in the user's live list of machines,
 * which is read for such a session only.
 *
 * A work item's agent (`SessionSummary.item`) is the item's: the server takes no prompt for it, so
 * the page has no composer, and says in its place that the item's steps send its prompts, with the
 * way to the item (`ItemNote`). What the server does allow there stays: Stop while a turn runs, a tool
 * call's stop, the answers to its questions, and the panel's pull request and servers.
 *
 * An agent of another harness than Windlass (Claude Code, on one of the user's machines) says which
 * beside its title, and the page draws only what its capabilities say it does (`SessionSummary.capabilities`),
 * never by its name: a tool call's stop only where one call can be stopped (`cancelCall`), the models it
 * offered where it has its own list (`models`), and Plan mode where it has one (`planMode`). Where its
 * machine says it is not signed in, the line above the composer shows the machine terminal command.
 */
import { hostedAgentProblem } from "../../../server/src/sandbox/harnesses.js";
import { monthSentence, monthState } from "../lib/hosted";
import {
	USAGE_LOW_SHARE,
	type ItemView,
	type MachineSummary,
	type SandboxPlace,
	type SessionSnapshot,
	type SessionSummary,
	type UsageNumbers,
} from "@contract";
import { useCallback, useMemo, useRef, useState } from "react";
import { MissingPageLinks } from "../components/MissingPageLinks";
import { HarnessStatus } from "../components/HarnessStatus";
import { Composer, ItemNote } from "../components/Composer";
import { Conversation } from "../components/Conversation";
import { CheckIcon, Mark, PauseIcon, PullRequestIcon, RefreshIcon, WarnIcon } from "../components/Icons";
import { SecretAsk, withoutValue } from "../components/SecretAsk";
import { hasReason } from "../api/client";
import { InteractiveProvider, QuestionDock, useQuestionFlow, type Interactive } from "../components/Question";
import { acpHarnessName, HARNESS_NAMES, harnessModelsOf, sessionModelWords } from "../lib/acp";
import { currentMode, sessionModes } from "../lib/modes";
import { SidePanel } from "../components/SidePanel";
import { STATUS_WORD, StatusBadge, StatusGlyph } from "../components/Status";
import { AgentGlyph, Popover, Tooltip } from "../components/ui";
import { clockDuration, localTime, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { sessionTrail } from "../lib/nav";
import { PageTrail } from "../components/Nav";
import type { ToolBlock } from "../lib/timeline";
import { useApp, useAuth } from "../state/app";
import { takeHandover } from "../state/handover";
import { allowanceState, useAllowance, useHostedCredentials, useModels, useNow, type useSession } from "../state/hooks";
import {
	requestPublish,
	setPanelHidden,
	setPublishFeedback,
	usePanelHidden,
	usePublishFeedback,
} from "../state/sessionChrome";
import { clockTime } from "../lib/format";
import { useMachines } from "../state/machines";
import { machineLabel } from "../lib/machines";

/** How long a turn waits for a machine that stopped answering before it ends: the grace of the runner's channel on the server. */
const MACHINE_GRACE_MS = 10 * 60_000;

/**
 * The machine a session runs on, from the user's live list of machines: undefined for a hosted session
 * and while the list is not known, null once it is known and the machine is not in it (it was removed).
 */
export function useSessionMachine(place: SandboxPlace | undefined): MachineSummary | null | undefined {
	const machineId = place?.kind === "machine" ? place.machineId : null;
	const { list } = useMachines(machineId !== null);
	if (machineId === null || list === null) return undefined;
	return list.find(machine => machine.machineId === machineId) ?? null;
}

function PanelIcon({ size = 16 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.6}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<rect x="2" y="2.75" width="12" height="10.5" rx="2" />
			<path d="M10 3v10" />
		</svg>
	);
}

/** The state beside the title: while a turn runs or waits on you, a pill with how long the turn has run; otherwise the plain badge. */
function CrumbState({ status, since }: { status: SessionSummary["status"]; since: number | null }) {
	const live = status === "running" || status === "starting" || status === "waiting";
	const now = useNow(1000, live && since !== null);
	if (!live) return <StatusBadge status={status} />;
	const waiting = status === "waiting";
	return (
		<span
			className={`crumb-pill crumb-pill-${status}`}
			role="status"
			title={waiting ? "A question waits for your answer" : undefined}
		>
			<StatusGlyph status={status} size={13} />
			<span>{STATUS_WORD[status]}</span>
			{since !== null ? <span className="crumb-pill-time">{clockDuration(now - since)}</span> : null}
		</span>
	);
}

/** The way out from the bar: "Publish pull request" asks the panel to open its dialog; an open pull request is a link to it. */
function BarPublish({ summary }: { summary: SessionSummary }) {
	const pull = summary.pullRequest ?? null;
	if (!summary.repository || summary.item) return null;
	if (pull && pull.state !== "closed") {
		return (
			<a
				className="bar-button bar-pull"
				href={pull.url}
				target="_blank"
				rel="noreferrer"
				title={`${pull.title} · ${pull.state}`}
			>
				<PullRequestIcon size={14} />
				<span>#{pull.number}</span>
				<span className="bar-pull-state">{pull.state}</span>
			</a>
		);
	}
	return <BarPublishButton summary={summary} />;
}

/**
 * "Publish pull request": never a silent press. While the panel reads what there is to publish (on a machine,
 * through its runner, for seconds), it says so and the dialog opens by itself; where the dialog cannot open,
 * why not, in a small popover at the button, with the way to the panel's section.
 */
function BarPublishButton({ summary }: { summary: SessionSummary }) {
	const button = useRef<HTMLButtonElement>(null);
	const feedback = usePublishFeedback(summary.id);
	const busy = summary.status !== "idle";
	const reading = feedback?.kind === "reading";
	const close = () => setPublishFeedback(summary.id, null);
	const refused = feedback?.kind === "refused";
	const control = (
		<button
			ref={button}
			type="button"
			className="bar-button"
			onClick={() => (busy || reading ? undefined : requestPublish(summary.id))}
			aria-disabled={busy || reading || undefined}
			aria-busy={reading || undefined}
		>
			{reading ? <RefreshIcon size={14} className="spin" /> : <PullRequestIcon size={14} />}
			<span className="bar-button-label">{reading ? "Reading changes…" : "Publish pull request"}</span>
		</button>
	);
	return (
		<>
			{/* No tooltip over the popover that says why. */}
			{refused ? (
				control
			) : (
				<Tooltip
					content={
						busy
							? "Available when this turn ends"
							: reading
								? "Reading what the workspace has to publish"
								: "Commit, push and open a pull request"
					}
				>
					{control}
				</Tooltip>
			)}
			<Popover
				open={refused}
				onClose={close}
				anchor={button}
				align="end"
				maxWidth={320}
				role="dialog"
				label="Why the pull request cannot be published now"
				initialFocus="none"
				className="bar-publish-why"
			>
				<p className="bar-publish-why-text">{feedback?.kind === "refused" ? feedback.reason : null}</p>
				<button
					type="button"
					className="link"
					onClick={() => {
						close();
						requestPublish(summary.id, "show");
					}}
				>
					Open the pull request section
				</button>
			</Popover>
		</>
	);
}

/** The model and the mode, after what runs the session. */
function CrumbModel({ summary }: { summary: SessionSummary }) {
	const { platform } = useApp();
	const profile = platform.info?.profiles.find(one => one.id === summary.profile);
	return (
		<>
			<span>{sessionModelWords(summary)}</span>
			{profile ? <span>{currentMode(summary, profile).name}</span> : null}
		</>
	);
}

/** Shows or hides the side panel, on a screen wide enough to have it beside the conversation. */
function PanelToggle() {
	const hidden = usePanelHidden();
	return (
		<Tooltip content={hidden ? "Show the session's details" : "Hide the session's details"}>
			<button
				type="button"
				className={`bar-icon panel-toggle${hidden ? "" : " bar-icon-on"}`}
				onClick={() => setPanelHidden(!hidden)}
				aria-pressed={!hidden}
				aria-label="Agent details"
			>
				<PanelIcon />
			</button>
		</Tooltip>
	);
}

/**
 * What the top bar shows for a session: the way back, its repository, its title and state, and on the
 * right what runs it and the way out. A work item's session is part of its item, and the way back is to
 * the item. `summary`, once known, adds the repository, the turn's time, the facts and the actions.
 */
/** `itemView`: a work item's agent's item, once read: the crumb names it, and its feature first for a subtask. */
export function SessionCrumb({
	title,
	status,
	place,
	machine,
	item,
	harness,
	summary = null,
	itemView = null,
}: {
	title: string | null;
	status: Parameters<typeof StatusBadge>[0]["status"] | null;
	place?: SandboxPlace;
	machine?: MachineSummary | null;
	item?: SessionSummary["item"];
	harness?: SessionSummary["harness"];
	summary?: SessionSummary | null;
	itemView?: ItemView | null;
}) {
	const harnessName = acpHarnessName({ harness });
	const machineName = machine ? machineLabel(machine) : null;
	const repository = summary?.repository ?? null;
	const live =
		summary !== null && (summary.status === "running" || summary.status === "starting" || summary.status === "waiting");
	return (
		<>
			<PageTrail trail={sessionTrail({ title, repository, item }, itemView)} heading>
				{status !== null ? <CrumbState status={status} since={live ? summary.updatedAt : null} /> : null}
			</PageTrail>
			<div className="crumb-end">
				<p className="crumb-facts">
					{place?.kind === "machine" ? (
						<span className="chip crumb-place">
							{harnessName ? <AgentGlyph harness={harness ?? "windlass"} size={11} inline /> : null}
							{harnessName
								? `${harnessName} on ${machineName ? `“${machineName}”` : "your machine"}`
								: `On ${machineName ?? "your machine"}`}
						</span>
					) : summary ? (
						<span>
							<AgentGlyph harness={harness ?? "windlass"} size={11} inline />
							{harnessName ?? "Windlass"}
						</span>
					) : null}
					{summary ? <CrumbModel summary={summary} /> : null}
				</p>
				{summary ? <BarPublish summary={summary} /> : null}
				{summary ? <PanelToggle /> : null}
			</div>
		</>
	);
}

/**
 * What the banner above the composer says of the session's machine; null when it answers. The snapshot
 * says what the session last found, the live list whether the machine is offline now or gone; a machine
 * the list says came back after what the snapshot found is not reported.
 */
function machineNote(
	reach: SessionSnapshot["machine"],
	machine: MachineSummary | null | undefined,
	sandbox: SessionSummary["sandbox"],
	now: number,
	item = false,
	paused = false,
): { text: string; removed: boolean } | null {
	if (reach?.state === "removed" || machine === null)
		return {
			removed: true,
			text: `This agent's machine was removed. Its files were there.${item ? "" : " Start a new agent to go on."}`,
		};
	const named = machine ? `Your machine "${machineLabel(machine)}"` : "Your machine";
	const back = reach != null && machine?.status === "online" && machine.since >= reach.since;
	if (reach?.state === "not_answering" && !back) {
		return {
			removed: false,
			text: `${named} is not answering since ${clockTime(reach.since, now)}. The turn goes on when it is back, or stops at ${clockTime(reach.since + MACHINE_GRACE_MS, now)}.`,
		};
	}
	const offline =
		machine?.status === "offline" ? machine.since : reach?.state === "offline" && !back ? reach.since : null;
	if (offline === null) return null;
	// A turn paused for the machine resumes by itself: nothing is to be sent again.
	if (paused)
		return {
			removed: false,
			text: `${named} is offline since ${clockTime(offline, now)}. This turn resumes by itself when it is back${item ? "" : "; what you send meanwhile is held for it"}.`,
		};
	return {
		removed: false,
		text: `${named} is offline since ${clockTime(offline, now)}.${sandbox === "none" ? "" : " The agent's files are there."}${item ? "" : " Send a prompt once it is back."}`,
	};
}

/** What the composer says about the user's limits before a prompt runs into one; null while there is nothing to say. */
function limitNote(numbers: UsageNumbers | null, summary: SessionSummary): string | null {
	if (numbers === null) return null;
	const left = allowanceState(numbers, USAGE_LOW_SHARE);
	const resets = localTime(numbers.resetsAt);
	// The month's hosted minutes count only where the agent runs hosted.
	if (summary.place.kind === "hosted" && monthState(numbers) !== "plenty") {
		const month = monthSentence(numbers, null);
		if (month !== null)
			return monthState(numbers) === "used" && summary.status !== "idle"
				? `${month} This turn is stopped when the time it holds is over, with its files kept.`
				: month;
	}
	if (summary.place.kind !== "hosted" && numbers.hosted) return null;
	if (left === "used") {
		return summary.status === "idle"
			? `Today's sandbox time is used up, so a turn cannot start before ${resets}.`
			: "Today's sandbox time is nearly used up: this turn is stopped when the time it holds is over, with its files kept.";
	}
	if (left === "low" && numbers.leftSeconds !== null)
		return `${sandboxTime(numbers.leftSeconds)} of today's sandbox time is left. A turn that runs longer is stopped; the allowance is whole again at ${resets}.`;
	const { kept, limit } = numbers.sandboxes;
	if (summary.sandbox === "none" && limit !== null && kept >= limit)
		return `You keep ${limit} hosted sandboxes, the most an account may have, so this agent cannot start until one is freed.`;
	return null;
}

/** `machine`: the machine the session runs on, as `useSessionMachine` says. */
export function Session({
	sessionId,
	state,
	machine,
	item = null,
}: {
	sessionId: string;
	state: ReturnType<typeof useSession>;
	machine?: MachineSummary | null;
	item?: ItemView | null;
}) {
	const { client, explain, platform } = useApp();
	const models = useModels();
	const hostedAgent =
		state.summary?.place.kind === "hosted" && state.summary.harness !== "windlass" ? state.summary.harness : undefined;
	const keys = useHostedCredentials(!!hostedAgent);
	const auth = useAuth();
	const api = useMemo(() => client.session(auth, sessionId), [client, auth, sessionId]);
	const handover = useMemo(() => takeHandover(sessionId), [sessionId]);
	const [suggestion, setSuggestion] = useState<{ key: number; text: string } | null>(null);
	// Asked again when a turn starts or ends, and when a prompt was refused: each moves what is left of the day.
	const [planMode, setPlanMode] = useState(false);
	const [refusals, setRefusals] = useState(0);
	const allowance = useAllowance(
		`${state.turnsEnded}:${state.summary?.status ?? ""}:${refusals}`,
		state.phase !== "missing",
	);
	const online = state.connection === "connected";
	const flow = useQuestionFlow(api, state.phase === "ready" ? state.question : null, explain);
	const stopCall = useCallback(
		async (block: ToolBlock) => {
			try {
				return await api.stopCall({ messageId: block.messageId, callId: block.callId });
			} catch (failure) {
				throw new Error(explain(failure));
			}
		},
		[api, explain],
	);
	const setMode = useCallback(
		async (mode: string) => {
			try {
				await api.setMode(mode);
			} catch (failure) {
				explain(failure);
				throw failure;
			}
		},
		[api, explain],
	);
	const stop = useCallback(async () => {
		try {
			await api.stop();
		} catch (failure) {
			throw new Error(explain(failure));
		}
	}, [api, explain]);
	// An agent that cannot stop one call of a turn (`capabilities.cancelCall`) offers only the turn's stop.
	const cancelCall = state.summary?.capabilities.cancelCall === true;
	const panelHidden = usePanelHidden();
	const allowHost = useCallback(
		async (host: string) => {
			try {
				return await api.allowHost(host);
			} catch (failure) {
				throw new Error(explain(failure));
			}
		},
		[api, explain],
	);
	const repositoryId = state.summary?.repository?.id ?? null;
	// The agent's open request for a secret, answered above the field. Hidden once answered here, before the turn it starts closes it.
	const [answeredSecret, setAnsweredSecret] = useState<string | null>(null);
	const [savedSecret, setSavedSecret] = useState<{ name: string; turnsEnded: number } | null>(null);
	const secretRequest = state.secretRequest && state.secretRequest.id !== answeredSecret ? state.secretRequest : null;
	const secretRequestId = secretRequest?.id ?? null;
	const itemId = state.summary?.item?.id ?? null;
	const interactive = useMemo<Interactive>(
		() => ({
			flow,
			stopCall: online && cancelCall ? stopCall : null,
			allowHost: online ? allowHost : null,
			repositoryId,
			secretRequestId,
			itemId,
		}),
		[flow, stopCall, online, cancelCall, allowHost, repositoryId, secretRequestId, itemId],
	);
	// The last save's error, for the card of the same name should the session's snapshot bring the request back under a new id.
	const [secretFailure, setSecretFailure] = useState<{ name: string; message: string } | null>(null);
	const addSecret = useCallback(
		async (request: { id: string; name: string }, value: string) => {
			setSecretFailure(null);
			try {
				await api.setRequestedSecret({ requestId: request.id, name: request.name, value });
			} catch (failure) {
				const message = withoutValue(explain(failure), value);
				setSecretFailure({ name: request.name, message });
				// The name was saved under Secrets since it was asked (`secret_exists`), or the request moved on: read the session
				// again, so that a retry answers the request it has now.
				if (hasReason(failure, "secret_exists") || hasReason(failure, "no_question")) api.resync();
				throw new Error(message);
			}
			setSecretFailure(null);
			setAnsweredSecret(request.id);
			setSavedSecret({ name: request.name, turnsEnded: state.turnsEnded });
		},
		[api, explain, state.turnsEnded],
	);
	const continueWithout = useCallback(
		async (request: { id: string; name: string }) => {
			try {
				await api.prompt({ text: `Continue without ${request.name}.` });
			} catch (failure) {
				throw new Error(explain(failure));
			}
			setAnsweredSecret(request.id);
		},
		[api, explain],
	);

	if (state.phase === "missing") {
		const from = history.state?.fromPage;
		const fromItem = from === "item" || from === "factory";
		const section = state.missingSection ?? (fromItem ? "factory" : platform.info?.items ? "both" : "home");
		return (
			<main className="state state-page">
				<Mark size={56} />
				<h1 className="display display-small">This agent was deleted</h1>
				<MissingPageLinks section={section} />
			</main>
		);
	}

	if (state.phase === "failed") {
		return (
			<main className="state state-page state-error" role="alert">
				<WarnIcon size={28} />
				<h1 className="display display-small">This agent could not be opened</h1>
				<p>{state.error?.message ?? "The server could not be reached."}</p>
				<button type="button" className="button button-outline" onClick={() => location.reload()}>
					Try again
				</button>
			</main>
		);
	}

	if (state.phase === "loading" || !state.summary || !state.profile) {
		return (
			<main className="session session-loading" aria-busy="true" aria-label="Opening the agent">
				<div className="session-main">
					<div className="conversation-inner">
						<span className="skeleton skeleton-title" style={{ width: "38%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "64%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "52%" }} />
						<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						<span className="skeleton skeleton-title" style={{ width: "72%" }} />
					</div>
				</div>
				<aside className="panel">
					<span className="skeleton skeleton-title" style={{ width: "40%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "80%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "70%" }} />
					<span className="skeleton skeleton-meta" style={{ width: "76%" }} />
				</aside>
			</main>
		);
	}

	const { summary, profile, view } = state;
	const reach =
		summary.place.kind === "machine"
			? machineNote(
					state.machine,
					machine,
					summary.sandbox,
					Date.now(),
					summary.item !== undefined,
					summary.status === "paused" && summary.paused?.reason === "machine",
				)
			: null;

	return (
		<main className={`session${panelHidden ? " session-panel-hidden" : ""}`}>
			<div className="session-main">
				{state.connection === "reconnecting" ? (
					<p className="banner banner-warn" role="status">
						<WarnIcon size={14} />
						The connection dropped. Reconnecting; what you see may be behind.
					</p>
				) : state.connection === "failed" ? (
					<p className="banner banner-bad" role="alert">
						<WarnIcon size={14} />
						{state.error?.message ?? "The connection was lost."}
						<button type="button" className="link" onClick={() => location.reload()}>
							Reload
						</button>
					</p>
				) : null}
				{item?.question && summary.item?.role !== "reviewer" ? (
					<p className="banner banner-needs" role="status">
						<span className="banner-needs-dot" aria-hidden="true" />
						{item.parent ? "This subtask waits for your answer." : "This work item waits for your answer."} The agent is
						idle until you reply.
						<a className="link" {...linkProps({ name: "item", id: item.id })}>
							Answer on its page
						</a>
					</p>
				) : null}
				<InteractiveProvider value={interactive}>
					<Conversation
						view={view}
						summary={summary}
						profile={profile}
						onSuggest={text => setSuggestion(current => ({ key: (current?.key ?? 0) + 1, text }))}
					/>
				</InteractiveProvider>
				{reach ? (
					// In the composer's column, at its width and inner padding: it is about what the composer can do now.
					<div className="session-banner">
						<p className={`banner ${reach.removed ? "banner-bad" : "banner-warn"}`} role="status">
							<WarnIcon size={14} />
							{reach.text}
							{/* A turn paused while the machine is away: it is not over, and resumes by itself when the machine is back. */}
							{summary.status === "paused" && summary.paused?.reason === "machine" && !reach.removed ? (
								<span
									className="chip banner-chip"
									title="The turn resumes by itself when the machine is back. Stop ends it."
								>
									<PauseIcon size={11} />
									turn paused
								</span>
							) : null}
						</p>
					</div>
				) : null}
				{machine?.harnesses
					?.filter(h => h.id === summary.harness)
					.map(h => (
						<HarnessStatus key={h.id} harness={h} machineName={machineLabel(machine)} />
					))}
				<QuestionDock flow={flow} />
				{secretRequest ? (
					<div className="q-dock-wrap">
						<div className="q-dock secret-dock">
							<SecretAsk
								key={secretRequest.id}
								compact
								request={secretRequest}
								repository={summary.repository ? `${summary.repository.owner}/${summary.repository.name}` : null}
								shared={summary.harness !== undefined && summary.harness !== null && summary.harness !== "windlass"}
								offline={!online}
								failure={secretFailure?.name === secretRequest.name ? secretFailure.message : null}
								onAdd={value => addSecret(secretRequest, value)}
								onWithout={() => continueWithout(secretRequest)}
							/>
						</div>
					</div>
				) : savedSecret && savedSecret.turnsEnded === state.turnsEnded ? (
					<div className="q-dock-wrap">
						<p className="callout secret-ask-saved" role="status">
							<CheckIcon size={14} className="tone-good" />
							<span>
								<code className="secret-ask-name">{savedSecret.name}</code> saved; the agent continues.
							</span>
						</p>
					</div>
				) : null}
				{summary.item ? (
					<ItemNote item={summary.item} status={summary.status} online={online} onStop={stop} />
				) : (
					<Composer
						status={summary.status}
						online={online}
						models={summary.capabilities.models === "harness" ? harnessModelsOf(summary) : models.list}
						model={summary.model}
						effort={summary.effort ?? null}
						modelProblem={
							hostedAgent
								? model =>
										hostedAgentProblem(
											hostedAgent,
											keys,
											true,
											model === "default" ? summary.harnessModels?.defaultModel : model,
										)
								: undefined
						}
						harness={summary.capabilities.models === "harness" ? HARNESS_NAMES[summary.harness ?? "windlass"] : null}
						modes={sessionModes(summary, profile)}
						mode={summary.mode}
						onMode={setMode}
						planMode={summary.capabilities.planMode ? { on: planMode, onChange: setPlanMode } : null}
						initial={handover}
						suggestion={suggestion}
						limitNote={summary.place.kind === "machine" ? null : limitNote(allowance, summary)}
						closed={reach?.removed ? "Its machine was removed, so this agent cannot run again." : null}
						onSend={async input => {
							try {
								await api.prompt(
									summary.capabilities.planMode && planMode && summary.status === "idle"
										? { ...input, planMode: true }
										: input,
								);
							} catch (failure) {
								setRefusals(value => value + 1);
								// `explain` signs out on a refused token; the composer reads the rest itself (`turn_running`, `steer_unavailable`).
								explain(failure);
								throw failure;
							}
						}}
						onStop={stop}
					/>
				)}
				<a className="to-details" href="#details">
					Agent details, usage and changes
				</a>
			</div>
			<SidePanel
				egress={machine?.egress ?? (summary.place.kind === "hosted" ? platform.info?.hostedEgress : undefined)}
				hosted={summary.place.kind === "hosted"}
				domains={machine?.egressDomains}
				machineName={machine ? machineLabel(machine) : null}
				sessionId={sessionId}
				summary={summary}
				profile={profile}
				view={view}
				turnsEnded={state.turnsEnded}
				question={flow.question}
			/>
		</main>
	);
}
