/**
 * The interface's glyphs, drawn rather than typed, so they look the same whatever fonts the machine
 * has. All are 16 units square, stroke in the current colour, and hidden from assistive technology:
 * the text beside each one says what it means.
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
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
			{...rest}
		>
			{children}
		</svg>
	);
}

export const CheckIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 8.6l3.2 3.2L13 4.6" />
	</Svg>
);

export const CrossIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 4l8 8M12 4l-8 8" />
	</Svg>
);

export const RingIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="4.6" />
	</Svg>
);

export const DotIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
	</Svg>
);

/** Refused: a circle with a bar through it. */
export const RefusedIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.2" />
		<path d="M4.4 11.6l7.2-7.2" />
	</Svg>
);

export const StopIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" stroke="none" />
	</Svg>
);

/** Paused: two bars. A turn that waits, and resumes by itself. */
export const PauseIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6 4.2v7.6M10 4.2v7.6" />
	</Svg>
);

/** Resumed: a turn that goes on, an arrow into the work. */
export const ResumeIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M5.5 4.2l5.6 3.8-5.6 3.8z" />
	</Svg>
);

export const ChevronIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6 3.5L10.5 8 6 12.5" />
	</Svg>
);

export const ArrowDownIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v9.4M4 8.8L8 12.8l4-4" />
	</Svg>
);

export const ArrowLeftIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13 8H3.6M7.2 4L3.2 8l4 4" />
	</Svg>
);

export const PlusIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v10M3 8h10" />
	</Svg>
);

export const PencilIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M10.6 2.9l2.5 2.5-7.4 7.4-3 .5.5-3z" />
	</Svg>
);

export const TrashIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 8.5h6l.6-8.5" />
	</Svg>
);

export const SunIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="2.8" />
		<path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M3.5 12.5l1.1-1.1M11.4 4.6l1.1-1.1" />
	</Svg>
);

export const MoonIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13.2 9.4A5.6 5.6 0 016.6 2.8a5.6 5.6 0 106.6 6.6z" />
	</Svg>
);

export const ExternalIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M9 3h4v4M13 3L7.4 8.6M11 9.4V13H3V5h3.6" />
	</Svg>
);

export const WarnIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 2.4l6 10.6H2z" />
		<path d="M8 6.6v3M8 11.4v.2" />
	</Svg>
);

/** A question waits on the user: a mark of interrogation in a ring. */
export const AskIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.8" />
		<path d="M6.3 6.4a1.8 1.8 0 113 1.3c-.6.4-1.3.8-1.3 1.6M8 11.1v.1" />
	</Svg>
);

/** A steer: a line that bends into the work already under way. */
export const SteerIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 3.5v3.2a3 3 0 003 3h6.5M10 7l2.6 2.7L10 12.4" />
	</Svg>
);

export const InfoIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="5.6" />
		<path d="M8 7.4v3.4M8 5.2v.2" />
	</Svg>
);

/** Ran inside Windlass's own sandbox: a dot in a box, as the terminal interface marks it. */
export const SandboxedIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="3" y="3" width="10" height="10" rx="1.4" />
		<circle cx="8" cy="8" r="1.3" fill="currentColor" stroke="none" />
	</Svg>
);

/** Reasoning: three dots, "therefore". */
export const ThoughtIcon = (props: IconProps) => (
	<Svg {...props} stroke="none" fill="currentColor">
		<circle cx="8" cy="4.4" r="1.4" />
		<circle cx="4.4" cy="10.8" r="1.4" />
		<circle cx="11.6" cy="10.8" r="1.4" />
	</Svg>
);

export const FileIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 2.5h5l3 3v8H4z" />
		<path d="M9 2.5v3h3" />
	</Svg>
);

/** The API: a pair of braces. */
export const ApiIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M5.5 2.8c-1.4 0-2 .6-2 1.8v1.6c0 .9-.5 1.5-1.5 1.8 1 .3 1.5.9 1.5 1.8v1.6c0 1.2.6 1.8 2 1.8" />
		<path d="M10.5 2.8c1.4 0 2 .6 2 1.8v1.6c0 .9.5 1.5 1.5 1.8-1 .3-1.5.9-1.5 1.8v1.6c0 1.2-.6 1.8-2 1.8" />
	</Svg>
);

/** Copy: a sheet with another behind it. */
export const CopyIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="5.6" y="5.6" width="7.6" height="7.6" rx="1.4" />
		<path d="M10.4 5.6V4.2a1.4 1.4 0 00-1.4-1.4H4.2a1.4 1.4 0 00-1.4 1.4V9a1.4 1.4 0 001.4 1.4h1.4" />
	</Svg>
);

export const RefreshIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13 8a5 5 0 11-1.6-3.7" />
		<path d="M13.2 2.6v2.8h-2.8" />
	</Svg>
);

export const SearchIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="7" cy="7" r="4.2" />
		<path d="M10.2 10.2l3.2 3.2" />
	</Svg>
);

/** A private repository. */
export const LockIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="3.6" y="7.2" width="8.8" height="6" rx="1.2" />
		<path d="M5.6 7.2V5.4a2.4 2.4 0 014.8 0v1.8" />
	</Svg>
);

/** A branch: a line with another leaving it. */
export const BranchIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="4.6" cy="3.6" r="1.5" />
		<circle cx="4.6" cy="12.4" r="1.5" />
		<circle cx="11.4" cy="5" r="1.5" />
		<path d="M4.6 5.1v5.8M11.4 6.5c0 2.2-1.8 2.6-3.4 2.8-1.6.2-3.4.4-3.4 1.6" />
	</Svg>
);

/** A pull request: one line asking to join another. */
export const PullRequestIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="4.4" cy="3.8" r="1.5" />
		<circle cx="4.4" cy="12.2" r="1.5" />
		<circle cx="11.6" cy="12.2" r="1.5" />
		<path d="M4.4 5.3v5.4M11.6 10.7V6.6a2.2 2.2 0 00-2.2-2.2H8.2M9.7 2.9L8.1 4.4l1.6 1.5" />
	</Svg>
);

/** Merged: the line has joined. */
export const MergedIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="4.4" cy="3.8" r="1.5" />
		<circle cx="4.4" cy="12.2" r="1.5" />
		<circle cx="11.6" cy="8.6" r="1.5" />
		<path d="M4.4 5.3v5.4M4.4 5.3c0 2.4 2.2 3.3 5.7 3.3" />
	</Svg>
);

export const UserIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="5.6" r="2.6" />
		<path d="M3 13.4c.6-2.4 2.6-3.6 5-3.6s4.400 1.200 5 3.600" />
	</Svg>
);

/**
 * The mark: a windlass seen end on. A drum with three handspikes and the line it hauls, running off
 * its side and down to a link. With `turning` the drum turns, which is how the interface says an
 * agent is at work.
 */
export function Mark({
	size = 20,
	turning = false,
	className,
}: {
	size?: number;
	turning?: boolean;
	className?: string;
}) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 28 28"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			aria-hidden="true"
			focusable="false"
			className={`mark${turning ? " mark-turning" : ""}${className ? ` ${className}` : ""}`}
		>
			<g className="mark-drum">
				<circle cx="11.5" cy="11.5" r="7.5" />
				<path d="M11.5 4v4.2M5 15.25l3.64-2.1M18 15.25l-3.64-2.1" />
				<circle cx="11.5" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
			</g>
			<path d="M19 11.5V23" />
			<rect x="17" y="22" width="4" height="4" rx="1" fill="currentColor" stroke="none" />
		</svg>
	);
}

/** A small chevron pointing down: the end of a picker's trigger. */
export const ChevronDownIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4.5 6.5 8 10l3.5-3.5" />
	</Svg>
);

/** Pointing right: a row that opens a submenu. */
export const ChevronRightIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6.5 4.5 10 8l-3.5 3.5" />
	</Svg>
);

/** Pointing left: back, in a sheet. */
export const ChevronLeftIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M9.5 4.5 6 8l3.5 3.5" />
	</Svg>
);

/** One of the user's machines: a screen on a stand. */
export const MachineIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.4}>
		<rect x="2.5" y="3" width="11" height="7.5" rx="1.5" />
		<path d="M6 13h4M8 10.5V13" />
	</Svg>
);

/** Hosted: a sandbox the platform makes. */
export const CloudIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.4}>
		<path d="M4.6 12.5h6.9a2.9 2.9 0 0 0 .4-5.8 4 4 0 0 0-7.6-.9A3.4 3.4 0 0 0 4.6 12.5Z" />
	</Svg>
);

/** A repository: a book with its spine. */
export const RepoIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.4}>
		<path d="M4 12.5V3.8A1.3 1.3 0 0 1 5.3 2.5H12.5v8H5.2A1.2 1.2 0 0 0 4 11.7" />
		<path d="M4 12.5a1 1 0 0 0 1 1h2M9 13.5h3.5v-3" />
	</Svg>
);

/** The agent's mode: a shield with a tick. */
export const ShieldIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.4}>
		<path d="M8 2 13 4v3.6c0 3-2.2 5.2-5 6.4-2.8-1.2-5-3.4-5-6.4V4z" />
		<path d="m6 8 1.5 1.5L10.5 6.5" />
	</Svg>
);

/** Settings: three sliders. */
export const SlidersIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.4}>
		<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6" />
		<circle cx="10" cy="4.5" r="1.5" />
		<circle cx="6" cy="11.5" r="1.5" />
	</Svg>
);

/** Up: send. */
export const ArrowUpIcon = (props: IconProps) => (
	<Svg {...props} strokeWidth={1.8}>
		<path d="M8 13V3.5M4 7.5l4-4 4 4" />
	</Svg>
);
