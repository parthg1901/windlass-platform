/**
 * Work items in lists: on a repository's page, its items grouped by where each is, with the way to
 * file a new one; on the home page, the items that ask their person something ("Needs you"); on the
 * Factory page (screens/Factory.tsx), every item, grouped by what its person must do.
 *
 * The list is the user's actor's live feed (`itemFeed`): every open item and the newest filed ended
 * ones, with counts beside them. It is read when a screen opens, replaced whenever the actor says an
 * item changed (`onItems`), and read again when that feed comes back after a drop, since what was said
 * meanwhile is lost. Nothing is asked on a timer. The ended items beyond come from the server a page at
 * a time (`listItems` with a page, `useEndedPages`), on the Factory page and on a repository's. Every sentence a
 * row shows of why an item waits is the server's (`Waiting.sentence`), shown as it was written.
 *
 * Filing one, where the deployment offers machines and the user has one, says where it runs as the
 * start composer of an agent does, with the same cards (components/PlaceChoice.tsx): this platform, or one of the user's
 * machines. On a machine the server gives it that machine's first available sandbox.
 */
import {
	type GithubId,
	type HarnessId,
	ITEM_PAGE_DEFAULT,
	MAX_ACCEPTANCE_CRITERIA,
	MAX_ITEM_BODY_CHARS,
	MAX_NOTE_CHARS,
	MAX_TITLE_CHARS,
	type CreateItemInput,
	type ItemCursor,
	type ItemMode,
	type ItemState,
	type ItemSummary,
} from "@contract";
import { checkRunPlace } from "../../../server/src/factory/default-place";
import { byFiling, nextCursor } from "../../../server/src/item-pages";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { hasReason } from "../api/client";
import { MACHINE_REFUSALS } from "../api/errors";
import { Dialog } from "../components/Dialog";
import { PlaceChoice, itemHarnesses, itemProfilesHere, machineUnusable } from "../components/PlaceChoice";
import { RunLine } from "../components/RunSettings";
import { runModelName, runOf } from "../lib/run";
import { hostedAgentProblem, subtaskHarnessProblem } from "../../../server/src/sandbox/harnesses.js";
import { HARNESS_NAMES } from "../lib/acp";
import { ChevronIcon, WarnIcon } from "../components/Icons";
import { count, plural } from "../lib/format";
import { feedCounts, type FeedFilters } from "../lib/repositories";
import { navigate } from "../lib/router";
import { submissionOf, type Submission } from "../lib/submission";
import { useApp, useAuth } from "../state/app";
import { useCatalogs, useHostedCredentials, useModels, useNow } from "../state/hooks";
import { agentModelsOf } from "../lib/subtask-agents";
import { DefaultsProblem, useFilingDefaults, useCatalog } from "../components/StartComposer";
import { effortChoices, effortsOf, harnessOptions } from "../lib/models";
import { EffortSelect, ModelSelect, agentDefaultLabel, modelDisplay } from "../components/ModelPicker";
import { useMachines } from "../state/machines";
import { hardenedItemNote, machineLabel } from "../lib/machines";
import { ItemModeCost, ItemModePicker } from "../components/ItemModePicker";
import { ITEM_MODE_WORDS } from "../lib/feature";
import { Check } from "../components/ui/Check";
import { ItemRow } from "../components/ItemRow";
import { STATE_WORD } from "../lib/items";
import { useItems } from "../state/items";
import { LoadError, Loading, Segmented } from "../components/ui";

// ---- the ended items, a page at a time ----------------------------------------------------------

const ENDED_STATES: ReadonlySet<ItemState> = new Set(["done", "failed", "cancelled"]);
/** Whether an item stands on or before the cursor in the list's order (filed no earlier than the cursor's item). */
const onOrBefore = (item: ItemSummary, cursor: ItemCursor) => byFiling(item, cursor) <= 0;

export interface EndedPages {
	/** The ended items shown, newest filed first: the pages read, as the live feed has them now. */
	items: ItemSummary[];
	/** Whether the server has more after them. */
	more: boolean;
	loading: boolean;
	error: string | null;
	/** Reads the next page; the first again, when it could not be read. */
	loadMore(): void;
}

/**
 * The ended rows: the pages read, held against the live feed (`live`, under the same filters). A row
 * the feed has shows the item as the feed has it now, and leaves once it is no longer ended; one the
 * feed does not carry (it carries only the newest ended ones) shows as it was read. One that ended
 * since and is filed among those shown joins them (anywhere, once `cursor` is null: the last page is in).
 */
export function mergeEnded(
	read: readonly ItemSummary[],
	live: readonly ItemSummary[] | null,
	cursor: ItemCursor | null,
): ItemSummary[] {
	const current = new Map((live ?? []).map(item => [item.id, item]));
	const rows = new Map<string, ItemSummary>();
	for (const item of read) {
		const now = current.get(item.id) ?? item;
		if (ENDED_STATES.has(now.state)) rows.set(item.id, now);
	}
	// Ended since, and filed among the rows shown (or anywhere, once the last page is read).
	for (const item of live ?? [])
		if (ENDED_STATES.has(item.state) && !rows.has(item.id) && (cursor === null || onOrBefore(item, cursor)))
			rows.set(item.id, item);
	return [...rows.values()].sort(byFiling);
}

/** The ended items, read from the server a page at a time once `open`, under the filters; other filters start again from the first page. */
export function useEndedPages(open: boolean, filters: FeedFilters, live: readonly ItemSummary[] | null): EndedPages {
	const { client, explain } = useApp();
	const auth = useAuth();
	const key = `${filters.repository ?? ""}|${filters.from ?? ""}`;
	const [state, setState] = useState<{
		key: string;
		read: ItemSummary[];
		cursor: ItemCursor | null;
		started: boolean;
		loading: boolean;
		error: string | null;
	}>({ key, read: [], cursor: null, started: false, loading: false, error: null });
	const asked = useRef(0);
	const mine = state.key === key ? state : { key, read: [], cursor: null, started: false, loading: false, error: null };

	const read = useCallback(
		(from: ItemCursor | null, before: ItemSummary[]) => {
			const ask = ++asked.current;
			setState({ key, read: before, cursor: from, started: true, loading: true, error: null });
			client
				.user(auth)
				.listItems({
					ended: true,
					before: from,
					limit: ITEM_PAGE_DEFAULT,
					repository: filters.repository ?? null,
					source: filters.from ?? null,
				})
				.then(
					page =>
						ask === asked.current &&
						setState({
							key,
							read: [...before, ...page],
							cursor: nextCursor(page, ITEM_PAGE_DEFAULT),
							started: true,
							loading: false,
							error: null,
						}),
					(failure: unknown) =>
						ask === asked.current &&
						setState({ key, read: before, cursor: from, started: true, loading: false, error: explain(failure) }),
				);
		},
		[client, auth, explain, key, filters.repository, filters.from],
	);

	// The first page, when the ended ones are unfolded, and again under other filters.
	useEffect(() => {
		if (open && !mine.started) read(null, []);
	}, [open, mine.started, read]);
	useEffect(
		() => () => {
			asked.current += 1;
		},
		[],
	);

	// Nothing is shown before the first page is in: the feed alone would draw only the newest ended items.
	const loaded = mine.started && !(mine.read.length === 0 && (mine.loading || mine.error !== null));
	return {
		items: loaded ? mergeEnded(mine.read, live, mine.cursor) : [],
		more: loaded && mine.cursor !== null,
		loading: mine.loading,
		error: mine.error,
		loadMore: () => {
			if (mine.loading) return;
			if (mine.error !== null && mine.read.length === 0) read(null, []);
			else if (mine.cursor !== null) read(mine.cursor, mine.read);
		},
	};
}

/** Under the ended rows: the way to the next page, or what is in the way of it. */
export function EndedFoot({ pages }: { pages: EndedPages }) {
	if (pages.loading) {
		return (
			<p className="agents-fold items-fold factory-more" aria-busy="true" role="status">
				{pages.items.length === 0 ? "Reading the ended items…" : "Reading more…"}
			</p>
		);
	}
	if (pages.error !== null) {
		return (
			<p className="agents-fold items-fold factory-more tone-bad" role="alert">
				{pages.error}{" "}
				<button type="button" className="link" onClick={pages.loadMore}>
					Try again
				</button>
			</p>
		);
	}
	if (!pages.more) return null;
	return (
		<p className="agents-fold items-fold factory-more">
			<button type="button" className="link machine-toggle" onClick={pages.loadMore}>
				<ChevronIcon size={11} className="machine-chevron" />
				Show {ITEM_PAGE_DEFAULT} more
			</button>
		</p>
	);
}

/** "25 done, 2 failed, 3 cancelled": what a fold of ended items holds, from the feed's counts. */
export function endedWords(counts: { done: number; failed: number; cancelled: number }): string {
	return (["done", "failed", "cancelled"] as const)
		.filter(state => counts[state] > 0)
		.map(state => `${counts[state]} ${state}`)
		.join(", ");
}

// ---- a repository's items -----------------------------------------------------------------------

const SHOWN: ItemState[] = ["draft", "queued", "working", "waiting", "review"];

function Group({
	name,
	items,
	now,
	count: said,
	filed = false,
	children,
}: {
	name: string;
	items: ItemSummary[];
	now: number;
	count?: string;
	filed?: boolean;
	children?: ReactNode;
}) {
	const heading = useId();
	return (
		<div className="items-group">
			<h3 className="items-group-head" id={heading}>
				{name}
				<span className="items-group-count">{said ?? count(items.length)}</span>
			</h3>
			<ul className="agents" aria-labelledby={heading}>
				{items.map(item => (
					<ItemRow key={item.id} item={item} now={now} filed={filed} />
				))}
			</ul>
			{children}
		</div>
	);
}

/**
 * The "Work items" section of a repository's page, where the deployment offers them. `launchable`: new
 * work can be filed on it now. The open items come from the live feed; the ended ones are folded, said
 * by the feed's counts, and read from the server a page at a time once unfolded, newest filed first.
 */
export function RepositoryItems({
	repositoryId,
	name,
	base,
	launchable,
	now,
	filter,
}: {
	repositoryId: GithubId;
	name: string;
	base: string | null;
	launchable: boolean;
	now: number;
	filter?: (item: ItemSummary) => boolean;
}) {
	const { platform } = useApp();
	const offered = Boolean(platform.info?.items);
	const items = useItems(offered);
	const [filing, setFiling] = useState(false);
	const [open, setOpen] = useState(false);
	const ended = useId();
	// `filter`: the Agents home's filters, which narrow the open items and the ended ones read so far; the counts stay the feed's.
	const onIt = (item: ItemSummary) => !item.parent && String(item.repository.id) === String(repositoryId);
	const shown = (item: ItemSummary) => filter?.(item) ?? true;
	const live = items.list?.filter(onIt) ?? null;
	const mine = items.feed?.open.filter(item => onIt(item) && shown(item)) ?? null;
	const counts = feedCounts(items.feed, { repository: repositoryId });
	const pages = useEndedPages(open, { repository: repositoryId }, live);
	const of = (state: ItemState) => mine?.filter(item => item.state === state) ?? [];
	const total = mine === null ? null : mine.length + counts.ended;
	if (!offered) return null;

	return (
		<section className="usage-section" aria-labelledby="repo-items">
			<h2 className="usage-title" id="repo-items">
				Work items
				{total !== null && total > 0 ? <span className="usage-count">{total}</span> : null}
				<button
					type="button"
					className="link secret-add"
					onClick={() => setFiling(true)}
					disabled={!launchable}
					title={launchable ? undefined : "No work can be filed on this repository now"}
				>
					New work item…
				</button>
			</h2>
			<p className="usage-lede">
				An agent works on each by itself. CI on its pull request decides whether the work passes; your checks for the
				repository, where you set them, run first and send the agent back when one fails. It is handed to you as a pull
				request with what the verdict rests on. Merging it is yours.
			</p>
			{mine === null ? (
				items.error ? (
					<LoadError subject="The work items" error={items.error} reload={items.reload} />
				) : (
					<Loading label="Loading the work items" className="ui-loading-spaced" />
				)
			) : total === 0 ? (
				<p className="usage-empty">
					No work item on this repository yet.{launchable ? " File one with New work item." : ""}
				</p>
			) : (
				<>
					{items.error ? (
						<p className="callout callout-warn" role="status">
							<WarnIcon />
							<span>{items.error} What is shown may be behind.</span>
						</p>
					) : null}
					{SHOWN.map(state =>
						of(state).length > 0 ? <Group key={state} name={STATE_WORD[state]} items={of(state)} now={now} /> : null,
					)}
					{counts.ended > 0 ? (
						<>
							<p className="agents-fold items-fold">
								<button
									type="button"
									className="link machine-toggle"
									aria-expanded={open}
									aria-controls={ended}
									onClick={() => setOpen(value => !value)}
								>
									<ChevronIcon size={11} className="machine-chevron" />
									{open ? "Hide the ended ones" : `Show ${plural(counts.ended, "ended item")}`}
								</button>
								{open ? null : <span>{endedWords(counts)}</span>}
							</p>
							<div id={ended} hidden={!open}>
								{open ? (
									<Group
										name="Ended"
										items={filter ? pages.items.filter(shown) : pages.items}
										now={now}
										filed
										count={
											pages.items.length < counts.ended
												? `${count(pages.items.length)} of ${count(counts.ended)}`
												: undefined
										}
									>
										<EndedFoot pages={pages} />
									</Group>
								) : null}
							</div>
						</>
					) : null}
				</>
			)}
			{filing ? (
				<NewItemDialog repositoryId={repositoryId} name={name} base={base} onClose={() => setFiling(false)} />
			) : null}
		</section>
	);
}

/** Filing a work item: what to do, and what a person will check. It runs on a hosted sandbox, or on one of the user's machines where they have one. */
export function NewItemDialog({
	repositoryId,
	name,
	base,
	onClose,
}: {
	repositoryId: GithubId;
	name: string;
	base: string | null;
	onClose(): void;
}) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const machinesInfo = platform.info?.items ? (platform.info.machines ?? null) : null;
	const machines = useMachines(machinesInfo !== null);
	const now = useNow(30_000);
	const mine = machinesInfo === null ? [] : (machines.list ?? []);
	const { saved, account, problem: defaultsProblem, retry } = useFilingDefaults(repositoryId);
	const keys = useHostedCredentials();
	const accountModels = useModels();
	// What this item changes for itself; everything else comes from the repository, then your defaults.
	const [changing, setChanging] = useState(false);
	const [placeChoice, setPlace] = useState<string | null>();
	const [agentChoice, setAgent] = useState<HarnessId | null>(null);
	const [modelChoice, setModel] = useState("");
	const [effortChoice, setEffort] = useState("");
	const [modeChoice, setMode] = useState<ItemMode>("orchestrate");
	const orchestrate = !!platform.info?.items?.orchestrate;
	const partProblem = agentChoice && subtaskHarnessProblem(agentChoice);
	const mode: ItemMode = orchestrate && !partProblem ? modeChoice : "single";
	const layers = {
		account: account.settings?.defaults,
		repository: saved.defaults,
		sizes: platform.info?.hostedSizes,
	};
	const placeLayer =
		placeChoice === undefined ? {} : { place: placeChoice === null ? ("hosted" as const) : { machine: placeChoice } };
	const agentRun = runOf(
		{ ...layers, item: { ...placeLayer, harness: agentChoice } },
		mode === "orchestrate" ? "part" : "builder",
	);
	const windlassAgent = agentRun.agent === "windlass";
	const selectedLayers = {
		...layers,
		item: {
			...placeLayer,
			harness: agentChoice,
			...(modelChoice && (windlassAgent ? { model: modelChoice } : { machineModel: modelChoice })),
			...(effortChoice && (windlassAgent ? { effort: effortChoice } : { machineEffort: effortChoice })),
		},
	};
	const run = runOf(selectedLayers, mode === "orchestrate" ? "part" : "builder");
	const planning = mode === "orchestrate" ? runOf(selectedLayers, "planner") : null;
	const catalogs = useCatalogs(mine);
	const destination = checkRunPlace(run, mine, agentModelsOf(mine, catalogs, null));
	const agent = run.agent;
	const chosenMachine =
		typeof run.place === "object"
			? (mine.find(
					machine =>
						machine.machineId === (run.place as { machine: string }).machine &&
						machineUnusable(machine, machinesInfo?.minRunnerVersion ?? "", "item") === null,
				) ?? null)
			: null;
	const hostedProfile = platform.info?.profiles.find(p => p.available && p.platformKeys);
	const agents = chosenMachine
		? itemHarnesses(chosenMachine).map(({ id }) => ({
				id,
				reason: itemProfilesHere(chosenMachine, id).length ? null : `Not available on ${machineLabel(chosenMachine)}`,
			}))
		: (["claude", "codex", "opencode"] as const).map(id => ({
				id,
				reason: hostedAgentProblem(id, keys, !!hostedProfile),
			}));
	const catalog = useCatalog(agent === "windlass" ? null : chosenMachine, agent === "windlass" ? "claude" : agent);
	const modelList =
		agent === "windlass" ? accountModels.list : harnessOptions(chosenMachine, agent, catalog.options, keys).models;
	const model = run.model ?? "";
	const efforts = effortChoices(effortsOf(modelList, model || (modelList?.defaultModel ?? ""))).filter(
		level => level !== "" && level !== "default",
	);
	const changed = placeChoice !== undefined || agentChoice !== null || modelChoice !== "" || effortChoice !== "";
	const useDefault = () => {
		setPlace(undefined);
		setAgent(null);
		setModel("");
		setEffort("");
		setChanging(false);
	};
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [criteria, setCriteria] = useState("");
	const [start, setStart] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const last = useRef<Submission | null>(null);
	const ids = {
		form: useId(),
		title: useId(),
		body: useId(),
		criteria: useId(),
		criteriaNote: useId(),
		model: useId(),
		effort: useId(),
		effortNote: useId(),
	};
	const acceptance = criteria
		.split("\n")
		.map(line => line.trim())
		.filter(line => line !== "");
	const tooMany = acceptance.length > MAX_ACCEPTANCE_CRITERIA;
	const tooLong = acceptance.some(line => line.length > MAX_NOTE_CHARS);
	const defaultsLoading = saved.reading || (account.reading && !account.settings);
	const machinesLoading = machinesInfo && !machines.list && !machines.error;
	const ready =
		!defaultsProblem &&
		!defaultsLoading &&
		!machinesLoading &&
		title.trim() !== "" &&
		!tooMany &&
		!tooLong &&
		body.length <= MAX_ITEM_BODY_CHARS;

	const file = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready || busy) return;
		const input: Omit<CreateItemInput, "idempotencyKey"> = {
			repository: { id: repositoryId },
			title,
			body: body.trim(),
			acceptance,
			start,
			mode: orchestrate ? mode : "single",
			...(placeChoice !== undefined && {
				place:
					placeChoice === null ? { kind: "hosted" as const } : { kind: "machine" as const, machineId: placeChoice },
			}),
			...(agentChoice && { harness: agentChoice }),
			...(modelChoice ? { model: modelChoice } : {}),
			...(effortChoice ? { effort: effortChoice } : {}),
		};
		// Every attempt of the same form is one submission: a call that was answered late is not taken twice.
		const submission = submissionOf(JSON.stringify(input), last.current);
		last.current = submission;
		setBusy(true);
		setError(null);
		try {
			const item = await client.user(auth).createItem({ ...input, idempotencyKey: submission.idempotencyKey });
			last.current = null;
			onClose();
			navigate({ name: "item", id: item.id });
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
			if (MACHINE_REFUSALS.some(reason => hasReason(failure, reason))) machines.reload();
		}
	};

	return (
		<Dialog
			title="New work item"
			lede={
				<>
					On {name}, as a pull request into {base ?? "its default branch"}.
				</>
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={!ready || busy}>
						{busy ? "Filing…" : start ? "File and start" : "File as a draft"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={file}>
				{platform.info?.items?.orchestrate ? (
					<div>
						<span className="label">How it runs</span>
						<ItemModePicker
							costId={ids.form + "-cost"}
							value={mode}
							onChange={setMode}
							disabled={busy || mode !== modeChoice}
						/>
						<ItemModeCost id={ids.form + "-cost"} mode={mode} />
						<p className="field-note">{ITEM_MODE_WORDS[mode].description}</p>
					</div>
				) : null}
				<div>
					<label className="label" htmlFor={ids.title}>
						Title
					</label>
					<input
						id={ids.title}
						className="input"
						value={title}
						maxLength={MAX_TITLE_CHARS}
						onChange={event => setTitle(event.target.value)}
						readOnly={busy}
						data-autofocus
					/>
				</div>
				<div>
					<label className="label" htmlFor={ids.body}>
						What to do
					</label>
					<textarea
						id={ids.body}
						className="input textarea item-body"
						value={body}
						maxLength={MAX_ITEM_BODY_CHARS}
						onChange={event => setBody(event.target.value)}
						readOnly={busy}
					/>
					<p className="field-note">The agent is given this and the title as your own words.</p>
				</div>
				<div>
					<label className="label" htmlFor={ids.criteria}>
						Acceptance criteria<span className="label-optional">optional</span>
					</label>
					<textarea
						id={ids.criteria}
						className={`input textarea item-criteria${tooMany || tooLong ? " input-invalid" : ""}`}
						value={criteria}
						onChange={event => setCriteria(event.target.value)}
						readOnly={busy}
						aria-describedby={ids.criteriaNote}
						aria-invalid={tooMany || tooLong || undefined}
					/>
					<p className={`field-note${tooMany || tooLong ? " tone-bad" : ""}`} id={ids.criteriaNote}>
						{tooMany
							? `At most ${MAX_ACCEPTANCE_CRITERIA}; there are ${acceptance.length}.`
							: tooLong
								? `Each is at most ${count(MAX_NOTE_CHARS)} characters.`
								: "One per line. The agent is given them, and the verdict lists them for you to check: no machine checks them."}
					</p>
				</div>
				<div className="item-run">
					<span className="label">Runs with</span>
					{defaultsProblem ? (
						<DefaultsProblem problem={defaultsProblem} retry={retry} />
					) : (
						<>
							<RunLine
								run={run}
								machines={machines.list}
								list={modelList}
								lead={mode === "orchestrate" ? "Parts run on" : "Runs on"}
								onChange={changing ? undefined : () => setChanging(true)}
								changeLabel="Change for this item"
							>
								{changed ? (
									<button type="button" className="link run-line-change" onClick={useDefault} disabled={busy}>
										Use the default
									</button>
								) : null}
							</RunLine>
							{planning ? (
								<p className="field-note">
									Planning and review run on Windlass with {runModelName(planning, accountModels.list)}.
								</p>
							) : null}
							{destination.wait ? (
								<p className="field-note tone-warn">
									{destination.wait} The item waits and asks before it runs anywhere else.
								</p>
							) : null}
						</>
					)}
				</div>
				{changing ? (
					<div className="item-run-change">
						{mine.length > 0 ? (
							<PlaceChoice
								machines={mine}
								chosen={chosenMachine}
								minRunnerVersion={machinesInfo?.minRunnerVersion ?? ""}
								now={now}
								purpose="item"
								onChoose={setPlace}
							>
								{chosenMachine ? <p className="field-note place-note">{hardenedItemNote(chosenMachine)}</p> : null}
							</PlaceChoice>
						) : null}
						<div className="harness-pick">
							<span className="label">Agent</span>
							<Segmented
								aria-label="Agent"
								value={agent}
								disabled={busy}
								onChange={id => {
									setAgent(id);
									setModel("");
									setEffort("");
								}}
								options={[{ id: "windlass" as const, reason: null }, ...agents].map(({ id, reason }) => ({
									value: id,
									label: HARNESS_NAMES[id],
									title: reason ?? undefined,
									disabled: !!reason,
								}))}
							/>
							{partProblem && orchestrate && modeChoice === "orchestrate" ? (
								<p className="field-note">{partProblem}</p>
							) : null}
						</div>
						{modelList && modelList.models.length > 0 ? (
							<div className="item-agent-fields">
								<div>
									<label className="label" htmlFor={ids.model}>
										Model
									</label>
									<ModelSelect
										id={ids.model}
										harness={agent}
										list={modelList}
										value={model}
										inherit={{ label: agentDefaultLabel(agent, modelList) }}
										entry={chosenMachine?.harnesses?.find(one => one.id === agent) ?? null}
										machine={chosenMachine ? machineLabel(chosenMachine) : null}
										onChange={next => {
											setModel(next);
											setEffort("");
										}}
										disabled={busy}
									/>
								</div>
								{efforts.length > 0 ? (
									<div>
										<label className="label" htmlFor={ids.effort}>
											Effort
										</label>
										<EffortSelect
											id={ids.effort}
											efforts={efforts}
											value={run.effort ?? ""}
											model={modelDisplay(agent, modelList, model || modelList.defaultModel)}
											onChange={setEffort}
											disabled={busy}
										/>
									</div>
								) : null}
							</div>
						) : null}
						<p className="field-note">
							These choices are for this item only. Your defaults are on Machines and in Settings → Models.
						</p>
					</div>
				) : null}
				<Check checked={start} disabled={busy} onChange={on => setStart(on)}>
					<span className="check-name">Start now</span>
					<span className="check-means">
						{start
							? chosenMachine
								? `It starts as soon as “${machineLabel(chosenMachine)}” is online and has a free slot; until then it waits, and says for what.`
								: "It starts as soon as one of your hosted sandboxes is free; until then it waits, and says for what."
							: "It is kept as a draft until you start it from its page."}
					</span>
				</Check>
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span>{error}</span>
					</p>
				) : null}
			</form>
		</Dialog>
	);
}
