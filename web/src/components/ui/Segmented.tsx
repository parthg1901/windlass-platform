/**
 * A choice of two to four, side by side in one field box: a radio group whose chosen segment is
 * raised. `fill` stretches it to its container with equal segments; `size="sm"` is the compact one
 * for a line of small controls. Styles in styles/ui.css.
 */
import { useId, type ReactNode } from "react";

export interface SegmentedOption<T> {
	value: T;
	label: ReactNode;
	/** The tooltip: what the choice means. */
	title?: string;
	disabled?: boolean;
}

export interface SegmentedProps<T> {
	value: T;
	options: readonly SegmentedOption<T>[];
	onChange(value: T): void;
	disabled?: boolean;
	fill?: boolean;
	size?: "sm";
	className?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	"aria-describedby"?: string;
}

export function Segmented<T extends string | number | boolean>({
	value,
	options,
	onChange,
	disabled = false,
	fill = false,
	size,
	className,
	...aria
}: SegmentedProps<T>) {
	const name = useId();
	return (
		<div
			className={`segmented${fill ? " segmented-fill" : ""}${size ? ` segmented-${size}` : ""}${className ? ` ${className}` : ""}`}
			role="radiogroup"
			{...aria}
		>
			{options.map(option => (
				<label
					key={String(option.value)}
					title={option.title}
					className={`segment${option.value === value ? " segment-chosen" : ""}`}
				>
					<input
						className="segment-radio"
						type="radio"
						name={name}
						value={String(option.value)}
						checked={option.value === value}
						disabled={disabled || option.disabled}
						onChange={() => onChange(option.value)}
					/>
					{option.label}
				</label>
			))}
		</div>
	);
}
