/**
 * The first-run setup on Home's empty page (lib/onboarding.ts says when it opens and what it keeps): ① install the
 * GitHub App, ② pick a repository, ③ connect the agents (a plan, an API key, or a computer of the user's own, the
 * same connects the Connections page has), ④ file a first work item from a starter task or the user's own words.
 * Dismissible at every step and resumed where it was left.
 */
import {
	type GithubRepository,
	type HarnessId,
	type MachineSummary,
	type ModelProvider,
	PLAN_NAMES,
	type PlanProvider,
	type StarterIssue,
} from "@contract";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { PAY_WITH_HARNESSES } from "../../../server/src/pay-with.js";
import { keyProviders, machineHarness } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES } from "../lib/acp";
import { type ConnectionInputs, anyAgentConnected, hostedCell } from "../lib/connections";
import { relativeTime } from "../lib/format";
import { machineLabel } from "../lib/machines";
import { SOURCE_NAMES } from "../lib/models";
import {
	loadOnboarding,
	ONBOARDING_STEPS,
	type OnboardingSaved,
	type OnboardingStep,
	type PickedRepository,
	sampleItem,
	saveOnboarding,
	shouldOnboard,
	startingStep,
	starterTasks,
} from "../lib/onboarding";
import { itemOf } from "../lib/repositories";
import { linkProps, navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { useApp, useAuth } from "../state/app";
import { useConnectionInputs } from "../state/connections";
import { useGithub } from "../state/github";
import { PROVIDERS_CHANGED, useNow } from "../state/hooks";
import {
	BranchIcon,
	CheckIcon,
	LockIcon,
	Mark,
	MergedIcon,
	PencilIcon,
	PullRequestIcon,
	RepoIcon,
	SandboxedIcon,
} from "./Icons";
import { ItemRow } from "./ItemRow";
import { KeyDialog } from "./ModelProviders";
import { PlanWait } from "./PlanConnect";
import { Failure } from "./ui/Failure";
import { AgentGlyph } from "./ui/Pill";
import { StatusTag } from "./ui/StatusTag";

/** What a plan is, under its option. */
const PLAN_KINDS: Record<PlanProvider, string> = { anthropic: "Pro, Max or Team", openai: "Plus, Pro or Business" };

/**
 * Home's empty page: the setup where it opens (`shouldOnboard`), else `children`, with the way back to a dismissed
 * setup while the account is still not set up.
 */
export function OnboardingGate({
	sessions,
	items,
	machines,
	onShowing,
	children,
}: {
	sessions: number | null;
	items: number | null;
	machines: readonly MachineSummary[];
	/** Told whether the setup is on the page: while it is, Home leaves out what an empty account has nothing in. */
	onShowing?(showing: boolean): void;
	children: ReactNode;
}) {
	const { platform } = useApp();
	const auth = useAuth();
	const github = useGithub();
	const { inputs } = useConnectionInputs();
	const uid = auth.profile.uid;
	const [saved, setSaved] = useState(() => loadOnboarding(uid));
	// Once open, it stays open for this visit (connecting the last thing does not close it) until dismissed or done.
	const [latched, setLatched] = useState(false);
	const offered = github.enabled && Boolean(platform.info?.items);
	const githubConnected = github.status === null ? null : github.status.connection !== null;
	const agentConnected = inputs === null ? null : anyAgentConnected(inputs, machines);
	const open = shouldOnboard({
		demo: auth.profile.demo,
		offered,
		githubConnected,
		agentConnected,
		sessions,
		items,
		saved,
	});
	useEffect(() => {
		if (open) setLatched(true);
	}, [open]);
	const keep = useCallback(
		(next: OnboardingSaved) => {
			setSaved(next);
			saveOnboarding(uid, next);
		},
		[uid],
	);
	const showing = (latched && !saved?.dismissed) || open === true;
	const shown = showing && inputs !== null && githubConnected !== null;
	useEffect(() => onShowing?.(shown), [shown, onShowing]);
	useEffect(() => () => onShowing?.(false), [onShowing]);
	if (shown)
		return (
			<Onboarding
				saved={saved}
				githubConnected={githubConnected}
				inputs={inputs}
				machines={machines}
				onSave={keep}
				onDismiss={() => {
					setLatched(false);
					keep({ step: saved?.step ?? 1, repository: saved?.repository ?? null, dismissed: true });
				}}
			/>
		);
	if (open === null && !latched) return null;
	const unfinished =
		saved?.dismissed && offered && (sessions ?? 0) === 0 && (items ?? 0) === 0 && !(githubConnected && agentConnected);
	return (
		<>
			{children}
			{unfinished ? (
				<p className="onboard-resume">
					Your setup is not finished.
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => saved && keep({ ...saved, dismissed: false })}
					>
						Resume setup
					</button>
				</p>
			) : null}
		</>
	);
}

/** Each step's card: what it is called, why it matters, and what it needs first. */
const STEP_CARDS: Record<OnboardingStep, { title: string; why: string; after?: string; action: string }> = {
	1: {
		title: "Connect GitHub",
		why: "Windlass opens pull requests in the repositories you choose.",
		action: "Connect",
	},
	2: {
		title: "Pick a repository",
		why: "Start with one. You can add more any time.",
		after: "After GitHub",
		action: "Pick one",
	},
	3: {
		title: "Connect your agents",
		why: "A plan, an API key, or your own computer.",
		after: "After GitHub",
		action: "Connect",
	},
	4: {
		title: "File your first item",
		why: "A starter task or your own words, ending in a pull request.",
		after: "After a repository",
		action: "Choose a task",
	},
};

const STEP_ICONS: Record<OnboardingStep, ReactNode> = {
	1: <PullRequestIcon size={16} />,
	2: <RepoIcon size={16} />,
	3: <Mark size={16} />,
	4: <BranchIcon size={16} />,
};

/** What runs each plan agent now, in a few words: "Claude Code: Claude plan · Codex: OpenAI key". */
function agentsSummary(inputs: ConnectionInputs, machines: readonly MachineSummary[]): string {
	const lines = PAY_WITH_HARNESSES.flatMap(harness => {
		const hosted = hostedCell(harness, inputs);
		if (hosted.state === "plan" || hosted.state === "key") return [`${HARNESS_NAMES[harness]}: ${hosted.label}`];
		const machine = machines.find(one =>
			one.harnesses?.some(entry => entry.id === harness && entry.signIn === "token"),
		);
		return machine ? [`${HARNESS_NAMES[harness]}: ${machineLabel(machine)}`] : [];
	});
	return lines.length ? lines.join(" · ") : "An agent is connected";
}

/**
 * The setup as four cards in a row (stacked on a phone), the overview: each says why it matters, and a finished one
 * what was chosen. The open step is the large panel under the row (under its card on a phone): what it is for and its
 * choices. Under it all, what a finished item looks like.
 */
function Onboarding({
	saved,
	githubConnected,
	inputs,
	machines,
	onSave,
	onDismiss,
}: {
	saved: OnboardingSaved | null;
	githubConnected: boolean;
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onSave(saved: OnboardingSaved): void;
	onDismiss(): void;
}) {
	const github = useGithub();
	const [step, setStep] = useState<OnboardingStep>(() => startingStep(saved, githubConnected));
	// GitHub's panel, opened again from its card once it is connected.
	const [revisit, setRevisit] = useState(false);
	const repository = saved?.repository ?? null;
	const go = (next: OnboardingStep, picked: PickedRepository | null = repository) => {
		setRevisit(next === 1);
		setStep(next);
		onSave({ step: next, repository: picked, dismissed: false });
	};
	// A step is open once what it needs is there: GitHub for a repository, a repository for the first item.
	const reachable = (target: OnboardingStep) =>
		target === 1 || (githubConnected && (target < 4 || repository !== null));
	// GitHub is connected from its own panel; once it is, the next step opens.
	const open: OnboardingStep = step === 1 && githubConnected && !revisit ? 2 : step;
	const done: Record<OnboardingStep, string | null> = {
		1: githubConnected ? `Connected as ${github.status?.connection?.login ?? "you"}` : null,
		2: repository ? `${repository.owner}/${repository.name}` : null,
		3: anyAgentConnected(inputs, machines) ? agentsSummary(inputs, machines) : null,
		4: null,
	};
	const finished = Object.values(done).filter(Boolean).length;
	return (
		<>
			<section className="onboard" aria-label="Set up Windlass">
				<header className="onboard-head">
					<div>
						<h1 className="onboard-title">Get started</h1>
						<p className="onboard-lede">Four steps from your code to a pull request you review.</p>
					</div>
					<div className="onboard-head-end">
						<span className="onboard-progress">
							<span className="onboard-progress-bar" aria-hidden="true">
								{([1, 2, 3, 4] as const).map(number => (
									<i key={number} data-on={done[number] ? true : undefined} />
								))}
							</span>
							{finished} of {ONBOARDING_STEPS.length} done
						</span>
						<button type="button" className="button button-quiet button-small" onClick={onDismiss}>
							Set up later
						</button>
					</div>
				</header>
				<ol className="onboard-cards">
					{([1, 2, 3, 4] as const).map(number => {
						const card = STEP_CARDS[number];
						const summary = done[number];
						const current = number === open;
						const can = reachable(number);
						const state = current ? "current" : summary ? "done" : can ? "todo" : "blocked";
						return (
							<li
								key={number}
								className="onboard-card"
								data-state={state}
								data-done={summary ? true : undefined}
								aria-current={current ? "step" : undefined}
								style={{ order: number * 2 }}
							>
								<div className="onboard-card-top">
									<span className="onboard-card-icon" aria-hidden="true">
										{summary ? <CheckIcon size={14} /> : STEP_ICONS[number]}
									</span>
									<span className="onboard-card-step">{summary ? "Done" : `Step ${number}`}</span>
								</div>
								<h3>{card.title}</h3>
								<p className="onboard-card-why">{summary ?? card.why}</p>
								<div className="onboard-card-action">
									{current ? (
										<span className="onboard-card-now">{summary ? "Open below" : "Up now"}</span>
									) : !can ? (
										<span className="onboard-card-after">{card.after}</span>
									) : summary ? (
										<button type="button" className="button button-quiet button-small" onClick={() => go(number)}>
											Change<span className="visually-hidden"> {card.title.toLowerCase()}</span>
										</button>
									) : (
										<button type="button" className="button button-outline button-small" onClick={() => go(number)}>
											{card.action}
										</button>
									)}
								</div>
							</li>
						);
					})}
					<li
						className="onboard-open"
						style={{ order: open * 2 + 1 }}
						aria-label={STEP_CARDS[open].title}
						data-step={open}
						key={open}
					>
						{open === 1 ? (
							<GithubStep onNext={() => go(2)} />
						) : open === 2 ? (
							<RepositoryStep picked={repository} onNext={picked => go(3, picked)} />
						) : open === 3 ? (
							<AgentsStep inputs={inputs} machines={machines} onNext={() => go(4)} />
						) : repository ? (
							<FirstItemStep
								repository={repository}
								inputs={inputs}
								onFiled={() => onSave({ step: 4, repository, dismissed: true })}
							/>
						) : null}
					</li>
				</ol>
			</section>
			<Outcome />
		</>
	);
}

/** The open step's heading: where it is in the four, what it is called, and what it is for. */
function PanelHead({ step, lede }: { step: OnboardingStep; lede: ReactNode }) {
	return (
		<header className="onboard-panel-head">
			<p className="onboard-panel-step">
				Step {step} of {ONBOARDING_STEPS.length}
			</p>
			<h2>{STEP_CARDS[step].title}</h2>
			<p className="onboard-sub">{lede}</p>
		</header>
	);
}

/** What installing the GitHub App lets Windlass do, in the user's words (the permissions are in the docs). */
const GITHUB_GRANTS: { what: string; why: string }[] = [
	{ what: "Code", why: "Clone the repository and push the agent's own branch." },
	{ what: "Pull requests", why: "Open the pull request and keep it up to date." },
	{ what: "Checks and CI", why: "Read CI, rerun a failed job, and post the Windlass check." },
	{ what: "Issues", why: "Read an issue you turn into a task, and comment on it." },
];

function GithubStep({ onNext }: { onNext(): void }) {
	const github = useGithub();
	const connection = github.status?.connection ?? null;
	const waiting = github.busy === "leaving" || github.busy === "popup" || github.busy === "finishing";
	const install = () => github.connect({ where: "launch", install: true });
	return (
		<>
			<PanelHead
				step={1}
				lede="Install the Windlass GitHub App. Agents push their own branch and open a pull request for you to review."
			/>
			<div className="onboard-github">
				<div>
					<h3 className="onboard-label">What the App can do</h3>
					<ul className="onboard-grants">
						{GITHUB_GRANTS.map(grant => (
							<li key={grant.what}>
								<CheckIcon size={14} />
								<span>
									<strong>{grant.what}</strong>
									{grant.why}
								</span>
							</li>
						))}
					</ul>
				</div>
				<div className="onboard-aside">
					<h3 className="onboard-label">You choose the repositories</h3>
					<p>
						GitHub asks which ones the App may reach: all of them, or only those you pick. You can change the list any
						time in GitHub's settings.
					</p>
					<p className="onboard-aside-note">
						<LockIcon size={14} />
						Each access token covers one repository for an hour at most, and never reaches the agent's sandbox.
					</p>
				</div>
			</div>
			{github.notice?.tone === "bad" ? <Failure error={github.notice.text} /> : null}
			<Failure error={github.error} />
			<div className="onboard-foot">
				{connection ? (
					<>
						<p className="onboard-done">
							<CheckIcon size={15} />
							Connected as {connection.login}
						</p>
						<div className="onboard-foot-end">
							<button type="button" className="button button-outline" disabled={waiting} onClick={install}>
								{waiting ? "Waiting for GitHub…" : "Add repositories on GitHub"}
							</button>
							<button type="button" className="button button-primary" onClick={onNext}>
								Continue
							</button>
						</div>
					</>
				) : (
					<>
						<button type="button" className="button button-primary button-large" disabled={waiting} onClick={install}>
							{waiting ? "Waiting for GitHub…" : "Install the GitHub App"}
						</button>
						<span className="onboard-foot-note">
							{waiting ? "Finish in the GitHub window, then come back here." : "Opens GitHub. It takes a minute."}
						</span>
					</>
				)}
			</div>
		</>
	);
}

/** The way a task goes once it is filed, under the setup. */
const OUTCOME_FLOW: { icon: ReactNode; title: string; detail: string }[] = [
	{ icon: <PencilIcon size={15} />, title: "You describe a task", detail: "A starter task, an issue, or a sentence." },
	{
		icon: <SandboxedIcon size={15} />,
		title: "An agent works in a sandbox",
		detail: "Its own copy of the repository, where it builds and runs your tests.",
	},
	{
		icon: <PullRequestIcon size={15} />,
		title: "A pull request opens with checks",
		detail: "CI runs, and Windlass flags anything that needs a look.",
	},
	{
		icon: <MergedIcon size={15} />,
		title: "You review and merge",
		detail: "Read the change, ask for more, or merge it.",
	},
];

/** What a finished item looks like before anything is set up: the flow, and an example item's row. */
function Outcome() {
	const now = useNow(60_000);
	return (
		<section className="onboard-outcome" aria-label="What you'll get">
			<h2 className="onboard-outcome-title">What you'll get</h2>
			<ol className="onboard-flow">
				{OUTCOME_FLOW.map(one => (
					<li key={one.title}>
						<span className="onboard-flow-icon" aria-hidden="true">
							{one.icon}
						</span>
						<strong>{one.title}</strong>
						<span>{one.detail}</span>
					</li>
				))}
			</ol>
			<figure className="onboard-example">
				<figcaption>
					<span className="onboard-example-tag">Example</span>
					An item at the end of its run: the pull request is open, CI passed, and it is yours to review.
				</figcaption>
				{/* Sample data: nothing in it leads anywhere. */}
				<ul className="agents" inert>
					<ItemRow item={sampleItem(now)} now={now} repository />
				</ul>
			</figure>
		</section>
	);
}

function RepositoryStep({
	picked,
	onNext,
}: {
	picked: PickedRepository | null;
	onNext(picked: PickedRepository): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [list, setList] = useState<GithubRepository[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState("");
	const [chosen, setChosen] = useState<PickedRepository | null>(picked);
	useEffect(() => {
		let live = true;
		client
			.user(auth)
			.githubRepositories("")
			.then(
				found => live && setList(found.repositories),
				(failure: unknown) => live && setError(explain(failure)),
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain]);
	const wanted = filter.trim().toLowerCase();
	const shown = (list ?? [])
		.filter(one => `${one.owner}/${one.name}`.toLowerCase().includes(wanted))
		.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0))
		.slice(0, 6);
	return (
		<>
			<PanelHead
				step={2}
				lede="An agent works in one repository at a time. Pick one to start with; the rest stay a click away."
			/>
			<div className="onboard-box">
				{list && list.length > 6 ? (
					<input
						className="input"
						placeholder="Filter repositories…"
						aria-label="Filter repositories"
						value={filter}
						onChange={event => setFilter(event.target.value)}
					/>
				) : null}
				{list === null && !error ? (
					<p className="usage-empty" aria-busy="true">
						Reading your repositories…
					</p>
				) : null}
				{list?.length === 0 ? (
					<p className="field-note">
						The GitHub App can reach no repository yet. Add one to its installation at GitHub, then come back.
					</p>
				) : null}
				<div role="radiogroup" aria-label="Repository" className="onboard-panel onboard-repos">
					{shown.map(one => (
						<button
							key={String(one.id)}
							type="button"
							role="radio"
							aria-checked={chosen?.id === one.id}
							className="onboard-choice"
							onClick={() => setChosen({ id: one.id, owner: one.owner, name: one.name })}
						>
							<span className="onboard-choice-mono">
								{one.owner}/{one.name}
							</span>
							<small>
								{one.private ? "Private" : "Public"}
								{one.pushedAt ? ` · pushed ${relativeTime(one.pushedAt, now)}` : ""}
								{one.canPush ? "" : " · read only: no pull request can be opened"}
							</small>
						</button>
					))}
				</div>
				<Failure error={error} />
			</div>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					<button
						type="button"
						className="button button-primary"
						disabled={chosen === null}
						onClick={() => chosen && onNext(chosen)}
					>
						Continue
					</button>
				</div>
			</div>
		</>
	);
}

type AgentOption = "plan" | "key" | "machine";

/** One agent's card: how it is connected, and the three ways to connect it. */
function AgentCard({
	harness,
	inputs,
	machines,
}: {
	harness: HarnessId;
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
}) {
	const plan = machineHarness(harness)?.planProviders[0];
	const key: ModelProvider = keyProviders(harness)[0] ?? "openai";
	const allowed = inputs.plans.allowed && plan !== undefined;
	const [option, setOption] = useState<AgentOption>(allowed ? "plan" : "key");
	const [keying, setKeying] = useState(false);
	const hosted = hostedCell(harness, inputs);
	const onMachine = machines.find(machine =>
		machine.harnesses?.some(entry => entry.id === harness && entry.signIn === "token"),
	);
	const connected = hosted.state === "plan" || hosted.state === "key" || onMachine !== undefined;
	const options: { id: AgentOption; label: string; hint: string; disabled?: boolean }[] = [
		...(plan
			? [
					{
						id: "plan" as const,
						label: `Use my ${PLAN_NAMES[plan]}`,
						hint: allowed ? PLAN_KINDS[plan] : "Not available on this account yet",
						disabled: !allowed,
					},
				]
			: []),
		{ id: "key", label: `${SOURCE_NAMES[key]} API key`, hint: `Billed to your ${SOURCE_NAMES[key]} account` },
		{ id: "machine", label: "Run on my computer", hint: "A computer you pair with Windlass" },
	];
	const name = HARNESS_NAMES[harness];
	return (
		<div className="onboard-box" data-agent={harness}>
			<div className="onboard-agent-head">
				<AgentGlyph harness={harness} size={14} />
				<h3 className="conn-agent">{name}</h3>
				<StatusTag tone={connected ? "good" : "off"} className="conn-state">
					{connected ? (hosted.state === "none" ? "On your computer" : hosted.label) : "Not connected"}
				</StatusTag>
			</div>
			<div role="radiogroup" aria-label={`How ${name} is paid for`} className="onboard-panel">
				{options.map(one => (
					<button
						key={one.id}
						type="button"
						role="radio"
						aria-checked={option === one.id}
						className="onboard-choice"
						disabled={one.disabled}
						onClick={() => setOption(one.id)}
					>
						{one.label}
						<small>{one.hint}</small>
					</button>
				))}
			</div>
			<div className="onboard-panel">
				{option === "plan" && plan && allowed ? (
					hosted.state === "plan" ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							{PLAN_NAMES[plan]} connected
						</p>
					) : (
						<PlanWait key={plan} provider={plan} />
					)
				) : null}
				{option === "key" ? (
					hosted.state === "key" ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							{hosted.label} saved {hosted.detail ? `(${hosted.detail})` : ""}
						</p>
					) : (
						<button type="button" className="button button-outline" onClick={() => setKeying(true)}>
							Add the {SOURCE_NAMES[key]} key…
						</button>
					)
				) : null}
				{option === "machine" ? (
					onMachine ? (
						<p className="onboard-done">
							<CheckIcon size={15} />
							Ready on {machineLabel(onMachine)}
						</p>
					) : (
						<>
							<p className="field-note">Pair the computer you want to use. One pairing serves every agent on it.</p>
							<a className="button button-outline" {...linkProps({ name: "machines", add: true })}>
								Pair a computer
							</a>
						</>
					)
				) : null}
			</div>
			{keying ? <KeyDialog provider={key} replacing={false} onClose={() => setKeying(false)} onSaved={notify} /> : null}
		</div>
	);
}

/** Every reader of keys and plans reads them again. */
function notify() {
	window.dispatchEvent(new Event(PROVIDERS_CHANGED));
}

function AgentsStep({
	inputs,
	machines,
	onNext,
}: {
	inputs: ConnectionInputs;
	machines: readonly MachineSummary[];
	onNext(): void;
}) {
	const ready = anyAgentConnected(inputs, machines);
	return (
		<>
			<PanelHead
				step={3}
				lede="Pick how each one runs: on a plan you already pay for, with an API key, or on your own computer. You can change it later on Connections."
			/>
			<div className="onboard-agents">
				{PAY_WITH_HARNESSES.map(harness => (
					<AgentCard key={harness} harness={harness} inputs={inputs} machines={machines} />
				))}
			</div>
			<p className="onboard-note">
				{inputs.chatgpt ? "Your ChatGPT plan also runs the Windlass agent. " : ""}
				OpenCode, and keys for Google and OpenRouter, are on the{" "}
				<a className="link" {...linkProps({ name: "connections" })}>
					Connections
				</a>{" "}
				page.
			</p>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					{ready ? null : (
						<button type="button" className="button button-outline" onClick={onNext}>
							Skip for now
						</button>
					)}
					<button type="button" className="button button-primary" disabled={!ready} onClick={onNext}>
						Continue
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * The agent a first item runs: Windlass on the ChatGPT sign-in (its default model needs it), else the first plan agent
 * something pays for on Hosted, else the defaults' (null).
 */
function firstAgent(inputs: ConnectionInputs): HarnessId | null {
	if (inputs.chatgpt) return "windlass";
	const paid = PAY_WITH_HARNESSES.find(harness => {
		const { state } = hostedCell(harness, inputs);
		return state === "plan" || state === "key";
	});
	return paid ?? null;
}

const OWN = -1;

function FirstItemStep({
	repository,
	inputs,
	onFiled,
}: {
	repository: PickedRepository;
	inputs: ConnectionInputs;
	onFiled(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [issues, setIssues] = useState<StarterIssue[] | null>(null);
	const [chosen, setChosen] = useState(0);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const asked = useRef<Submission | null>(null);
	useEffect(() => {
		let live = true;
		client
			.user(auth)
			.githubStarterIssues(repository.id)
			.then(
				found => live && setIssues(found),
				// Without them the generic tasks stand.
				() => live && setIssues([]),
			);
		return () => {
			live = false;
		};
	}, [client, auth, repository.id]);
	const tasks = starterTasks(issues ?? []);
	const agent = firstAgent(inputs);
	const own = chosen === OWN ? itemOf(text) : null;
	const task = own
		? { title: own.title, body: own.body || text.trim() }
		: chosen === OWN
			? null
			: (tasks[chosen] ?? null);
	const start = async () => {
		if (!task || busy) return;
		const input = {
			repository: { id: repository.id },
			title: task.title,
			body: task.body,
			// A starter task is small: one agent, no plan first.
			mode: "single" as const,
			start: true,
			...(agent && agent !== "windlass" && { harness: agent }),
		};
		asked.current = submissionOf(JSON.stringify(input), asked.current);
		setBusy(true);
		setError(null);
		try {
			const made = await client.user(auth).createItem({ ...input, idempotencyKey: asked.current.idempotencyKey });
			onFiled();
			navigate({ name: "item", id: made.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};
	return (
		<>
			<PanelHead
				step={4}
				lede={
					<>
						A starter task for{" "}
						<span className="onboard-choice-mono">
							{repository.owner}/{repository.name}
						</span>
						, or your own words{agent ? `. ${HARNESS_NAMES[agent]} builds it` : ""}. It ends in a pull request.
					</>
				}
			/>
			<div className="onboard-box">
				{issues === null ? (
					<p className="usage-empty" aria-busy="true">
						Looking for open bugs…
					</p>
				) : null}
				<div role="radiogroup" aria-label="Starter task" className="onboard-panel">
					{tasks.map((one, index) => (
						<button
							key={one.title}
							type="button"
							role="radio"
							aria-checked={chosen === index}
							className="onboard-choice"
							onClick={() => setChosen(index)}
						>
							{one.title}
							<small>{one.hint}</small>
						</button>
					))}
				</div>
				<textarea
					className="input textarea"
					aria-label="Or say what it should do"
					placeholder="Or say what it should do…"
					value={text}
					onChange={event => {
						setText(event.target.value);
						setChosen(event.target.value.trim() ? OWN : 0);
					}}
				/>
				<Failure error={error} />
			</div>
			<div className="onboard-foot">
				<div className="onboard-foot-end">
					<button type="button" className="button button-primary" disabled={!task || busy} onClick={() => void start()}>
						{busy ? "Starting…" : "Start item"}
					</button>
				</div>
			</div>
		</>
	);
}
