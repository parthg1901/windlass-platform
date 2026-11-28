import type { ItemMode } from "@contract";
import { Segmented } from "./ui/Segmented";
import { ITEM_MODE_WORDS } from "../lib/feature";

/** What the chosen mode costs, in one quiet line under the picker. */
export function ItemModeCost({ id, mode }: { id: string; mode: ItemMode }) {
	return (
		<p className="field-note item-mode-cost" id={id}>
			{mode === "orchestrate"
				? "Adds a planning turn you approve. The feature may spend what you approve for its subtasks, and one Quick item's budget for its planning and review."
				: "Starts one implementer at once, with no plan to approve."}
		</p>
	);
}

export function ItemModePicker({
	value,
	disabled,
	onChange,
	costId,
}: {
	value: ItemMode;
	costId: string;
	disabled: boolean;
	onChange(mode: ItemMode): void;
}) {
	return (
		<Segmented
			aria-label="How it runs"
			aria-describedby={costId}
			value={value}
			disabled={disabled}
			onChange={onChange}
			options={(["orchestrate", "single"] as const).map(mode => ({
				value: mode,
				label: ITEM_MODE_WORDS[mode].name,
				title: ITEM_MODE_WORDS[mode].description,
			}))}
		/>
	);
}
