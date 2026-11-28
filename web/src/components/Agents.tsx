/**
 * A list of agents as the home screen and a repository's page show it: one row per agent, with rename
 * and delete, and a long list folded so that the page stays readable. What a fold hides is said in
 * numbers, and an agent that is at work or waits on its user is never among it.
 */
import { MAX_TITLE_CHARS, type PullRequestInfo, type SessionSummary, type TurnOutcome } from "@contract";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { acpHarnessName, sessionModelWords } from "../lib/acp";
import { absoluteTime, clockDuration, plural, relativeTime } from "../lib/format";
import { foldGroup } from "../lib/repositories";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { Dialog } from "./Dialog";
import { FOLD_WORDS, FoldToggle } from "./Fold";
import { MergedIcon, PencilIcon, PullRequestIcon, RingIcon, TrashIcon, WarnIcon } from "./Icons";
import { OUTCOME_TONE, OUTCOME_WORD, OutcomeGlyph, STATUS_WORD, StatusGlyph } from "./Status";
import { AgentGlyph } from "./ui/Pill";

function repoName(url: string): string {
	return url.replace(/^https:\/\//, "").replace(/\.git$/, "");
}

/** `grouped`: the row stands under its repository's name, so it says the branch and not the repository again. */
function AgentRow({
	session,
	profileName,
	now,
	grouped,
	onDelete,
}: {
	session: SessionSummary;
	profileName: string;
	now: number;
	grouped: boolean;
	onDelete(session: SessionSummary): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(session.title);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const input = useRef<HTMLInputElement>(null);
	const renameButton = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (renaming) input.current?.select();
	}, [renaming]);

	const closeRename = () => {
		setRenaming(false);
		setError(null);
		requestAnimationFrame(() => renameButton.current?.focus());
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!title.trim() || title === session.title) return closeRename();
		setSaving(true);
		try {
			await client.user(auth).renameSession(session.id, title);
			closeRename();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setSaving(false);
		}
	};

	const active = session.status !== "idle";
	const waiting = session.status === "waiting";
	const working = active && !waiting;
	const pull = session.pullRequest ?? null;
	// Finished with: its pull request was merged or closed. The row steps back a shade.
	const settled = !active && (pull?.state === "merged" || pull?.state === "closed");
	return (
		<li
			className={`agent-row agent-row-session${working ? " agent-row-active" : ""}${settled ? " agent-row-settled" : ""}`}
			data-status={session.status}
		>
			<span className="agent-glyph">
				<RowGlyph session={session} />
			</span>
			<div className="agent-main">
				{renaming ? (
					<form className="agent-rename" onSubmit={save}>
						<label className="visually-hidden" htmlFor={`rename-${session.id}`}>
							New title for {session.title}
						</label>
						<input
							ref={input}
							id={`rename-${session.id}`}
							className="input input-md"
							value={title}
							maxLength={MAX_TITLE_CHARS}
							onChange={event => setTitle(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Escape") {
									event.preventDefault();
									setTitle(session.title);
									closeRename();
								}
							}}
							disabled={saving}
						/>
						<button
							type="submit"
							className="button button-primary button-small"
							disabled={saving || title.trim() === ""}
						>
							{saving ? "Saving…" : "Save"}
						</button>
						<button
							type="button"
							className="button button-quiet button-small"
							onClick={() => {
								setTitle(session.title);
								closeRename();
							}}
							disabled={saving}
						>
							Cancel
						</button>
						{error ? (
							<p className="field-note tone-bad" role="alert">
								{error}
							</p>
						) : null}
					</form>
				) : (
					<a className="agent-title" {...linkProps({ name: "session", id: session.id })}>
						{session.title}
						{waiting ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
					</a>
				)}
				<p className="agent-meta">
					<span className="agent-harness" title={profileName}>
						<AgentGlyph harness={session.harness ?? "windlass"} size={11} inline />
						{acpHarnessName(session) ?? "Windlass"}
						<span className="agent-model"> · {sessionModelWords(session)}</span>
					</span>
					<span>{session.place.kind === "machine" ? "your machine" : "hosted"}</span>
					{grouped && session.repository ? (
						<span className="agent-repo">{session.repository.branch}</span>
					) : session.repoUrl ? (
						<span className="agent-repo">{repoName(session.repoUrl)}</span>
					) : null}
					<span>{session.turns === 0 ? "no turns" : plural(session.turns, "turn")}</span>
				</p>
			</div>
			<div className="agent-state">
				{waiting ? (
					<span className="agent-chip agent-chip-needs">needs you</span>
				) : active ? (
					<span className={`agent-chip agent-chip-live agent-chip-${session.status}`}>
						{STATUS_WORD[session.status]}
					</span>
				) : null}
				{pull ? <PullChip pull={pull} /> : null}
				{session.continuedFrom ? (
					<span className="agent-chip agent-chip-quiet" title={`Continued from ${session.continuedFrom.title}`}>
						continued
						<span className="visually-hidden"> from {session.continuedFrom.title}</span>
					</span>
				) : null}
				{/* A turn that ended well says so with its glyph; any other ending says it in words. */}
				{active || session.lastOutcome === "succeeded" ? null : <OutcomeChip outcome={session.lastOutcome} />}
				{session.sandbox === "running" && !active ? (
					<span className="agent-chip agent-chip-sandbox" title="Its sandbox is running">
						<span className="agent-chip-dot" aria-hidden="true" />
						sandbox
						<span className="visually-hidden"> running</span>
					</span>
				) : null}
			</div>
			<RowTime session={session} now={now} working={working} />
			<div className="agent-actions">
				<button
					ref={renameButton}
					type="button"
					className="icon-button"
					aria-label={`Rename ${session.title}`}
					title="Rename"
					onClick={() => {
						setTitle(session.title);
						setRenaming(true);
					}}
				>
					<PencilIcon />
				</button>
				<button
					type="button"
					className="icon-button icon-button-danger"
					aria-label={`Delete ${session.title}`}
					title="Delete"
					onClick={() => onDelete(session)}
				>
					<TrashIcon />
				</button>
			</div>
			{/* The line paying out under an agent at work: it runs while the drum turns. */}
			{working ? <span className="agent-line" aria-hidden="true" /> : null}
		</li>
	);
}

/** The row's glyph: the drum turning while it works, the amber ask while it waits, how its last turn ended otherwise. */
function RowGlyph({ session }: { session: SessionSummary }) {
	if (session.status !== "idle") return <StatusGlyph status={session.status} size={16} />;
	const outcome = session.lastOutcome;
	if (outcome === null) return <RingIcon size={16} className="status-glyph status-idle" />;
	if (outcome === "succeeded")
		return <DoneGlyph open={session.pullRequest?.state === "open" || session.pullRequest?.state === "draft"} />;
	return <OutcomeGlyph outcome={outcome} size={15} />;
}

/** A turn that ended well: a check in a ring, in the good hue while its pull request is open, quiet once that is settled. */
function DoneGlyph({ open }: { open: boolean }) {
	return (
		<svg
			width={17}
			height={17}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			className={open ? "agent-done agent-done-open" : "agent-done"}
		>
			<circle cx="8" cy="8" r="6.2" />
			<path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
		</svg>
	);
}

const PULL_WORD: Record<PullRequestInfo["state"], string> = {
	open: "open",
	draft: "draft",
	merged: "merged",
	closed: "closed",
};

function PullChip({ pull }: { pull: PullRequestInfo }) {
	return (
		<span className={`agent-chip agent-chip-pull agent-chip-pull-${pull.state}`} title={pull.title}>
			{pull.state === "merged" ? <MergedIcon size={12} /> : <PullRequestIcon size={12} />}#{pull.number}{" "}
			{PULL_WORD[pull.state]}
		</span>
	);
}

function OutcomeChip({ outcome }: { outcome: TurnOutcome | null }) {
	if (outcome === null) return <span className="agent-chip agent-chip-quiet">no turns yet</span>;
	const tone = OUTCOME_TONE[outcome];
	return (
		<span className={`agent-chip agent-chip-${tone}`}>
			<OutcomeGlyph outcome={outcome} size={11} />
			{OUTCOME_WORD[outcome]}
		</span>
	);
}

/** When it was last used; for an agent at work, how long its turn has run, ticking. */
function RowTime({ session, now, working }: { session: SessionSummary; now: number; working: boolean }) {
	const tick = useNow(1000, working);
	const iso = new Date(session.updatedAt).toISOString();
	if (working) {
		const start = session.turnStartedAt ?? session.updatedAt;
		const clock = clockDuration(Math.max(1000, tick - start));
		return (
			<time
				className="agent-time agent-time-live"
				dateTime={new Date(start).toISOString()}
				title={`Working since ${absoluteTime(start)}`}
			>
				<span className="visually-hidden">working for </span>
				{clock}
			</time>
		);
	}
	return (
		<time className="agent-time" dateTime={iso} title={absoluteTime(session.updatedAt)}>
			{relativeTime(session.updatedAt, now)}
		</time>
	);
}

function DeleteDialog({ session, onClose }: { session: SessionSummary; onClose(): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).deleteSession(session.id);
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Delete this agent?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={remove} disabled={busy}>
						{busy ? "Deleting…" : "Delete agent"}
					</button>
				</>
			}
		>
			<p>
				<strong>{session.title}</strong> will be removed with its conversation and its sandbox, including every file in
				the workspace. This cannot be undone.
			</p>
			{session.status !== "idle" ? (
				<p className="tone-warn">It is working right now; deleting it stops the turn.</p>
			) : null}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</Dialog>
	);
}

/** The lists a user unfolded, by `foldKey`: they stay unfolded while the page is open, also across a visit to an agent. */
const unfolded = new Set<string>();

export function AgentList({
	sessions,
	limit,
	foldKey,
	label,
	grouped,
	now,
}: {
	/** In the order they are shown. */
	sessions: SessionSummary[];
	/** How many are shown while the list is folded (lib/repositories.ts, `foldGroup`). */
	limit: number;
	foldKey: string;
	label: string;
	grouped: boolean;
	now: number;
}) {
	const { platform } = useApp();
	const [open, setOpen] = useState(() => unfolded.has(foldKey));
	const [deleting, setDeleting] = useState<SessionSummary | null>(null);
	const listId = useId();
	const folded = foldGroup(sessions, limit);
	const shown = open ? sessions : folded.shown;
	const profileName = (id: string) => platform.info?.profiles.find(profile => profile.id === id)?.name ?? id;
	const toggle = () => {
		if (open) unfolded.delete(foldKey);
		else unfolded.add(foldKey);
		setOpen(!open);
	};

	return (
		<>
			<ul className="agents" aria-label={label} id={listId}>
				{shown.map(session => (
					<AgentRow
						key={session.id}
						session={session}
						profileName={profileName(session.profile)}
						now={now}
						grouped={grouped}
						onDelete={setDeleting}
					/>
				))}
			</ul>
			{folded.hidden > 0 ? (
				<p className="agents-fold">
					<FoldToggle
						open={open}
						controls={listId}
						label={FOLD_WORDS.more(folded.hidden, folded.hidden === 1 ? "more agent" : "more agents")}
						onToggle={toggle}
					/>
					{open ? null : <span>used before the ones above; none of them is working</span>}
				</p>
			) : null}
			{deleting ? <DeleteDialog session={deleting} onClose={() => setDeleting(null)} /> : null}
		</>
	);
}
