/** The pieces of a conversation: one component per kind of block the timeline reducer produces. */
import type { Verified } from "@contract";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { FOLD_WORDS, FoldToggle, LongText } from "./Fold";
import { SecretNotice } from "./SecretAsk";
import { createPortal } from "react-dom";
import { parseDiff } from "../lib/diff";
import { absoluteTime, count, duration, percent, plural, spelledDuration } from "../lib/format";
import { codeText, toolCopyLabels, toolInputText, toolOutputText } from "../lib/copy";
import { reasoningTitle, renderInlineMarkdown, renderMarkdown } from "../lib/markdown";
import { contextWords, costWords } from "../lib/acp";
import {
	asksAbout,
	shownBlocks,
	toolBlocks,
	ZERO_USAGE,
	type Block,
	type ChecksBlock,
	type NetworkBlock,
	type ErrorBlock,
	type NoteBlock,
	type NoticeBlock,
	type PlanBlock,
	type PlatformBlock,
	type ReasoningBlock,
	type SetupBlock,
	type SubagentRun,
	type TextBlock,
	type ToolBlock,
	type ToolState,
	type TurnView,
	type UserBlock,
} from "../lib/timeline";
import { formatInput, parseInput, summarizeTool } from "../lib/toolSummary";
import { summarizeWork, turnRows, type WorkBlock } from "../lib/workGroups";
import {
	checkLine,
	gateWord,
	overruledLine,
	ranEarlier,
	unneededLine,
	unresolvedLine,
	unrunLine,
} from "../lib/verified";
import { useNow } from "../state/hooks";
import { turnPayerLabel } from "../lib/cost";
import { linkProps } from "../lib/router";
import { CopyButton, useLatest } from "./Copy";
import { DiffHunks } from "./DiffView";
import {
	AskIcon,
	CheckIcon,
	ChevronIcon,
	CrossIcon,
	DotIcon,
	InfoIcon,
	Mark,
	PauseIcon,
	RefusedIcon,
	ResumeIcon,
	RingIcon,
	SandboxedIcon,
	SteerIcon,
	StopIcon,
	ThoughtIcon,
	WarnIcon,
} from "./Icons";
import { AnswerLine, AskedLine, InlineQuestion, useInteractive } from "./Question";
import { AllowHost, BlockedList, blockedHeadline } from "./BlockedNetwork";
import { OUTCOME_TONE, OUTCOME_WORD, OutcomeGlyph } from "./Status";

// ---------------------------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------------------------

export function Markdown({
	text,
	streaming = false,
	className = "",
	copyCode = false,
}: {
	text: string;
	streaming?: boolean;
	className?: string;
	copyCode?: boolean;
}) {
	const html = useMemo(() => renderMarkdown(text), [text]);
	const root = useRef<HTMLDivElement>(null);
	// The HTML is sanitised by DOMPurify in renderMarkdown.
	return (
		<>
			<div
				ref={root}
				className={`prose${streaming ? " prose-streaming" : ""}${className ? ` ${className}` : ""}`}
				dangerouslySetInnerHTML={{ __html: html }}
			/>
			{/* Not while the text streams in: the HTML is replaced with every chunk, and the last block may be half written. */}
			{copyCode && !streaming ? <CodeCopies root={root} html={html} /> : null}
		</>
	);
}

/** A sentence with inline Markdown only (`renderInlineMarkdown`), in a span: for a server's sentence shown inside other text. */
export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
	const html = useMemo(() => renderInlineMarkdown(text), [text]);
	// The HTML is sanitised by DOMPurify in renderInlineMarkdown.
	return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

/**
 * A copy control beside each code block of rendered Markdown. The blocks are HTML, not React, so each
 * `pre` is wrapped in a box once the HTML is in place, and the control is portalled into a slot at the
 * start of that box. A sibling of the prose rather than part of it, so that only this re-renders when
 * the boxes are found, never the text.
 */
function CodeCopies({ root, html }: { root: RefObject<HTMLDivElement | null>; html: string }) {
	const [slots, setSlots] = useState<HTMLElement[]>([]);
	useLayoutEffect(() => {
		const prose = root.current;
		if (!prose) return;
		const found = Array.from(prose.querySelectorAll("pre"), pre => {
			let box = pre.parentElement;
			if (!box?.classList.contains("code-block")) {
				box = document.createElement("div");
				box.className = "code-block";
				pre.replaceWith(box);
				box.append(pre);
			}
			let slot = box.querySelector<HTMLElement>(":scope > .code-copy");
			if (!slot) {
				slot = document.createElement("span");
				slot.className = "code-copy";
				box.prepend(slot);
			}
			return slot;
		});
		setSlots(found);
	}, [root, html]);
	return slots.map((slot, index) =>
		createPortal(
			<CopyButton
				text={() => {
					const pre = slot.parentElement?.querySelector("pre");
					return pre ? codeText(pre) : "";
				}}
				label={slots.length > 1 ? `Copy code block ${index + 1} of ${slots.length}` : "Copy this code block"}
			/>,
			slot,
			String(index),
		),
	);
}

/**
 * What the user sent: their side of the exchange, so it sits apart from the agent's work, on the
 * right, in a box of the composer's material (it is what was typed there). Its facts and its copy
 * control hang under it, on the same right edge. A steer is the user's too, and stays lighter than
 * the prompt that started the turn: smaller, in the dim ink, and dashed, as the composer is while a
 * turn runs.
 */
/**
 * Set by the conversation of an item's session, to the role of its agent: every prompt there is the
 * platform's own (the factory's brief, a fix it asks for, the reviewer's brief, its word after an
 * interruption), never a person's; a reviewer's first arrives with no text of its own. Each stands as one
 * quiet line, the start of its text under it, clamped, with "Show all".
 */
export const PlatformPrompts = createContext<"builder" | "reviewer" | null>(null);

/**
 * A prompt's model as the rest of the page names it (lib/acp.ts, `sessionModelWords`): another agent's by the
 * name it gave the model ("6.2 Sol"), Windlass's by its id. Set by the conversation; the id as it is without it.
 */
export const ModelLabel = createContext<(id: string) => string>(id => id);

/** The line a prompt of the platform's stands as, by the role of the agent it is to. `first`: the one that starts its timeline. */
export const platformPromptLabel = (first: boolean, role: "builder" | "reviewer" = "reviewer") =>
	role === "builder"
		? first
			? "The factory's brief"
			: "The factory's word to the agent"
		: first
			? "The platform's brief for this review"
			: "The platform's word to the reviewer";

function PlatformPrompt({ block, first, role }: { block: UserBlock; first: boolean; role: "builder" | "reviewer" }) {
	const text = block.text.trim();
	return (
		<div className="user user-platform">
			<p className="user-platform-line">{platformPromptLabel(first, role)}</p>
			{text ? (
				<LongText lines={2} className="user-text user-platform-text">
					{text}
				</LongText>
			) : null}
			{block.at !== null ? (
				<p className="user-meta">
					<time dateTime={new Date(block.at).toISOString()}>{absoluteTime(block.at)}</time>
				</p>
			) : null}
		</div>
	);
}

function UserPrompt({ block, first = false }: { block: UserBlock; first?: boolean }) {
	const role = useContext(PlatformPrompts);
	if (role) return <PlatformPrompt block={block} first={first} role={role} />;
	return <PersonPrompt block={block} />;
}

function PersonPrompt({ block }: { block: UserBlock }) {
	const steer = block.steer;
	const held = block.held === true;
	const modelLabel = useContext(ModelLabel);
	return (
		<div className={`user${steer ? " user-steer" : ""}`}>
			<p className="user-text">
				<span className="visually-hidden">
					{held ? "You, while the turn was paused: " : steer ? "You, while it worked: " : "You: "}
				</span>
				{block.text}
			</p>
			<div className="user-foot">
				<p className="user-meta">
					<span className="user-who" aria-hidden="true">
						You
					</span>
					{held ? (
						<span
							className="user-held-word"
							title="Sent while the turn was paused: the agent reads it when the turn resumes."
						>
							<PauseIcon size={12} />
							held
						</span>
					) : steer ? (
						<span className="user-steer-word">
							<SteerIcon size={12} />
							steer
						</span>
					) : (
						<>
							<span title={modelLabel(block.model) === block.model ? undefined : block.model}>
								{modelLabel(block.model)}
							</span>
							<span>{block.effort ? `effort ${block.effort}` : "default effort"}</span>
						</>
					)}
					{block.at !== null ? <time dateTime={new Date(block.at).toISOString()}>{absoluteTime(block.at)}</time> : null}
				</p>
				<CopyButton text={block.text} label={steer ? "Copy this message" : "Copy this prompt"} />
			</div>
		</div>
	);
}

function AssistantText({ block }: { block: TextBlock }) {
	// Read when pressed: while the answer streams, the control copies what has arrived without re-rendering with it.
	const text = useLatest(block.text);
	return (
		<div className="answer">
			<Markdown text={block.text} streaming={block.streaming} copyCode />
			<CopyButton text={text} label="Copy this answer as Markdown" />
		</div>
	);
}

function Reasoning({ block }: { block: ReasoningBlock }) {
	const [open, setOpen] = useState(false);
	const title = reasoningTitle(block.text);
	return (
		<div className={`reasoning${block.streaming ? " reasoning-streaming" : ""}`}>
			<button type="button" className="line-button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
				<span className="line-glyph tone-dim">
					<ThoughtIcon size={13} />
				</span>
				<span className="reasoning-word">{block.streaming ? "thinking" : "thought"}</span>
				{title ? <span className="reasoning-title">{title}</span> : null}
				<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
			</button>
			{open ? <Markdown text={block.text} streaming={block.streaming} className="reasoning-body" /> : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------------------------

const TOOL_STATE_WORD: Record<ToolState, string> = {
	input: "writing the call",
	queued: "queued",
	asking: "waiting for you",
	running: "running",
	done: "done",
	failed: "failed",
	refused: "refused",
};

function ToolGlyph({ block }: { block: ToolBlock }) {
	switch (block.state) {
		case "input":
			return <span className="dots" aria-hidden="true" />;
		case "queued":
			return <RingIcon size={14} className="tone-faint" />;
		case "asking":
			return <AskIcon size={14} className="tone-needs" />;
		case "running":
			return block.stopRequested ? (
				<StopIcon size={14} className="tone-warn pulse" />
			) : (
				<Mark size={15} turning className="tone-accent" />
			);
		case "done":
			return <CheckIcon size={14} className="tone-accent settle" />;
		case "refused":
			return <RefusedIcon size={14} className="tone-warn settle" />;
		case "failed":
			return block.interrupted ? (
				<StopIcon size={14} className="tone-warn settle" />
			) : (
				<CrossIcon size={14} className="tone-bad settle" />
			);
	}
}

const OUTPUT_LINES = 24;

/** Monospace output, capped: the first lines of a finished output, or the last lines of one still arriving. */
export function Output({
	text,
	tail = false,
	limit = OUTPUT_LINES,
	label,
}: {
	text: string;
	tail?: boolean;
	limit?: number;
	label: string;
}) {
	const [all, setAll] = useState(false);
	const id = useId();
	const lines = useMemo(() => text.replace(/\n$/, "").split("\n"), [text]);
	const hidden = Math.max(0, lines.length - limit);
	const shown = all || hidden === 0 ? lines : tail ? lines.slice(-limit) : lines.slice(0, limit);
	return (
		<div className="output">
			{tail && hidden > 0 && !all ? (
				<p className="output-more output-more-top">{plural(hidden, "earlier line")} above</p>
			) : null}
			<pre id={id} className="output-text" tabIndex={0} aria-label={label}>
				{shown.join("\n")}
			</pre>
			{hidden > 0 ? (
				<FoldToggle
					open={all}
					controls={id}
					label={FOLD_WORDS.more(hidden, hidden === 1 ? "more line" : "more lines")}
					onToggle={() => setAll(value => !value)}
				/>
			) : null}
		</div>
	);
}

function ToolBody({ block }: { block: ToolBlock }) {
	const input = formatInput(block);
	const diff = typeof block.display?.diff === "string" ? parseDiff(block.display.diff) : [];
	const output = block.output ?? block.progress;
	// Read when pressed, so that a running call's output is copied as far as it has come.
	const latest = useLatest(block);
	const copyInput = useCallback(() => toolInputText(latest()), [latest]);
	const copyOutput = useCallback(() => toolOutputText(latest()), [latest]);
	const labels = toolCopyLabels(block);
	return (
		<div className="tool-body">
			<section className="tool-part" aria-label="Input">
				<div className="tool-part-head">
					<h4 className="tool-part-title">input</h4>
					{input.trim() !== "" ? <CopyButton text={copyInput} label={labels.input} /> : null}
				</div>
				{input.trim() === "" ? (
					<p className="tool-part-empty">no arguments</p>
				) : (
					<Output text={input} label={`Input of ${block.name}`} limit={16} />
				)}
			</section>
			<section className="tool-part" aria-label="Output">
				<div className="tool-part-head">
					<h4 className="tool-part-title">
						{block.output === null ? (block.state === "running" ? "output so far" : "output") : "output"}
						{block.truncated ? (
							<span className="tool-part-note">
								capped by Windlass: {count(block.truncated.originalLines)} lines in total
							</span>
						) : null}
					</h4>
					{diff.length > 0 || (output !== null && output !== "") ? (
						<CopyButton text={copyOutput} label={labels.output} />
					) : null}
				</div>
				{diff.length > 0 ? (
					<div className="tool-diff">
						{diff.map(file => (
							<DiffHunks key={file.path} file={file} />
						))}
					</div>
				) : output === null || output === "" ? (
					<p className="tool-part-empty">
						{block.state === "running"
							? "nothing yet"
							: block.state === "input" || block.state === "queued" || block.state === "asking"
								? "not run yet"
								: "no output"}
					</p>
				) : (
					<Output text={output} tail={block.output === null} label={`Output of ${block.name}`} />
				)}
			</section>
		</div>
	);
}

/** How many lines of a failed or running call are shown without opening it. */
const PREVIEW_LINES = 5;

/** "Stop this call": an icon button beside a running call's row. */
function StopCallButton({
	block,
	stop,
}: {
	block: ToolBlock;
	stop: (block: ToolBlock) => Promise<{ stopped: boolean; message: string | null }>;
}) {
	const [asking, setAsking] = useState(false);
	const [refusal, setRefusal] = useState<string | null>(null);
	const target = summarizeTool(block).target;

	useEffect(() => {
		if (refusal === null) return;
		const timer = setTimeout(() => setRefusal(null), 6000);
		return () => clearTimeout(timer);
	}, [refusal]);

	const onClick = async () => {
		setAsking(true);
		setRefusal(null);
		try {
			const result = await stop(block);
			if (!result.stopped) setRefusal(result.message ?? "This call could not be asked to stop.");
		} catch (failure) {
			setRefusal(failure instanceof Error ? failure.message : "This call could not be asked to stop.");
		} finally {
			setAsking(false);
		}
	};

	return (
		<>
			<button
				type="button"
				className="icon-button icon-button-small tool-stop"
				onClick={onClick}
				disabled={asking || block.stopRequested}
				aria-label={`Stop this call: ${block.name}${target ? ` ${target}` : ""}`}
				title="Stop this call"
			>
				<StopIcon size={12} />
				<span className="tool-stop-label" aria-hidden="true">
					Stop this call
				</span>
			</button>
			{refusal ? (
				<p className="tool-stop-refused" role="status">
					{refusal}
				</p>
			) : null}
		</>
	);
}

function toolStateWord(block: ToolBlock, exitCode: number | null): string | null {
	switch (block.state) {
		case "done":
			return null;
		case "failed":
			if (block.stoppedByUser) return "stopped by you";
			if (block.interrupted) return "stopped";
			return exitCode !== null ? null : "failed";
		case "refused":
			if (block.answer && !block.answer.approve)
				return block.answer.by === "platform" ? "declined, no answer" : "declined";
			return TOOL_STATE_WORD.refused;
		case "running":
			return block.stopRequested ? "stopping" : TOOL_STATE_WORD.running;
		default:
			return TOOL_STATE_WORD[block.state];
	}
}

/**
 * A tool call's row. `nested`: a call of a subagent's, under the row of the call that started it.
 * Its question is answered at the end of the turn (`Turn`), and the user stops the subagent, not one
 * call of its.
 */
const ToolRow = memo(function ToolRow({ block: given, nested = false }: { block: ToolBlock; nested?: boolean }) {
	const [open, setOpen] = useState(false);
	const interactive = useInteractive();
	const question = nested ? null : (interactive?.flow.question ?? null);
	const asked = question !== null && asksAbout(given, question) ? question : null;
	// An ACP harness asks about a call it has not started: the call is drawn as the one it asks about.
	const block = asked && given.state !== "asking" ? { ...given, state: "asking" as const } : given;
	const running = block.state === "running";
	const now = useNow(1000, running);
	const summary = summarizeTool(block);
	const elapsed = running && block.startedAt !== null ? Math.max(0, now - block.startedAt) : null;
	const stopCall = !nested && running && !block.stopRequested ? (interactive?.stopCall ?? null) : null;

	const stateWord = toolStateWord(block, summary.exitCode);
	// Under the row, without opening it: output as it arrives, and the end of what a failed call printed.
	const preview = open ? null : running ? block.progress : block.state === "failed" ? block.output : null;
	const previewLines = preview
		? preview
				.split("\n")
				.filter(line => line.trim() !== "")
				.slice(-PREVIEW_LINES)
		: [];

	return (
		<div
			className={`tool tool-${block.state}${block.interrupted ? " tool-interrupted" : ""}${stopCall ? " tool-stoppable" : ""}`}
		>
			<div className="tool-head">
				<button
					type="button"
					className="line-button tool-row"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
				>
					<span className="line-glyph">
						<ToolGlyph block={block} />
					</span>
					<span className="tool-name">{block.name || "tool"}</span>
					<span className="tool-target">{summary.target}</span>
					{block.sandboxed === true ? (
						<span className="tool-sandboxed" title="Ran inside Windlass's own sandbox">
							<SandboxedIcon size={12} />
							<span className="visually-hidden">sandboxed</span>
						</span>
					) : null}
					<span className="tool-facts">
						{summary.facts
							// A call the user stopped ends with a signal's exit code, which says nothing they do not know.
							.filter(fact => !(block.stoppedByUser && fact.startsWith("exit ")))
							.map(fact => (
								<span
									key={fact}
									className={fact.startsWith("exit ") && summary.exitCode !== 0 ? "tone-bad" : undefined}
								>
									{fact}
								</span>
							))}
						{stateWord ? <span className={`tool-state tool-state-${block.state}`}>{stateWord}</span> : null}
						{elapsed !== null ? (
							<span>{duration(Math.max(1000, Math.floor(elapsed / 1000) * 1000))}</span>
						) : block.durationMs !== null ? (
							<span>{duration(block.durationMs)}</span>
						) : null}
					</span>
					<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
				</button>
				{stopCall ? <StopCallButton block={block} stop={stopCall} /> : null}
			</div>
			{block.refusal ? <p className="tool-refusal">{block.refusal.text}</p> : null}
			{asked && interactive ? (
				<InlineQuestion question={asked} flow={interactive.flow} underItsCall />
			) : block.state === "asking" ? (
				<AskedLine block={block} />
			) : (
				<AnswerLine block={block} />
			)}
			{previewLines.length > 0 ? (
				<pre className="tool-preview" aria-hidden={running ? undefined : true}>
					{previewLines.join("\n")}
				</pre>
			) : null}
			{open ? <ToolBody block={block} /> : null}
		</div>
	);
});

// ---------------------------------------------------------------------------------------------
// A harness's plan
// ---------------------------------------------------------------------------------------------

const PLAN_WORD: Record<PlanBlock["entries"][number]["status"], string> = {
	pending: "to do",
	in_progress: "in progress",
	completed: "done",
};

/** The plan a harness keeps for its turn: its steps as a short checklist, which each update of the plan redraws in place. */
function Plan({ block }: { block: PlanBlock }) {
	const done = block.entries.filter(entry => entry.status === "completed").length;
	const all = block.entries.length > 0 && done === block.entries.length;
	return (
		<div className="plan">
			<p className="plan-head">
				<span className="line-glyph">
					{all ? <CheckIcon size={14} className="tone-accent" /> : <RingIcon size={14} className="tone-faint" />}
				</span>
				<span className="plan-word">plan</span>
				<span className="plan-count">
					{done} of {block.entries.length} done
				</span>
			</p>
			<ol className="plan-steps">
				{block.entries.map((entry, index) => (
					<li key={index} className={`plan-step plan-step-${entry.status}`}>
						<span className="line-glyph">
							{entry.status === "completed" ? (
								<CheckIcon size={12} className="tone-accent" />
							) : entry.status === "in_progress" ? (
								<DotIcon size={12} className="tone-accent" />
							) : (
								<RingIcon size={12} className="tone-faint" />
							)}
						</span>
						<span className="plan-text">{entry.content}</span>
						<span className="visually-hidden">, {PLAN_WORD[entry.status]}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------------------------

/** The subagent's own state, in the words and classes of a call's. */
function subagentLook(
	block: ToolBlock,
	run: SubagentRun,
): { look: "running" | "done" | "failed"; halted: boolean; word: string | null; asking?: boolean } {
	switch (run.state) {
		case "running":
			// One of its calls waits on a question of the user's, which is put at the end of the turn.
			if (run.work.turns[0]?.blocks.some(child => child.kind === "tool" && child.state === "asking"))
				return { look: "running", halted: false, word: TOOL_STATE_WORD.asking, asking: true };
			return { look: "running", halted: false, word: block.stopRequested ? "stopping" : TOOL_STATE_WORD.running };
		case "completed":
			return { look: "done", halted: false, word: null };
		case "failed":
			return { look: "failed", halted: false, word: "failed" };
		case "stopped":
			return { look: "failed", halted: true, word: block.stoppedByUser ? "stopped by you" : "stopped" };
		case "lost":
			return { look: "failed", halted: true, word: "lost" };
		case "cut_off":
			return { look: "failed", halted: true, word: "cut off" };
	}
}

/** What is said under a subagent that did not finish: Windlass's own sentence, unless the row's word says it already. */
function subagentSaid(block: ToolBlock, run: SubagentRun): string | null {
	if (run.state === "running" || run.state === "completed") return null;
	if (run.state === "cut_off") return "The turn ended before Windlass said how the subagent did.";
	if (run.state === "stopped" && block.stoppedByUser) return null;
	return run.detail;
}

const EMPTY_TURN: TurnView = {
	turn: 1,
	blocks: [],
	steps: 0,
	stepOpen: false,
	interruptRequested: false,
	changedFiles: null,
	usage: ZERO_USAGE,
	end: null,
	platformAnswer: null,
};

/**
 * A call of the `subagent` tool once its subagent started: a row like any call's, whose state is the
 * subagent's (a background one runs on after its call returned), and in it the task, what the
 * subagent did, with the rows the session's own work has, and its answer.
 */
const SubagentRow = memo(function SubagentRow({ block, run }: { block: ToolBlock; run: SubagentRun }) {
	const [open, setOpen] = useState(false);
	const interactive = useInteractive();
	const running = run.state === "running";
	const now = useNow(1000, running);
	const elapsed = running && run.startedAt !== null ? Math.max(0, now - run.startedAt) : null;
	const work = run.work.turns[0] ?? EMPTY_TURN;
	const calls = toolBlocks(work);
	const { look, halted, word: stateWord, asking } = subagentLook(block, run);
	const said = subagentSaid(block, run);
	// Windlass's sentence under a failed or stopped one starts with how it ended ("It failed: …"): the row does not say it too.
	const word = said !== null && (run.state === "failed" || run.state === "stopped") ? null : stateWord;
	// A background subagent's call has returned already: only a call that waits for its subagent can be stopped.
	const stopCall = block.state === "running" && !block.stopRequested ? (interactive?.stopCall ?? null) : null;
	// Under the row, without opening it: what it is doing now.
	const latest = open || !running ? undefined : calls.at(-1);
	const target = summarizeTool(block).target;
	return (
		<div className={`tool tool-${look}${halted ? " tool-interrupted" : ""}${stopCall ? " tool-stoppable" : ""}`}>
			<div className="tool-head">
				<button
					type="button"
					className="line-button tool-row"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
				>
					<span className="line-glyph">
						{running ? (
							<Mark size={15} turning className="tone-accent" />
						) : look === "done" ? (
							<CheckIcon size={14} className="tone-accent settle" />
						) : halted ? (
							<StopIcon size={14} className="tone-warn settle" />
						) : (
							<CrossIcon size={14} className="tone-bad settle" />
						)}
					</span>
					<span className="tool-name">subagent</span>
					<span className="tool-target">{target}</span>
					<span className="tool-facts">
						{run.background ? <span>background</span> : null}
						{calls.length > 0 ? <span>{plural(calls.length, "tool call")}</span> : null}
						{word ? <span className={`tool-state tool-state-${asking ? "asking" : look}`}>{word}</span> : null}
						{elapsed !== null ? (
							<span>{duration(Math.max(1000, Math.floor(elapsed / 1000) * 1000))}</span>
						) : run.durationMs !== null ? (
							<span>{duration(run.durationMs)}</span>
						) : null}
					</span>
					<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
				</button>
				{stopCall ? <StopCallButton block={block} stop={stopCall} /> : null}
			</div>
			{said ? <p className="tool-refusal">{said}</p> : null}
			{latest ? (
				<pre className="tool-preview">
					{latest.name} {summarizeTool(latest).target}
				</pre>
			) : null}
			{open ? <SubagentBody block={block} run={run} work={work} /> : null}
		</div>
	);
});

function SubagentBody({ block, run, work }: { block: ToolBlock; run: SubagentRun; work: TurnView }) {
	const input = parseInput(block.inputText);
	const task = typeof input?.task === "string" ? input.task.trim() : formatInput(block);
	// Its last words are its answer once it finished; what came before is what it did.
	const answer =
		run.state === "completed"
			? (work.blocks.findLast((candidate): candidate is TextBlock => candidate.kind === "text") ?? null)
			: null;
	const did = work.blocks.filter(candidate => candidate !== answer);
	return (
		<div className="tool-body">
			<section className="tool-part" aria-label="Task">
				<div className="tool-part-head">
					<h4 className="tool-part-title">task</h4>
					<CopyButton text={task} label="Copy the subagent's task" />
				</div>
				<Output text={task} label="Task of the subagent" limit={16} />
			</section>
			<section className="tool-part" aria-label="What it did">
				<h4 className="tool-part-title">what it did</h4>
				{did.length === 0 ? (
					<p className="tool-part-empty">{run.state === "running" ? "nothing yet" : "nothing recorded"}</p>
				) : (
					did.map(child => (
						<div key={child.id} className={blockClass(child)}>
							{renderBlock(child, true)}
						</div>
					))
				)}
			</section>
			{answer ? (
				<section className="tool-part" aria-label="Answer">
					<div className="tool-part-head">
						<h4 className="tool-part-title">answer</h4>
						<CopyButton text={answer.text} label="Copy the subagent's answer" />
					</div>
					<Markdown text={answer.text} copyCode />
				</section>
			) : null}
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The repository's setup command
// ---------------------------------------------------------------------------------------------

/** What the platform kept of a run's output, with the line ends a terminal would have drawn made plain. */
function setupOutput(block: SetupBlock): string {
	return block.output.replace(/\r\n?/g, "\n");
}

/** What is said under a run that did not succeed: what became of it, and that the turn goes on. */
function setupSaid(block: SetupBlock): string | null {
	switch (block.state) {
		case "failed":
			return "The setup command failed. The turn goes on, and the agent is told.";
		case "timed_out":
			return `The setup command was stopped after ${spelledDuration(block.limitMs)}, the time it may take. The turn goes on, and the agent is told.`;
		case "stopped":
			return "Stopped with the turn. It is not run again in this sandbox, and the agent is told with the next prompt.";
		case "cut_off":
			return "The server stopped while it ran. It is not run again in this sandbox, and the agent is told with the next prompt.";
		default:
			return null;
	}
}

/**
 * A run of the repository's setup command: a row like a tool call's, since it is a command and its
 * output, named for what it is. The platform ran it, before the agent started in the sandbox.
 */
const SetupRow = memo(function SetupRow({ block }: { block: SetupBlock }) {
	const [open, setOpen] = useState(false);
	const running = block.state === "running";
	const now = useNow(1000, running);
	const elapsed = running && block.at !== null ? Math.max(0, now - block.at) : null;
	const output = setupOutput(block);
	const latest = useLatest(block);
	const copyOutput = useCallback(() => setupOutput(latest()), [latest]);
	const ended = block.state === "succeeded" ? "done" : running ? "running" : "failed";
	const halted = block.state === "timed_out" || block.state === "stopped" || block.state === "cut_off";
	const word = running
		? "running"
		: block.state === "failed"
			? block.exitCode === null
				? "failed"
				: null
			: block.state === "timed_out"
				? "time limit"
				: block.state === "stopped"
					? "stopped"
					: block.state === "cut_off"
						? "cut off"
						: null;
	const said = setupSaid(block);
	// Under the row, without opening it: output as it arrives, and the end of what a run that did not succeed printed.
	const preview =
		open || block.state === "succeeded"
			? []
			: output
					.split("\n")
					.filter(line => line.trim() !== "")
					.slice(-PREVIEW_LINES);
	return (
		<div className={`tool tool-${ended}${halted ? " tool-interrupted" : ""}`}>
			<button
				type="button"
				className="line-button tool-row"
				aria-expanded={open}
				onClick={() => setOpen(value => !value)}
			>
				<span className="line-glyph">
					{running ? (
						<Mark size={15} turning className="tone-accent" />
					) : block.state === "succeeded" ? (
						<CheckIcon size={14} className="tone-accent settle" />
					) : halted ? (
						<StopIcon size={14} className="tone-warn settle" />
					) : (
						<CrossIcon size={14} className="tone-bad settle" />
					)}
				</span>
				<span className="tool-name">setup</span>
				<span className="tool-target">{block.command.split("\n", 1)[0]}</span>
				<span className="tool-facts">
					{block.state === "failed" && block.exitCode !== null ? (
						<span className="tone-bad">exit {block.exitCode}</span>
					) : null}
					{word ? <span className={`tool-state tool-state-${ended}`}>{word}</span> : null}
					{elapsed !== null ? (
						<span>{duration(Math.max(1000, Math.floor(elapsed / 1000) * 1000))}</span>
					) : block.durationMs !== null ? (
						<span>{duration(block.durationMs)}</span>
					) : null}
				</span>
				<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
			</button>
			{said ? <p className="tool-refusal">{said}</p> : null}
			{preview.length > 0 ? (
				<pre className="tool-preview" aria-hidden={running ? undefined : true}>
					{preview.join("\n")}
				</pre>
			) : null}
			{open ? (
				<div className="tool-body">
					<section className="tool-part" aria-label="Command">
						<div className="tool-part-head">
							<h4 className="tool-part-title">setup command, run before the agent started</h4>
							<CopyButton text={block.command} label="Copy the setup command" />
						</div>
						<Output text={block.command} label="The setup command" limit={16} />
					</section>
					<section className="tool-part" aria-label="Output">
						<div className="tool-part-head">
							<h4 className="tool-part-title">
								{running ? "output so far" : "output"}
								{block.truncated ? <span className="tool-part-note">only the end of it is kept</span> : null}
							</h4>
							{output !== "" ? <CopyButton text={copyOutput} label="Copy the setup command's output" /> : null}
						</div>
						{output === "" ? (
							<p className="tool-part-empty">{running ? "nothing yet" : "no output"}</p>
						) : (
							<Output text={output} tail label="Output of the setup command" />
						)}
					</section>
				</div>
			) : null}
		</div>
	);
});

// ---------------------------------------------------------------------------------------------
// Checks, notices, errors, system lines
// ---------------------------------------------------------------------------------------------

function Checks({ block }: { block: ChecksBlock }) {
	const [open, setOpen] = useState(false);
	// A check whose command could not be run at all has no exit code: it did not fail, it was not started.
	const unstarted = block.results
		.filter(result => result.status === "could_not_start" && result.exitCode === null)
		.map(result => result.name);
	const failing = block.results
		.filter(result => result.status !== "passed" && !unstarted.includes(result.name))
		.map(result => result.name);
	const words =
		block.state === "running"
			? "running"
			: block.state === "passed"
				? `${plural(block.results.length, "check")} passed`
				: block.state === "failed"
					? [
							...(failing.length > 0 ? [`${failing.join(", ")} failed`] : []),
							...(unstarted.length > 0 ? [`${unstarted.join(", ")} not started`] : []),
						].join(", ")
					: (block.message ?? "did not finish");
	const expandable = block.results.length > 0 || block.report !== null;
	// A run in which nothing failed and a check was not started is marked as a warning, like one that did not finish: nothing in it speaks against the code.
	const failed = block.state === "failed" && failing.length > 0;
	const row = (
		<>
			<span className="line-glyph">
				{block.state === "running" ? (
					<Mark size={15} turning className="tone-accent" />
				) : block.state === "passed" ? (
					<CheckIcon size={14} className="tone-accent settle" />
				) : failed ? (
					<CrossIcon size={14} className="tone-bad settle" />
				) : (
					<WarnIcon size={14} className="tone-warn settle" />
				)}
			</span>
			<span className="tool-name">checks</span>
			<span className="tool-target">{block.names.join(", ")}</span>
			<span className="tool-facts">
				<span
					className={
						failed ? "tone-bad" : block.state === "passed" || block.state === "running" ? undefined : "tone-warn"
					}
				>
					{words}
				</span>
				<span>run {block.run}</span>
			</span>
		</>
	);
	return (
		<div className={`tool tool-checks tool-checks-${block.state}`}>
			{expandable ? (
				<button
					type="button"
					className="line-button tool-row"
					aria-expanded={open}
					onClick={() => setOpen(value => !value)}
				>
					{row}
					<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
				</button>
			) : (
				<div className="line-button tool-row tool-row-static">{row}</div>
			)}
			{open ? (
				<div className="tool-body">
					{block.results.length > 0 ? (
						<section className="tool-part" aria-label="Results">
							<h4 className="tool-part-title">the project's checks</h4>
							<ul className="check-list">
								{block.results.map(result => (
									<li key={result.name}>
										{result.status === "passed" ? (
											<CheckIcon size={13} className="tone-accent" />
										) : (
											<CrossIcon size={13} className="tone-bad" />
										)}
										<span className="check-name">{result.name}</span>
										<code>{result.command}</code>
										<span className={result.status === "passed" ? "tone-dim" : "tone-bad"}>
											{result.status.replace(/_/g, " ")}
											{result.exitCode !== null && result.exitCode !== 0 ? `, exit ${result.exitCode}` : ""}
										</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
					{block.report !== null ? (
						<section className="tool-part" aria-label="What the model was told">
							<h4 className="tool-part-title">what Windlass told the model</h4>
							<Output text={block.report} label="Check report" />
						</section>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function Callout({
	tone,
	title,
	children,
	detail,
}: {
	tone: "warn" | "bad" | "info";
	title: string;
	children: ReactNode;
	detail?: string | null;
}) {
	return (
		<div className={`callout callout-${tone} callout-block`} role={tone === "bad" ? "alert" : "note"}>
			{tone === "info" ? <InfoIcon /> : <WarnIcon />}
			<div>
				<p className="callout-title">{title}</p>
				{children}
				{detail ? <p className="callout-detail">{detail}</p> : null}
			</div>
		</div>
	);
}

/** Windlass's one sentence that untrusted content is now in the conversation: said once, quietly. */
function TaintLine({ block }: { block: NoticeBlock }) {
	return (
		<p className="taint" role="note">
			<InfoIcon size={13} />
			<span>{block.text}</span>
		</p>
	);
}

function Notice({ block }: { block: NoticeBlock }) {
	if (block.noticeKind === "taint") return <TaintLine block={block} />;
	const [open, setOpen] = useState(false);
	const id = useId();
	const [first = "", ...rest] = block.text.split("\n");
	const more = rest.join("\n").trim();
	return (
		<Callout tone={block.noticeKind === "no_closing_answer" ? "info" : "warn"} title={block.title}>
			<p className="callout-text">{first}</p>
			{more !== "" ? (
				<>
					<pre className="callout-more" id={id} hidden={!open}>
						{more}
					</pre>
					<FoldToggle open={open} controls={id} label={FOLD_WORDS.all} onToggle={() => setOpen(value => !value)} />
				</>
			) : null}
		</Callout>
	);
}

function ErrorLine({ block }: { block: ErrorBlock }) {
	return (
		<Callout tone="bad" title={block.title}>
			<p className="callout-text">{block.message}</p>
			{block.detail ? <Output text={block.detail} limit={12} label="The error's details" /> : null}
		</Callout>
	);
}

/** A line of the platform's with the addresses in it as links: a pull request's, after a push. */
function withLinks(text: string): ReactNode {
	const parts = text.split(/(https?:\/\/[^\s"<>]+[^\s"<>.,;:!?)])/);
	if (parts.length === 1) return text;
	return parts.map((part, index) =>
		index % 2 === 1 ? (
			<a key={index} href={part} target="_blank" rel="noreferrer">
				{part}
			</a>
		) : (
			part
		),
	);
}

function SystemLine({ block }: { block: PlatformBlock | NoteBlock }) {
	const tone =
		block.kind === "platform"
			? block.level === "error"
				? "bad"
				: block.level === "warn"
					? "warn"
					: "dim"
			: block.tone;
	// The turn paused, or resumed after a pause: a line of its own kind, so the gap in the turn reads as one.
	if (block.kind === "platform" && block.resume) {
		return (
			<p className={`system system-resume system-${block.resume}`}>
				<span className="system-rule" aria-hidden="true" />
				<span className="system-resume-mark" aria-hidden="true">
					{block.resume === "paused" ? <PauseIcon size={12} /> : <ResumeIcon size={12} />}
				</span>
				<span className="system-source">{block.resume}</span>
				<span className="system-text">{block.text}</span>
			</p>
		);
	}
	// A request for a secret: a line of its own, the platform's text of it said by the line and the card above the field.
	if (block.kind === "platform" && block.secret) return <SecretRequested secret={block.secret} />;
	const line = (
		<p className={`system tone-${tone}`}>
			<span className="system-rule" aria-hidden="true" />
			<span className="system-source">{block.kind === "platform" ? "platform" : "windlass"}</span>
			<span className="system-text">{block.kind === "platform" ? withLinks(block.text) : block.text}</span>
		</p>
	);
	if (block.kind !== "platform" || !block.blocked) return line;
	return (
		<>
			{line}
			<BlockedHost host={block.blocked.host} repository={block.blocked.repository} />
		</>
	);
}

/**
 * The agent's `request_secret`, as one line. While it is open, the card above the field holds its reason, the platform's
 * notice and the field, so the line only names it and points there; an item's builder points to the item's page. Once
 * answered, a record ("NAME saved", "Continued without NAME"), with the reason quoted as the agent's own words, in plain
 * text, and the notice folded behind "Show the request". The value is never asked for here.
 */
function SecretRequested({ secret }: { secret: NonNullable<PlatformBlock["secret"]> }) {
	const interactive = useInteractive();
	const open = interactive?.secretRequestId === secret.id;
	const itemId = interactive?.itemId ?? null;
	// A person's own session with no repository saves it for the account: every agent of theirs would have it.
	const account = interactive !== null && !itemId && interactive.repositoryId === null;
	const [shown, setShown] = useState(false);
	const id = useId();
	const name = <code className="secret-ask-name">{secret.name}</code>;
	const words =
		secret.answer === "saved" ? (
			<>{name} saved</>
		) : secret.answer === "without" ? (
			<>Continued without {name}</>
		) : (
			<>Asked for a secret: {name}</>
		);
	const where = open ? (
		"answer it below"
	) : secret.answer === undefined && itemId ? (
		<a className="link" {...linkProps({ name: "item", id: itemId })}>
			answer on the item's page
		</a>
	) : null;
	return (
		<section
			className={`system-secret${open ? " system-secret-open" : ""}`}
			aria-label={`The agent's request for the secret ${secret.name}`}
		>
			<p className="system tone-dim">
				<span className="system-rule" aria-hidden="true" />
				<span className="system-source">platform</span>
				<span className="system-text">
					{secret.answer === "saved" ? <CheckIcon size={11} className="system-secret-mark tone-good" /> : null}
					{words}
					{where ? <> · {where}</> : null}
				</span>
				{open ? null : (
					<FoldToggle
						open={shown}
						controls={id}
						label="Show the request"
						onToggle={() => setShown(now => !now)}
						className="system-secret-toggle"
					/>
				)}
			</p>
			{open ? null : (
				<div className="system-secret-body" id={id} hidden={!shown}>
					<figure className="item-asked secret-ask-why">
						<figcaption className="item-asked-who">Its reason, in the agent's own words.</figcaption>
						<LongText lines={3} as="blockquote" className="item-asked-text">
							{secret.why}
						</LongText>
					</figure>
					{secret.notice ? <SecretNotice notice={secret.notice} account={account} /> : null}
				</div>
			)}
		</section>
	);
}

/**
 * Under a line about a host a command could not reach (an older server's, or a turn whose
 * `network.blocked` row does not list it): "Allow for this repository" and the way to the list.
 */
function BlockedHost({ host, repository }: { host: string; repository: boolean }) {
	const interactive = useInteractive();
	const repositoryId = interactive?.repositoryId ?? null;
	if (!repository || repositoryId === null) return null;
	return (
		<p className="system-actions">
			<AllowHost host={host} context={{ allow: interactive?.allowHost ?? null, repositoryId }} listLink />
		</p>
	);
}

/** "16:15", the time of day a destination was last refused. */
const lastSeen = (at: number) =>
	`last ${new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;

/**
 * A turn's blocked network requests (`network.blocked`): one quiet line that counts them, then each
 * destination with what can be done about it, folded after three. Live while the turn runs: a newer
 * revision replaces it in place. Its id is what the side panel links to.
 */
const NetworkRow = memo(function NetworkRow({ block }: { block: NetworkBlock }) {
	const interactive = useInteractive();
	const repositoryId = interactive?.repositoryId ?? null;
	const context = interactive ? { allow: interactive.allowHost ?? null, repositoryId } : null;
	return (
		<section className="blocked" id={`network-${block.seq}`} aria-label="Blocked network requests">
			<p className="system tone-dim">
				<span className="system-rule" aria-hidden="true" />
				<span className="system-source">network</span>
				<span className="system-text">Blocked network requests: {blockedHeadline(block)}</span>
			</p>
			<BlockedList
				hosts={block.hosts}
				overflow={block.overflow}
				context={context}
				when={lastSeen}
				label="Blocked destinations"
			/>
		</section>
	);
});

// ---------------------------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------------------------

/**
 * Under a turn's closing line: what its work rests on, as the platform recorded it from Windlass's
 * checks. Which state the files are back on where no check was needed for that, a run that did not
 * pass before the agent changed them back, each check of the last run with how it ended and whose it
 * is, the user's checks that did not run and why, whom the repository's own settings held for, and
 * whether files changed after. The same facts a pull request's description is given. Nothing is
 * drawn for a turn that had no checks and none before it.
 */
function VerifiedLines({ verified }: { verified: Verified }) {
	const checks = verified.run?.checks ?? [];
	const earlier = ranEarlier(verified);
	const unneeded = unneededLine(verified);
	const unresolved = unresolvedLine(verified);
	const unrun = unrunLine(verified);
	const overruled = overruledLine(verified);
	return (
		<>
			{unneeded ? (
				<p className="turn-end-line turn-end-sub">
					<span>{unneeded}</span>
				</p>
			) : null}
			{verified.putBack ? (
				<p className="turn-end-line turn-end-sub">
					<span>did not pass earlier in this turn, before the agent changed the files back</span>
					{verified.putBack.map(check => (
						<span key={check.name}>
							<code>{check.name}</code> {checkLine(check)}
						</span>
					))}
				</p>
			) : null}
			{checks.length > 0 ? (
				<p className="turn-end-line turn-end-sub">
					<span>checks{earlier ? `, ${earlier}` : ""}</span>
					{checks.map(check => (
						<span
							key={check.name}
							className={
								check.status === "passed" ? undefined : check.startError !== undefined ? "tone-warn" : "tone-bad"
							}
						>
							<code>{check.name}</code> {checkLine(check)}
						</span>
					))}
				</p>
			) : null}
			{unresolved ? (
				<p className="turn-end-line turn-end-sub">
					<span>{unresolved}</span>
				</p>
			) : null}
			{unrun ? (
				<p className="turn-end-line turn-end-sub">
					<span>did not run</span>
					<span>{unrun}</span>
				</p>
			) : null}
			{overruled ? (
				<p className="turn-end-line turn-end-sub">
					<span>{overruled}</span>
				</p>
			) : null}
			{verified.changedAfter ? (
				<p className="turn-end-line turn-end-sub tone-warn">
					<span>files changed after the checks last ran</span>
				</p>
			) : null}
		</>
	);
}

function TurnSummary({ turn }: { turn: TurnView }) {
	const [tokensOpen, setTokensOpen] = useState(false);
	const foldId = useId();
	const end = turn.end;
	if (!end) return null;
	const tone = OUTCOME_TONE[end.outcome];
	const gate = end.verified && gateWord(end.verified);
	const steps = end.steps ?? (turn.steps > 0 ? turn.steps : null);
	const usage = end.usage;
	const share =
		end.cachedShare ?? (usage && usage.inputTokens > 0 ? usage.cachedInputTokens / usage.inputTokens : null);
	const files = turn.changedFiles;
	// The token counts are folded behind a toggle at the end of the outcome line: the side panel has them too.
	const tokenLine = usage ? (
		<p className="turn-end-line turn-end-sub" id={foldId}>
			<span>{count(usage.inputTokens)} in</span>
			<span>
				{count(usage.cachedInputTokens)} cached ({percent(share)})
			</span>
			<span>{count(usage.outputTokens)} out</span>
		</p>
	) : null;
	const tokenSummary = usage
		? `${count(usage.inputTokens)} in · ${count(usage.cachedInputTokens)} cached (${percent(share)}) · ${count(usage.outputTokens)} out`
		: undefined;
	return (
		<div className={`turn-end turn-end-${tone}`}>
			<p className="turn-end-line">
				<span className="line-glyph">
					<OutcomeGlyph outcome={end.outcome} />
				</span>
				<strong className={`tone-${tone}`}>{OUTCOME_WORD[end.outcome]}</strong>
				{gate ? <span>{gate}</span> : null}
				{steps !== null ? <span>{plural(steps, "step")}</span> : null}
				<span>{duration(end.durationMs)}</span>
				<span>turn {turn.turn}</span>
				{end.exitCode !== null && end.exitCode !== 0 ? <span>exit {end.exitCode}</span> : null}
				{tokenLine ? (
					<span>
						<button
							type="button"
							className="turn-end-fold"
							aria-expanded={tokensOpen}
							aria-controls={tokensOpen ? foldId : undefined}
							title={tokenSummary}
							onClick={() => setTokensOpen(open => !open)}
						>
							tokens
							<ChevronIcon size={10} className={`turn-end-fold-chevron${tokensOpen ? " turn-end-fold-open" : ""}`} />
						</button>
					</span>
				) : null}
			</p>
			{end.message ? <p className="turn-end-message">{end.message}</p> : null}
			{end.verified && <VerifiedLines verified={end.verified} />}
			{files && files.length > 0 ? (
				<p className="turn-end-line turn-end-sub">
					<span>
						changed {plural(files.length, "file")}:{" "}
						{files.slice(0, 4).map((file, index) => (
							<span key={file}>
								{index > 0 ? ", " : ""}
								<code>{file}</code>
							</span>
						))}
						{files.length > 4 ? ` and ${files.length - 4} more` : ""}
					</span>
				</p>
			) : null}
			{tokenLine && tokensOpen ? tokenLine : null}
			{/* An agent that reports its context (`end.context`, ACP) says how full it is, beside the tokens its turn answered with. */}
			{end.context ? (
				<p className="turn-end-line turn-end-sub">
					<span>context {contextWords(end.context)}</span>
					{end.context.cost ? <span>{costWords(end.context.cost)}</span> : null}
					{turnPayerLabel(end.modelKey) ? <span>{turnPayerLabel(end.modelKey)}</span> : null}
				</p>
			) : tokenLine || end.context === null ? null : end.outcome !== "error" ? (
				<p className="turn-end-line turn-end-sub">
					<span>no token counts were reported</span>
				</p>
			) : null}
		</div>
	);
}

/** A block's wrapper classes, by its kind. */
function blockClass(block: Block): string {
	return `block block-${block.kind}${block.kind === "user" && block.steer ? " block-steer" : ""}${block.kind === "notice" && block.noticeKind === "taint" ? " block-taint" : ""}`;
}

/** `nested`: a block of a subagent's, inside the row of the call that started it. `first`: the timeline's first block. */
function renderBlock(block: Block, nested = false, first = false): ReactNode {
	switch (block.kind) {
		case "user":
			return <UserPrompt block={block} first={first} />;
		case "text":
			return <AssistantText block={block} />;
		case "reasoning":
			return <Reasoning block={block} />;
		case "tool":
			return block.subagent ? (
				<SubagentRow block={block} run={block.subagent} />
			) : (
				<ToolRow block={block} nested={nested} />
			);
		case "checks":
			return <Checks block={block} />;
		case "setup":
			return <SetupRow block={block} />;
		case "plan":
			return <Plan block={block} />;
		case "notice":
			return <Notice block={block} />;
		case "error":
			return <ErrorLine block={block} />;
		case "platform":
		case "note":
			return <SystemLine block={block} />;
		case "network":
			return <NetworkRow block={block} />;
	}
}

// ---------------------------------------------------------------------------------------------
// A row of work: calls folded into one line (lib/workGroups.ts)
// ---------------------------------------------------------------------------------------------

/**
 * The calls the agent made between two things it said, as one line that says what they did, folded.
 * Opened, each call is its own row, with its glyph, as a subagent's calls are.
 */
const WorkRow = memo(function WorkRow({ blocks }: { blocks: WorkBlock[] }) {
	const [open, setOpen] = useState(false);
	const body = useId();
	const summary = summarizeWork(blocks);
	return (
		<div className={`work${open ? " work-open" : ""}${summary.failed > 0 ? " work-failed" : ""}`}>
			<button
				type="button"
				className="line-button work-row"
				aria-expanded={open}
				aria-controls={body}
				onClick={() => setOpen(value => !value)}
			>
				<span className="line-glyph">
					{summary.failed > 0 ? (
						<CrossIcon size={13} className="tone-bad" />
					) : (
						<CheckIcon size={13} className="tone-dim" />
					)}
				</span>
				<span className="work-text">{summary.text}</span>
				<span className="tool-facts work-facts">
					{summary.failed > 0 ? <span className="tone-bad">{summary.failed} failed</span> : null}
					{summary.durationMs !== null ? <span>{duration(summary.durationMs)}</span> : null}
				</span>
				<ChevronIcon size={12} className={`line-chevron${open ? " line-chevron-open" : ""}`} />
			</button>
			{open ? (
				<div className="work-body" id={body}>
					{blocks.map(block => (
						<div key={block.id} className={blockClass(block)}>
							{renderBlock(block)}
						</div>
					))}
				</div>
			) : null}
		</div>
	);
});

/** One turn: the prompt, what happened, and how it ended. Re-renders only when the turn changed. */
export const Turn = memo(function Turn({ turn }: { turn: TurnView }) {
	const interactive = useInteractive();
	const question = interactive?.flow.question ?? null;
	// A question about a call this timeline does not show (a subagent's own call) goes at the end of its turn.
	const loose =
		question !== null &&
		question.turn === turn.turn &&
		!turn.blocks.some(block => block.kind === "tool" && asksAbout(block, question))
			? question
			: null;
	const rows = useMemo(
		() => turnRows(shownBlocks(turn.blocks), question ? block => asksAbout(block, question) : null),
		[turn.blocks, question],
	);
	return (
		<section className="turn" aria-label={`Turn ${turn.turn}`}>
			{rows.map(row =>
				row.kind === "work" ? (
					<div key={row.id} className="block block-work">
						<WorkRow blocks={row.blocks} />
					</div>
				) : (
					<div key={row.block.id} className={blockClass(row.block)}>
						{renderBlock(row.block, false, turn.turn === 1 && row.index === 0)}
					</div>
				),
			)}
			{loose && interactive ? (
				<InlineQuestion question={loose} flow={interactive.flow} className="block block-question" />
			) : null}
			<TurnSummary turn={turn} />
		</section>
	);
});
