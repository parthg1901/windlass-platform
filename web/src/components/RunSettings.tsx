/**
 * Where work runs and which agent does it: the account's defaults (Machines: the place; Settings →
 * Models: the agent), a repository's overrides, and the line that says what an item will run with.
 * Every value shown comes from the server's resolver (lib/run.ts); a save patches only what changed.
 */
import type {
	AccountDefaultsPatch,
	HarnessId,
	MachineSummary,
	ModelList,
	RepositoryDefaults,
	SandboxProfileId,
} from "@contract";
import { useId, useState, type ReactNode } from "react";
import { profilesForItems } from "../../../server/src/factory/default-place";
import { hostedAgentProblem, itemProfiles, usesAccountModels } from "../../../server/src/sandbox/harnesses.js";
import type { ResolvedRun, RunSettings } from "../../../server/src/factory/resolve-run";
import { HARNESS_DISPLAY_ORDER, HARNESS_NAMES } from "../lib/acp";
import { machineLabel, machineProfileName } from "../lib/machines";
import { effortsOf, harnessOptions } from "../lib/models";
import {
	SOURCE_WORDS,
	payerWords,
	placeName,
	runModelName,
	runOf,
	runWords,
	sourceOf,
	type RunSource,
} from "../lib/run";
import { sizeLabel, sizeName } from "../lib/sizes";
import { linkProps } from "../lib/router";
import { useMachines } from "../state/machines";
import { useApp, useAuth } from "../state/app";
import { useCatalogs, useHostedCredentials, useModels, type AccountState } from "../state/hooks";
import { CloudIcon, MachineIcon } from "./Icons";
import { EffortSelect, ModelSelect } from "./ModelPicker";
import { AgentGlyph } from "./ui/Pill";
import { Segmented } from "./ui/Segmented";
import { Select } from "./ui/Select";
import { Loading, SkeletonField, SkeletonLines } from "./ui/Skeleton";

type Said = { tone: "good" | "bad"; text: string } | null;

function useSave() {
	const { explain } = useApp();
	const [saving, setSaving] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const save = async (run: () => Promise<void>) => {
		if (saving) return;
		setSaving(true);
		setSaid(null);
		try {
			await run();
			setSaid({ tone: "good", text: "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setSaving(false);
		}
	};
	const status = (
		<p
			className={`run-said${said?.tone === "bad" ? " tone-bad" : ""}`}
			role={said?.tone === "bad" ? "alert" : "status"}
		>
			{saving ? "Saving…" : (said?.text ?? "")}
		</p>
	);
	return { saving, save, status };
}

/** Everything the fields need to know about the account and this deployment. */
function useRunInputs() {
	const { platform } = useApp();
	const info = platform.info;
	const machines = useMachines(!!info?.machines);
	const models = useModels();
	const keys = useHostedCredentials();
	const catalogs = useCatalogs(machines.list);
	const list = machines.list ?? (info?.machines ? null : []);
	const keyProfile = !!info?.profiles.some(p => p.available && p.platformKeys);
	const sizes = info?.hostedSizes ?? [];
	const modelsOf = (run: Pick<ResolvedRun, "agent" | "place">): ModelList | null => {
		if (usesAccountModels(run.agent)) return models.list;
		const place = run.place;
		const at = typeof place === "object" ? list?.find(m => m.machineId === place.machine) : null;
		const host =
			run.place === "hosted"
				? null
				: (at ?? list?.find(m => harnessOptions(m, run.agent, catalogs[m.machineId]?.[run.agent]).models) ?? null);
		return harnessOptions(host, run.agent, host ? catalogs[host.machineId]?.[run.agent] : undefined, keys).models;
	};
	const agentProblem = (
		agent: HarnessId,
		place: ResolvedRun["place"],
		profile: ResolvedRun["profile"],
	): string | null => {
		if (agent === "windlass") return null;
		if (place === "hosted") return keys ? hostedAgentProblem(agent, keys, keyProfile) : null;
		const machine = typeof place === "object" ? list?.find(m => m.machineId === place.machine) : null;
		if (!machine) return null;
		const profiles = profilesForItems(machine, agent);
		if (profile && profiles.length && !profiles.some(p => p.id === profile))
			return `${HARNESS_NAMES[agent]} cannot use ${machineProfileName(profile)} on ${machineLabel(machine)}. Choose a compatible isolation under Place.`;
		return profiles.length
			? null
			: `${HARNESS_NAMES[agent]} can't run on ${machineLabel(machine)} now. Check that it is signed in there.`;
	};
	return { info, machines, list, models, sizes, modelsOf, agentProblem };
}
type RunInputs = ReturnType<typeof useRunInputs>;

// ---- fields ---------------------------------------------------------------------------------------

function PlaceFields({
	run,
	inputs,
	disabled,
	onChange,
}: {
	run: ResolvedRun;
	inputs: RunInputs;
	disabled: boolean;
	onChange(patch: AccountDefaultsPatch): void;
}) {
	const id = useId();
	const machines = inputs.list ?? [];
	const machine =
		typeof run.place === "object"
			? (machines.find(m => m.machineId === (run.place as { machine: string }).machine) ?? null)
			: null;
	const profiles = machine ? profilesForItems(machine, run.agent) : [];
	const value = run.place === "hosted" ? "hosted" : typeof run.place === "object" ? run.place.machine : "any-machine";
	const choose = (next: string) => {
		if (next === "hosted") return onChange({ place: "hosted", machineProfile: null, placeFallback: null });
		const target = machines.find(m => m.machineId === next);
		onChange({
			place: { machine: next },
			machineProfile: target ? (profilesForItems(target, run.agent)[0]?.id ?? null) : null,
		});
	};
	return (
		<div className="run-fields">
			<div className="field">
				<label className="label" htmlFor={id}>
					Runs on
				</label>
				<Select
					id={id}
					menuLabel="Runs on"
					value={value}
					disabled={disabled || inputs.list === null}
					onChange={choose}
					options={[
						{ value: "hosted", label: "Hosted" },
						...machines.map(m => ({ value: m.machineId, label: machineLabel(m) })),
						...(value === "any-machine" ? [{ value, label: "Any of your machines", disabled: true }] : []),
						...(typeof run.place === "object" && !machine
							? [{ value, label: placeName(run.place, inputs.list), disabled: true }]
							: []),
					]}
				/>
			</div>
			{machine ? (
				<>
					<div className="field">
						<label className="label" htmlFor={id + "-profile"}>
							Isolation
						</label>
						<Select<string>
							id={id + "-profile"}
							menuLabel="Isolation"
							value={run.profile ?? profiles[0]?.id ?? ""}
							disabled={disabled}
							onChange={next => onChange({ machineProfile: next as SandboxProfileId })}
							options={[
								...profiles.map(p => ({ value: p.id, label: machineProfileName(p.id) })),
								...(run.profile && !profiles.some(p => p.id === run.profile)
									? [{ value: run.profile, label: `${machineProfileName(run.profile)} (unavailable)`, disabled: true }]
									: []),
								...(!profiles.length && !run.profile ? [{ value: "", label: "None available" }] : []),
							]}
						/>
					</div>
					<div className="field">
						<span className="label" id={id + "-offline"}>
							When it's offline
						</span>
						<Segmented
							fill
							aria-labelledby={id + "-offline"}
							value={run.fallback}
							disabled={disabled}
							onChange={choice => onChange({ placeFallback: choice })}
							options={[
								{ value: "wait" as const, label: "Wait for it" },
								{ value: "hosted" as const, label: "Offer Hosted" },
							]}
						/>
					</div>
				</>
			) : null}
		</div>
	);
}

function HostedFields({
	hosted,
	inputs,
	disabled,
	onChange,
}: {
	hosted: ResolvedRun;
	inputs: RunInputs;
	disabled: boolean;
	onChange(patch: AccountDefaultsPatch): void;
}) {
	const id = useId();
	const profiles = inputs.info?.profiles.filter(p => p.available) ?? [];
	const profile = hosted.profile ?? profiles[0]?.id ?? "";
	return (
		<div className="run-fields">
			{inputs.sizes.length > 1 ? (
				<div className="field">
					<label className="label" htmlFor={id}>
						Hosted size
					</label>
					<Select<string>
						id={id}
						menuLabel="Hosted size"
						value={hosted.size}
						disabled={disabled}
						onChange={next => onChange({ hostedSize: next as ResolvedRun["size"] })}
						options={inputs.sizes.map(size => ({ value: size.id, label: sizeLabel(size) }))}
					/>
				</div>
			) : null}
			{profiles.length > 1 ? (
				<div className="field">
					<label className="label" htmlFor={id + "-profile"}>
						Hosted isolation
					</label>
					<Select<string>
						id={id + "-profile"}
						menuLabel="Hosted isolation"
						value={profile}
						disabled={disabled}
						onChange={next => onChange({ profile: next as SandboxProfileId })}
						options={profiles.map(p => ({ value: p.id, label: p.name }))}
					/>
				</div>
			) : null}
		</div>
	);
}

function AgentFields({
	run,
	inputs,
	disabled,
	onChange,
	review,
}: {
	run: ResolvedRun;
	inputs: RunInputs;
	disabled: boolean;
	onChange(patch: AccountDefaultsPatch): void;
	review?: Pick<AccountDefaultsPatch, "reviewModel" | "reviewEffort">;
}) {
	const id = useId();
	const list = inputs.modelsOf(run);
	const windlass = run.agent === "windlass";
	const model = run.model ?? "";
	const efforts = effortsOf(list, model || (list?.defaultModel ?? ""));
	const problem = inputs.agentProblem(run.agent, run.place, run.profile);
	return (
		<>
			<div className="run-fields">
				{!review ? (
					<div className="field">
						<label className="label" htmlFor={id}>
							Agent
						</label>
						<Select<HarnessId>
							id={id}
							menuLabel="Agent"
							value={run.agent}
							disabled={disabled}
							onChange={harness => onChange({ harness })}
							options={HARNESS_DISPLAY_ORDER.map(agent => {
								const profiles = run.place !== "hosted" && agent !== "windlass" ? itemProfiles(agent) : [];
								return {
									value: agent,
									label: HARNESS_NAMES[agent],
									description: profiles.length === 1 ? `Requires ${machineProfileName(profiles[0]!)}` : undefined,
								};
							})}
						/>
					</div>
				) : null}
				<div className="field">
					<label className="label" htmlFor={id + "-model"}>
						{review ? "Planning model" : "Model"}
					</label>
					<ModelSelect
						id={id + "-model"}
						harness={run.agent}
						list={list}
						value={review ? (review.reviewModel ?? "") : model}
						disabled={disabled}
						inherit={{
							label: review
								? "Same as building"
								: windlass
									? `${runModelName({ agent: "windlass", model: null }, list)} (default)`
									: `${HARNESS_NAMES[run.agent]}'s default`,
						}}
						onChange={next =>
							onChange(
								review
									? { reviewModel: next || null, reviewEffort: null }
									: windlass
										? { model: next || null }
										: { harness: run.agent, machineModel: next || null, machineEffort: null },
							)
						}
					/>
				</div>
				{review || efforts.length > 0 || run.effort ? (
					<div className="field field-effort">
						<label className="label" htmlFor={id + "-effort"}>
							Effort
						</label>
						<EffortSelect
							id={id + "-effort"}
							efforts={efforts}
							value={run.effort ?? ""}
							model={runModelName(run, list)}
							disabled={disabled || (!efforts.length && !run.effort)}
							onChange={level => {
								const effort = level && level !== "default" ? level : null;
								onChange(
									review
										? { reviewEffort: effort }
										: windlass
											? { effort }
											: { harness: run.agent, machineEffort: effort },
								);
							}}
						/>
					</div>
				) : null}
			</div>
			{problem ? <p className="field-note tone-warn">{problem} Items on it stop and ask.</p> : null}
		</>
	);
}

// ---- the line that says what runs -----------------------------------------------------------------

/** "Runs on mac · Codex · Astra · high — your default · Change". */
export function RunLine({
	run,
	machines,
	list,
	lead = "Runs on",
	why,
	onChange,
	changeLabel = "Change",
	children,
}: {
	run: ResolvedRun;
	machines: readonly MachineSummary[] | null;
	list: ModelList | null;
	lead?: string;
	why?: string;
	onChange?: () => void;
	changeLabel?: string;
	children?: ReactNode;
}) {
	const source = sourceOf(run, ["place", "agent", "model", "effort"]);
	const payer = payerWords(run);
	return (
		<p className="run-line" data-source={source}>
			<span className="run-line-icon" aria-hidden="true">
				{run.place === "hosted" ? <CloudIcon size={13} /> : <MachineIcon size={13} />}
			</span>
			<span className="run-line-lead">{lead}</span>
			<AgentGlyph harness={run.agent} size={11} inline />
			<strong className="run-line-value">
				{runWords(run, machines, list)}
				{payer && ` · ${payer}`}
			</strong>
			<span className="run-line-why">— {why ?? SOURCE_WORDS[source]}</span>
			{children}
			{onChange ? (
				<button type="button" className="link run-line-change" onClick={onChange}>
					{changeLabel}
				</button>
			) : null}
		</p>
	);
}

function PreviousStartPlace({
	defaults,
	inputs,
	disabled,
	onChange,
}: {
	defaults: Pick<RepositoryDefaults, "previousStartPlace" | "place">;
	inputs: RunInputs;
	disabled: boolean;
	onChange(patch: AccountDefaultsPatch): void;
}) {
	const start = defaults.previousStartPlace;
	if (!start) return null;
	const place = start.kind === "hosted" ? "hosted" : { machine: start.machineId };
	const label =
		start.kind === "machine" ? `${placeName(place, inputs.list)} (${machineProfileName(start.profile)})` : "Hosted";
	return (
		<p className="field-note">
			Your previous default for new agents was {label}.{" "}
			<button
				type="button"
				className="link"
				disabled={disabled}
				onClick={() => onChange({ place, machineProfile: start.kind === "machine" ? start.profile : null })}
			>
				Use it for all runs
			</button>
			{" · "}
			<button
				type="button"
				className="link"
				disabled={disabled}
				onClick={() => onChange({ place: defaults.place ?? null })}
			>
				Keep the current place
			</button>
		</p>
	);
}

// ---- Machines: the default place ------------------------------------------------------------------

/** The default place while the account and the deployment are read: its field and its note, as shapes. */
export function DefaultPlaceSkeleton() {
	return (
		<Loading label="Loading your defaults" className="run-default">
			<div className="run-fields">
				<SkeletonField />
			</div>
			<SkeletonLines title={false} lines={[72]} />
		</Loading>
	);
}

export function DefaultPlace({ account }: { account: AccountState }) {
	const { client } = useApp();
	const auth = useAuth();
	const inputs = useRunInputs();
	const { saving, save, status } = useSave();
	const defaults = account.settings?.defaults ?? null;
	if (!defaults || !inputs.info) return <DefaultPlaceSkeleton />;
	const run = runOf({ account: defaults, sizes: inputs.sizes });
	const hosted = runOf({ account: defaults, item: { place: "hosted" }, sizes: inputs.sizes });
	const change = (patch: AccountDefaultsPatch) =>
		save(async () => {
			const next = await client.user(auth).saveAccountDefaults(patch);
			account.replace({ ...account.settings!, defaults: next });
		});
	const usesHosted = run.place === "hosted" || run.fallback === "hosted";
	return (
		<div className="run-default">
			<PreviousStartPlace defaults={defaults} inputs={inputs} disabled={saving} onChange={change} />
			<PlaceFields run={run} inputs={inputs} disabled={saving} onChange={change} />
			{usesHosted ? <HostedFields hosted={hosted} inputs={inputs} disabled={saving} onChange={change} /> : null}
			<p className="field-note run-note">
				{run.place === "hosted"
					? "Work items and new agents run on Hosted unless a repository or the item says otherwise."
					: run.fallback === "wait"
						? "When the machine is offline, items wait for it."
						: "When the machine is offline, the item asks whether to wait or run on Hosted."}{" "}
				The agent and model are in{" "}
				<a className="link" {...linkProps({ name: "settings", section: "settings-models" })}>
					Settings → Models
				</a>
				.
			</p>
			{status}
		</div>
	);
}

// ---- Settings → Models: the default agent ---------------------------------------------------------

export function DefaultAgent({ account }: { account: AccountState }) {
	const { client } = useApp();
	const auth = useAuth();
	const inputs = useRunInputs();
	const { saving, save, status } = useSave();
	const defaults = account.settings?.defaults ?? null;
	// One skeleton while the account and the deployment are read, the shape of the fields that replace it.
	if (!defaults || !inputs.info)
		return (
			<Loading label="Loading your defaults" className="run-default">
				<h3 className="usage-title">Builds with</h3>
				<div className="run-fields">
					<SkeletonField />
					<SkeletonField />
					<SkeletonField />
				</div>
				<h3 className="usage-title">Plans &amp; reviews with</h3>
				<div className="run-fields">
					<SkeletonField />
					<SkeletonField />
				</div>
			</Loading>
		);
	const run = runOf({ account: defaults, sizes: inputs.sizes });
	const planning = runOf({ account: defaults, sizes: inputs.sizes }, "planner");
	const change = (patch: AccountDefaultsPatch) =>
		save(async () => {
			const next = await client.user(auth).saveAccountDefaults(patch);
			account.replace({ ...account.settings!, defaults: next });
		});
	return (
		<div className="run-default">
			<h3 className="usage-title">Builds with</h3>
			<AgentFields run={run} inputs={inputs} disabled={saving} onChange={change} />
			<h3 className="usage-title">Plans &amp; reviews with</h3>
			<AgentFields run={planning} inputs={inputs} disabled={saving} review={defaults} onChange={change} />
			{status}
		</div>
	);
}

// ---- a repository's overrides ---------------------------------------------------------------------

interface OverrideRowProps {
	title: string;
	value: string;
	source: RunSource;
	overridden?: boolean;
	open: boolean;
	disabled: boolean;
	onOpen(): void;
	onReset(): void;
	children: ReactNode;
}

function OverrideRow({
	title,
	value,
	source,
	overridden = source === "repository",
	open,
	disabled,
	onOpen,
	onReset,
	children,
}: OverrideRowProps) {
	const own = source === "repository";
	return (
		<div className={`run-row${open ? " run-row-open" : ""}`}>
			<div className="run-row-head">
				<span className="run-row-title">{title}</span>
				<span className="run-row-value">{value}</span>
				<span className={`run-row-source${own ? " run-row-own" : ""}`}>
					{own ? "set for this repository" : SOURCE_WORDS[source]}
				</span>
				{overridden ? (
					<button type="button" className="link run-row-action" disabled={disabled} onClick={onReset}>
						Use your default
					</button>
				) : open ? null : (
					<button type="button" className="link run-row-action" disabled={disabled} onClick={onOpen}>
						Override for this repository
					</button>
				)}
			</div>
			{open || overridden ? <div className="run-row-body">{children}</div> : null}
		</div>
	);
}

export function RepositoryOverrides({
	account,
	defaults,
	save,
	onSaved,
}: {
	account: AccountState;
	defaults: RepositoryDefaults;
	save(change: AccountDefaultsPatch): Promise<RepositoryDefaults>;
	onSaved(next: RepositoryDefaults): void;
}) {
	const inputs = useRunInputs();
	const { saving, save: persist, status } = useSave();
	const [open, setOpen] = useState<"place" | "agent" | "review" | "hosted" | null>(null);
	if (!account.settings || !inputs.info)
		return (
			<Loading label="Loading your defaults">
				<SkeletonLines title={false} lines={[100, 100, 100]} />
			</Loading>
		);
	const layers = {
		account: account.settings.defaults,
		repository: defaults,
		machines: inputs.list,
		sizes: inputs.sizes,
	};
	const run = runOf(layers);
	const planning = runOf(layers, "planner");
	const hosted = runOf({ ...layers, item: { place: "hosted" } satisfies RunSettings });
	const change = (patch: AccountDefaultsPatch) => persist(async () => onSaved(await save(patch)));
	const reset = (patch: AccountDefaultsPatch) => {
		setOpen(null);
		void change(patch);
	};
	const list = inputs.modelsOf(run);
	const machineProfile = run.place === "hosted" ? defaults.machineProfile : run.profile;
	const placeValue = [
		placeName(run.place, inputs.list),
		run.place !== "hosted" && (run.fallback === "wait" ? "waits when offline" : "offers Hosted when offline"),
		machineProfile && `Machine isolation: ${machineProfileName(machineProfile)}`,
	]
		.filter(Boolean)
		.join(" · ");
	const hostedValue = [
		inputs.sizes.length > 1 ? sizeName(hosted.size) : null,
		inputs.info.profiles.find(p => p.id === hosted.profile)?.name ?? inputs.info.profiles.find(p => p.available)?.name,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="run-overrides">
			<PreviousStartPlace defaults={defaults} inputs={inputs} disabled={saving} onChange={change} />
			<OverrideRow
				title="Place"
				value={placeValue}
				source={defaults.machineProfile != null ? "repository" : sourceOf(run, ["place", "fallback"])}
				open={open === "place"}
				disabled={saving}
				onOpen={() => setOpen("place")}
				onReset={() => reset({ place: null, machineProfile: null, placeFallback: null })}
			>
				<PlaceFields run={run} inputs={inputs} disabled={saving} onChange={change} />
			</OverrideRow>
			<OverrideRow
				title="Agent"
				value={runWords(run, inputs.list, list, { place: false })}
				source={sourceOf(run, ["agent", "model", "effort"])}
				open={open === "agent"}
				disabled={saving}
				onOpen={() => setOpen("agent")}
				onReset={() => reset({ harness: null, machineModel: null, machineEffort: null, model: null, effort: null })}
			>
				<AgentFields run={run} inputs={inputs} disabled={saving} onChange={change} />
			</OverrideRow>
			<OverrideRow
				title="Plans &amp; reviews"
				value={runWords(planning, inputs.list, inputs.models.list, { place: false })}
				source={sourceOf(planning, ["model", "effort"]) === "repository" ? "repository" : "account"}
				overridden={defaults.reviewModel != null || defaults.reviewEffort != null}
				open={open === "review"}
				disabled={saving}
				onOpen={() => setOpen("review")}
				onReset={() => reset({ reviewModel: null, reviewEffort: null })}
			>
				<AgentFields run={planning} inputs={inputs} disabled={saving} review={defaults} onChange={change} />
			</OverrideRow>
			{hostedValue ? (
				<OverrideRow
					title="Hosted sandbox"
					value={hostedValue}
					source={sourceOf(hosted, ["size", "profile"])}
					open={open === "hosted"}
					disabled={saving}
					onOpen={() => setOpen("hosted")}
					onReset={() => reset({ hostedSize: null, profile: null })}
				>
					<HostedFields hosted={hosted} inputs={inputs} disabled={saving} onChange={change} />
				</OverrideRow>
			) : null}
			{status}
		</div>
	);
}
