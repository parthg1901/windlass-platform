import { effortChoices } from "../lib/models";
import { ChevronDownIcon, CloudIcon, MachineIcon, ShieldIcon, SlidersIcon } from "./Icons";
import { RepoTile } from "./RepoTile";
import type { MenuGroup, TriggerProps } from "./ui/Menu";
import { AgentGlyph } from "./ui/Pill";
import { Tooltip } from "./ui/Tooltip";

/** An effort as bars, filled to its level. */
export function EffortBars({ level, of }: { level: number; of: number }) {
	const bars = Math.max(of, 3);
	return (
		<span className="effort-bars" aria-hidden="true">
			{Array.from({ length: bars }, (_, index) => (
				<i
					key={index}
					className={index < level ? "effort-bar-on" : undefined}
					style={{ height: 3 + index * (7 / (bars - 1)) }}
				/>
			))}
		</span>
	);
}

/** Where the effort stands among its model's: 0 for the default, one more for each level up. */
const effortLevel = (efforts: readonly string[], effort: string): number =>
	Math.max(0, effortChoices(efforts).indexOf(effort));

export function effortGroup(
	efforts: readonly string[],
	effort: string,
	model: string,
	onChoose: (level: string) => void,
): MenuGroup {
	return {
		id: "effort",
		label: "Effort",
		note: model,
		items: effortChoices(efforts).map((level, index) => ({
			id: `effort:${level || "default"}`,
			value: level || "default",
			label: level || "default",
			textValue: `effort ${level || "default"}`,
			icon: <EffortBars level={index} of={efforts.length} />,
			checked: (effort || "default") === (level || "default"),
			onSelect: () => onChoose(level),
		})),
	};
}

type Dot = "warn" | "changed" | "ok" | "off" | null;

function PillDot({ dot, label }: { dot: Dot; label?: string }) {
	if (!dot) return null;
	return (
		<span
			className={`ui-dot ui-dot-${dot}`}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		/>
	);
}

/** The agent: its logo, name and model. */
export function AgentPill({
	trigger,
	harness,
	name,
	model,
	dot,
	dotLabel,
	changed,
	...data
}: {
	trigger: TriggerProps;
	harness: string;
	name: string;
	model: string;
	dot: Dot;
	dotLabel?: string;
	changed: boolean;
	"data-value": string;
}) {
	return (
		<button
			type="button"
			{...trigger}
			{...data}
			className={`ui-pill tray-pill tray-agent${dot === "warn" ? " ui-pill-warn" : ""}${changed ? " ui-pill-changed" : ""}`}
			data-picker="agent"
			aria-label={`Agent: ${name} · ${model}`}
		>
			<span className="ui-pill-icon">
				<AgentGlyph harness={harness} accent={harness === "windlass"} />
			</span>
			<span className="ui-pill-value tray-hide-phone">{name}</span>
			<span className="ui-pill-secondary tray-hide-phone">{model}</span>
			<PillDot dot={dot} label={dotLabel} />
			<ChevronDownIcon size={12} className="ui-pill-chevron" />
		</button>
	);
}

/**
 * The model's effort: its bars and level, beside the agent. Without a trigger it stands disabled, holding its place,
 * for a model that takes none.
 */
export function EffortButton({
	trigger,
	effort,
	efforts,
}: {
	trigger?: TriggerProps;
	effort: string;
	efforts: readonly string[];
}) {
	const level = effort || "default";
	if (!trigger)
		return (
			<button
				type="button"
				className="ui-pill tray-pill tray-effort tray-effort-none"
				disabled
				aria-label="This model takes no effort setting"
				title="This model takes no effort setting"
			>
				<EffortBars level={0} of={4} />
				<span className="ui-pill-value tray-effort-level tray-hide-phone">default</span>
			</button>
		);
	return (
		<button
			type="button"
			{...trigger}
			className="ui-pill tray-pill tray-effort"
			data-picker="effort"
			data-effort={level}
			aria-label={`Effort: ${level}`}
		>
			<EffortBars level={effortLevel(efforts, effort)} of={efforts.length} />
			<span className="ui-pill-value tray-effort-level tray-hide-phone">{level}</span>
		</button>
	);
}

/**
 * Where: the place, then the repository's tile and name and its branch. With none chosen it says so in
 * words (`empty`, and `emptyShort` on a phone): quietly where none is a fine choice, in the pill's own
 * ink with its warning dot where one is needed (`required`). While the repository it starts on is read,
 * a quiet bar holds its place.
 */
export function WherePill({
	trigger,
	machine,
	place,
	repository,
	branch,
	empty,
	emptyShort,
	required = false,
	dot,
	dotLabel,
	changed,
	reading,
	...data
}: {
	trigger: TriggerProps;
	machine: boolean;
	place: string;
	repository: string | null;
	branch: string | null /** Said where no repository is chosen. */;
	empty: string /** The same in a word or two, for a phone. */;
	emptyShort: string /** A repository is needed: the words are not quiet. */;
	required?: boolean;
	dot: Dot;
	dotLabel?: string;
	changed: boolean;
	reading: boolean;
	"data-value": string;
	"data-sandbox": string;
	"data-repo": string;
}) {
	return (
		<button
			type="button"
			{...trigger}
			{...data}
			className={`ui-pill tray-pill tray-where${dot === "warn" ? " ui-pill-warn" : ""}${changed ? " ui-pill-changed" : ""}`}
			data-picker="where"
			aria-busy={reading || undefined}
			aria-label={`Where: ${place}, ${reading ? "reading the repository" : repository ? `${repository}${branch ? ` at ${branch}` : ""}` : empty}`}
		>
			<span className="ui-pill-icon">{machine ? <MachineIcon size={15} /> : <CloudIcon size={15} />}</span>
			<span className="ui-pill-value tray-place tray-hide-phone">{place}</span>
			<span className="tray-sep tray-hide-phone" aria-hidden="true">
				·
			</span>
			{reading ? (
				<span className="tray-repo-reading" aria-hidden="true" />
			) : repository ? (
				<>
					<RepoTile name={repository.split("/").pop() ?? repository} size="xs" />
					<span className="ui-pill-value tray-repo">{repository.split("/").pop()}</span>
					{branch ? (
						<>
							<span className="tray-sep tray-hide-phone" aria-hidden="true">
								/
							</span>
							<span className="ui-pill-secondary tray-branch tray-hide-phone">{branch}</span>
						</>
					) : null}
				</>
			) : (
				<span className={`tray-repo tray-repo-none${required ? " tray-repo-required" : ""}`}>
					<span className="tray-hide-phone">{empty}</span>
					<span className="tray-only-phone">{emptyShort}</span>
				</span>
			)}
			<PillDot dot={dot} label={dotLabel} />
			<ChevronDownIcon size={12} className="ui-pill-chevron" />
		</button>
	);
}

/** The options: the rarer settings, a dot when one of them needs a look or is set. */
export function OptionsButton({
	trigger,
	label,
	dot,
	value,
}: {
	trigger: TriggerProps;
	label: string;
	dot: "warn" | "set" | null /** What the options hold now, for tests and tools: the mode's name. */;
	value?: string;
}) {
	return (
		<button
			type="button"
			{...trigger}
			className="tray-icon"
			data-picker="options"
			data-value={value}
			aria-label={label}
		>
			<SlidersIcon size={15} />
			{dot ? <span className={`tray-icon-dot tray-icon-dot-${dot}`} aria-hidden="true" /> : null}
		</button>
	);
}

/** The lock: what the sandbox lets its commands do, in a tooltip (and in words for assistive technology). The same sentence is in the options. */
/**
 * The isolation at rest, in the user's word ("Strict" or "Open") and plain ink: Open is the user's own choice, not
 * something that needs attention, so it is never amber. Its tooltip says what it means and where it runs; it opens Where.
 */
export function IsolationChip({ name, sentence, onOpen }: { name: string; sentence: string; onOpen(): void }) {
	return (
		<Tooltip content={sentence}>
			<button
				type="button"
				className="tray-isolation"
				aria-label={`Isolation: ${sentence}`}
				data-picker="isolation"
				data-value={name}
				onClick={onOpen}
			>
				<ShieldIcon size={13} />
				<span>{name}</span>
			</button>
		</Tooltip>
	);
}
