/**
 * A choice in a form: a field-styled button showing the chosen option, opening the shared menu (a
 * popover on a wide screen, a bottom sheet on a phone). It stands in for a native select: the
 * button carries the `id`, so a `<label htmlFor>` names it, and the menu's keyboard (arrows,
 * typeahead, Escape) is the composer's own.
 */
import type { ReactNode } from "react";
import { Menu, type MenuFilter, type MenuGroup, type MenuSpec } from "./Menu";

export interface SelectOption<T extends string = string> {
	value: T;
	label: string;
	/** What typeahead and the filter match, when the label is not enough. */
	textValue?: string;
	/** A line under the label in the menu. */
	description?: ReactNode;
	icon?: ReactNode;
	disabled?: boolean;
	/** Options with the same group are listed together under it, in order of first appearance. */
	group?: string;
}

export interface SelectProps<T extends string> {
	id?: string;
	value: T;
	options: readonly SelectOption<T>[];
	onChange(value: T): void;
	/** The menu's accessible name and, on a phone, the sheet's title. */
	menuLabel: string;
	/** Shown on the button when the value is none of the options. */
	placeholder?: string;
	/** The value follows a default: the button's text is dimmed. */
	inherited?: boolean;
	disabled?: boolean;
	"aria-describedby"?: string;
	"aria-label"?: string;
	/** A filter field over the options: its placeholder, for a long list; or a search the caller runs. */
	filter?: string | MenuFilter;
	/** Shown in the menu when there is no option (or none the filter leaves). */
	empty?: ReactNode;
	className?: string;
	/** A hook for tests and the composer's conventions (`data-picker`). */
	name?: string;
	/** The menu's width on a wide screen. */
	width?: number;
}

export function Select<T extends string>({
	id,
	value,
	options,
	onChange,
	menuLabel,
	placeholder,
	inherited = false,
	disabled = false,
	"aria-describedby": describedBy,
	"aria-label": ariaLabel,
	filter,
	empty,
	className,
	name,
	width,
}: SelectProps<T>) {
	const groups: MenuGroup[] = [];
	for (const option of options) {
		const key = option.group ?? "";
		let group = groups.find(one => one.id === `g:${key}`);
		if (!group) {
			group = { id: `g:${key}`, label: option.group, items: [] };
			groups.push(group);
		}
		group.items.push({
			id: `o:${option.value}`,
			value: option.value,
			label: option.label,
			textValue: option.textValue,
			description: option.description,
			icon: option.icon,
			disabled: option.disabled,
			checked: option.value === value,
			onSelect: () => {
				if (option.value !== value) onChange(option.value);
			},
		});
	}
	const spec: MenuSpec = {
		label: menuLabel,
		groups,
		hints: false,
		filter: typeof filter === "string" ? { placeholder: filter } : filter,
		empty,
		width,
	};
	const chosen = options.find(option => option.value === value);
	return (
		<Menu
			spec={spec}
			trigger={props => (
				<button
					type="button"
					{...props}
					id={id}
					className={`select${inherited ? " is-inherited" : ""}${chosen ? "" : " is-placeholder"}${className ? ` ${className}` : ""}`}
					data-picker={name}
					data-value={value}
					disabled={disabled}
					aria-describedby={describedBy}
					aria-label={ariaLabel}
				>
					{chosen?.icon}
					<span className="select-text">{chosen?.label ?? placeholder ?? ""}</span>
				</button>
			)}
		/>
	);
}
