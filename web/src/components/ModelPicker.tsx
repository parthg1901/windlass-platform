/**
 * The one way a model is chosen anywhere: the models grouped by who serves them (a ChatGPT plan, a
 * provider's Settings key, a machine's sign-in), each group with its logo and whose credential it
 * uses, the names cleaned of their provider prefix, the list's default tagged. The start composer
 * builds its tray menu from `modelGroups`; forms (settings, the filing dialog, a work item's agent)
 * open the same menu from a select-styled trigger (`ModelSelect`), and the effort, where a model takes
 * one, is its own small control beside it (`EffortSelect`).
 */
import type { HarnessId, ModelList } from "@contract";
import { useId, type ReactNode } from "react";
import type { ReportedHarness } from "../lib/acp";
import { HARNESS_NAMES } from "../lib/acp";
import { usesAccountModels } from "../../../server/src/sandbox/harnesses.js";
import {
	MODEL_SOURCES,
	SOURCE_NAMES,
	cleanModelName,
	credentialWords,
	effortChoices,
	modelsBySource,
	modelsNote,
	saysDefault,
	sourceOf,
	type ModelSource,
} from "../lib/models";
import { ProviderLogo } from "./AgentLogos";
import { effortGroup, EffortBars } from "./TrayControls";
import { Menu, type MenuGroup, type MenuItem, type MenuSpec } from "./ui/Menu";
import { AgentGlyph } from "./ui/Pill";

/** A model's provider mark in the square an agent's badge has (`AgentGlyph`). */
export function ProviderGlyph({ source }: { source: ModelSource }) {
	return (
		<span className="ui-glyph ui-glyph-logo" aria-hidden="true" data-source={source}>
			<ProviderLogo provider={source === "other" ? "opencode" : source} size={12} />
		</span>
	);
}

/** A model's name as every picker shows it: an agent's own name for it where it gave one, its id in words otherwise. */
export function modelDisplay(harness: HarnessId, list: ModelList | null, id: string): string {
	const reported = usesAccountModels(harness) ? null : (list?.models.find(model => model.id === id)?.name ?? null);
	return cleanModelName(id, reported);
}

/** An agent's own default, as an unset model choice says it: "Opus (Claude Code's default)", or just "Claude Code's default" where its name says so already. */
export function agentDefaultLabel(harness: HarnessId, list: ModelList | null): string {
	const whose = `${HARNESS_NAMES[harness]}'s default`;
	if (!list) return whose;
	const name = modelDisplay(harness, list, list.defaultModel);
	return saysDefault(name) ? whose : `${name} (${whose})`;
}

/** The glyph a model is drawn with: its provider's, or the agent's for an agent's own unnamed default. */
export function modelGlyph(harness: HarnessId, id: string): ReactNode {
	const source = sourceOf(harness, id);
	return source ? <ProviderGlyph source={source} /> : <AgentGlyph harness={HARNESS_NAMES[harness]} />;
}

export interface ModelGroupsOptions {
	harness: HarnessId;
	list: ModelList | null;
	/** The row that is checked; "" checks the `inherit` row. */
	chosen: string;
	onChoose(id: string): void;
	/** A first row that leaves the model unset: what it comes to, in a few words. */
	inherit?: { label: string; description?: string };
	/** The machine's report of the agent, and its name: whose sign-in each group uses there. */
	entry?: ReportedHarness | null;
	machine?: string | null;
	/** Only these providers' groups (the composer's provider tabs). */
	only?: (source: ModelSource) => boolean;
	/** Whose credential each group uses; false where that is not known here (a running agent's own list). */
	credentials?: boolean;
	/** A row's `data-value`; the model's id by default. */
	rowValue?: (id: string) => string;
}

/** The models as menu groups, one per provider, in the order every picker lists them. */
export function modelGroups({
	harness,
	list,
	chosen,
	onChoose,
	inherit,
	entry = null,
	machine = null,
	only,
	credentials = true,
	rowValue,
}: ModelGroupsOptions): MenuGroup[] {
	const bySource = modelsBySource(harness, list);
	const row = (source: ModelSource | null, id: string): MenuItem => {
		const name = modelDisplay(harness, list, id);
		return {
			id: `${harness}:${id}`,
			value: rowValue ? rowValue(id) : id,
			label: name,
			textValue: `${name} ${id}`,
			icon: source ? <ProviderGlyph source={source} /> : <AgentGlyph harness={HARNESS_NAMES[harness]} />,
			trailing: id === list?.defaultModel && !saysDefault(name) ? <span className="ui-tag">default</span> : undefined,
			checked: chosen === id,
			onSelect: () => onChoose(id),
		};
	};
	const groups: MenuGroup[] = [];
	const lead: MenuItem[] = [];
	if (inherit)
		lead.push({
			id: `${harness}:`,
			value: "inherit",
			label: inherit.label,
			description: inherit.description,
			textValue: inherit.label,
			icon: <AgentGlyph harness={HARNESS_NAMES[harness]} accent={harness === "windlass"} />,
			checked: chosen === "",
			onSelect: () => onChoose(""),
		});
	lead.push(...(bySource.get(null) ?? []).map(model => row(null, model.id)));
	// A saved choice the list no longer has: shown checked, so it is plain why nothing else is.
	if (chosen !== "" && list !== null && !list.models.some(model => model.id === chosen))
		lead.push({
			...row(sourceOf(harness, chosen), chosen),
			description: "not offered now",
			tone: "warn",
			onSelect: undefined,
			disabled: true,
		});
	if (lead.length && !only) groups.push({ id: "lead", items: lead });
	for (const source of MODEL_SOURCES) {
		const models = bySource.get(source);
		if (!models || (only && !only(source))) continue;
		groups.push({
			id: `provider:${source}`,
			label: SOURCE_NAMES[source],
			note: (credentials && credentialWords(harness, source, entry, machine)) || undefined,
			items: models.map(model => row(source, model.id)),
		});
	}
	return groups;
}

/** The whole menu, for a picker that has nothing of its own around the rows. */
export function modelMenu(
	options: ModelGroupsOptions & { label?: string; header?: ReactNode; footer?: ReactNode },
): MenuSpec {
	const { list, harness } = options;
	const standIn =
		usesAccountModels(harness) && list !== null && list.source !== "account" ? (
			<p className="ui-menu-note">{modelsNote(list)}</p>
		) : null;
	return {
		label: options.label ?? "Model",
		width: 320,
		maxHeight: 460,
		filter: (list?.models.length ?? 0) > 7 ? { placeholder: "Filter models…" } : undefined,
		header: options.header,
		groups: modelGroups(options),
		empty: list === null ? "Reading the models…" : "No model matches.",
		footer:
			options.footer || standIn ? (
				<>
					{options.footer}
					{standIn}
				</>
			) : undefined,
		hints: false,
	};
}

/**
 * The model in a form: a select-styled button that opens the model menu. `value` "" is the inherited
 * model, said in quiet text by `inherit.label`.
 */
export function ModelSelect({
	id,
	harness,
	list,
	value,
	inherit,
	onChange,
	disabled = false,
	describedBy,
	entry,
	machine,
	label = "Model",
}: {
	id?: string;
	harness: HarnessId;
	list: ModelList | null;
	value: string;
	inherit: { label: string; description?: string };
	onChange(id: string): void;
	disabled?: boolean;
	describedBy?: string;
	entry?: ReportedHarness | null;
	machine?: string | null;
	label?: string;
}) {
	const spec = modelMenu({ harness, list, chosen: value, onChoose: onChange, inherit, entry, machine, label });
	return (
		<Menu
			spec={spec}
			trigger={props => (
				<button
					type="button"
					{...props}
					id={id}
					className={`select${value === "" ? " is-inherited" : ""}`}
					data-picker="model"
					data-value={value}
					disabled={disabled}
					aria-describedby={describedBy}
				>
					{value === "" ? (
						<span className="select-text">{inherit.label}</span>
					) : (
						<>
							{modelGlyph(harness, value)}
							<span className="select-text">{modelDisplay(harness, list, value)}</span>
						</>
					)}
				</button>
			)}
		/>
	);
}

/** The effort in a form: a small select-styled button with the effort's bars, opening the composer's effort menu. */
export function EffortSelect({
	id,
	efforts,
	value,
	model,
	onChange,
	disabled = false,
}: {
	id?: string;
	efforts: readonly string[];
	value: string;
	model: string;
	onChange(level: string): void;
	disabled?: boolean;
}) {
	const fallback = useId();
	const spec: MenuSpec = {
		label: "Effort",
		width: 220,
		groups: [effortGroup(efforts, value, model, onChange)],
		hints: false,
	};
	return (
		<Menu
			spec={spec}
			trigger={props => (
				<button
					type="button"
					{...props}
					id={id ?? fallback}
					className={`select picker-effort${value === "" ? " is-inherited" : ""}`}
					data-picker="effort"
					data-value={value}
					disabled={disabled}
					aria-label={`Effort: ${value || "default"}`}
				>
					<EffortBars level={Math.max(0, effortChoices(efforts).indexOf(value))} of={efforts.length} />
					<span className="select-text">{value || "default"}</span>
				</button>
			)}
		/>
	);
}
