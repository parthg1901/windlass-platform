/**
 * A repository's setup command, where its user sets it: a field of the start composer's repository picker, shown once a
 * repository of the GitHub connection is chosen, filled with what is saved for that repository and
 * saved with the launch; and a section of a session's side panel and of the repository's own page,
 * where it is read and changed (`SetupEditor`, the same in both).
 *
 * The command is the user's own, kept for the repository and not for one session: every agent they
 * launch on it runs it once, in each new workspace, before the agent starts there. A workspace that
 * exists is not set up again, so a change made in the panel is for the workspaces that come after.
 */
import { type EgressMode, type GithubId, MAX_SETUP_COMMAND_CHARS, type SessionSummary } from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { workspaceNetwork } from "../lib/machines";
import { spelledDuration } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";
import { Loading, Skeleton } from "./ui";

/** The command as the server keeps it: plain line ends, nothing around it. */
function clean(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

/** When and how it runs, in one sentence: the same wherever the command is shown. */
function howItRuns(
	when: string,
	limitMs: number | null,
	egress?: EgressMode,
	hosted = false,
	domains?: number,
): string {
	return `Runs once ${when}, before the agent starts, outside the agent's command sandbox${limitMs === null ? "" : `, for at most ${spelledDuration(limitMs)}`}. ${workspaceNetwork(egress, hosted, domains)}`;
}

interface Draft {
	/** The repository the rest is about. */
	repositoryId: GithubId | null;
	text: string;
	/** What is saved for it; null until that was read, and when it could not be. */
	saved: string | null;
	/** The user typed in the field: what is read later does not replace it. */
	touched: boolean;
	limitMs: number | null;
	error: string | null;
}

const NO_DRAFT: Draft = { repositoryId: null, text: "", saved: null, touched: false, limitMs: null, error: null };

export interface SetupDraft {
	draft: Draft;
	setText(text: string): void;
	/** What to save with the launch: the field's text when it differs from what is saved, and nothing otherwise. */
	toSave: string | undefined;
}

/** The start composer's setup command for the repository that is chosen: read when the choice changes. */
export function useSetupDraft(repositoryId: GithubId | null): SetupDraft {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [draft, setDraft] = useState<Draft>(NO_DRAFT);

	useEffect(() => {
		setDraft({ ...NO_DRAFT, repositoryId });
		if (repositoryId === null) return;
		let current = true;
		client
			.user(auth)
			.repositorySetup(repositoryId)
			.then(
				setup => {
					if (current)
						setDraft(now =>
							now.repositoryId !== repositoryId
								? now
								: {
										...now,
										saved: setup.command,
										limitMs: setup.timeoutMs,
										text: now.touched ? now.text : setup.command,
										error: null,
									},
						);
				},
				(failure: unknown) => {
					if (current) setDraft(now => (now.repositoryId !== repositoryId ? now : { ...now, error: explain(failure) }));
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);

	const setText = useCallback((text: string) => setDraft(now => ({ ...now, text, touched: true })), []);
	const text = clean(draft.text);
	// What could not be read is left as it is unless the user wrote something in its place.
	const toSave =
		draft.repositoryId !== null && (draft.saved !== null ? text !== draft.saved : draft.touched) ? text : undefined;
	return { draft, setText, toSave };
}

/** The start composer's field. `repository` is the chosen one, in words. */
export function SetupField({
	setup,
	repository,
	disabled,
	egress,
	hosted,
	domains,
}: {
	egress?: EgressMode;
	hosted?: boolean;
	domains?: number;
	setup: SetupDraft;
	repository: string;
	disabled: boolean;
}) {
	const ids = { input: useId(), note: useId() };
	const { draft } = setup;
	const reading = draft.saved === null && draft.error === null;
	return (
		<div className="field field-wide">
			<label className="label" htmlFor={ids.input}>
				Setup command <span className="label-optional">optional</span>
			</label>
			<textarea
				id={ids.input}
				className="input input-mono textarea setup-input"
				rows={2}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
				autoComplete="off"
				maxLength={MAX_SETUP_COMMAND_CHARS}
				placeholder={reading ? "" : "npm ci"}
				value={draft.text}
				onChange={event => setup.setText(event.target.value)}
				disabled={disabled}
				aria-busy={reading}
				aria-describedby={ids.note}
			/>
			<p className="field-note" id={ids.note}>
				{howItRuns("when the workspace is created", draft.limitMs, egress, hosted, domains)} Saved for {repository}, and
				run for every agent you launch on it.
			</p>
			{draft.error ? (
				<p className="field-note tone-warn" role="status">
					What is saved for {repository} could not be read: {draft.error} Left empty, this field changes nothing.
				</p>
			) : null}
		</div>
	);
}

/**
 * The command of one repository, read and changed in place: the field, its one control, and what it
 * does. `labelledBy` is the heading it stands under; `applies` says what a change means where it is
 * shown; `onSaved` hears of a save.
 */
export function SetupEditor({
	repositoryId,
	name,
	labelledBy,
	applies,
	onSaved,
	egress,
	hosted,
	domains,
	compact = false,
}: {
	compact?: boolean;
	egress?: EgressMode;
	hosted?: boolean;
	domains?: number;
	repositoryId: GithubId;
	name: string;
	labelledBy: string;
	applies: string;
	onSaved?(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const ids = { input: useId(), note: useId() };
	const [saved, setSaved] = useState<{ command: string; limitMs: number } | null>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** True after a save, until the field is changed again. */
	const [done, setDone] = useState(false);

	useEffect(() => {
		let current = true;
		setSaved(null);
		setError(null);
		client
			.user(auth)
			.repositorySetup(repositoryId)
			.then(
				setup => {
					if (!current) return;
					setSaved({ command: setup.command, limitMs: setup.timeoutMs });
					setText(setup.command);
				},
				(failure: unknown) => {
					if (current) setError(explain(failure));
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);

	const changed = saved !== null && clean(text) !== saved.command;

	const save = async () => {
		if (saving || !changed) return;
		setSaving(true);
		setError(null);
		try {
			const setup = await client.user(auth).saveRepositorySetup(repositoryId, clean(text));
			setSaved({ command: setup.command, limitMs: setup.timeoutMs });
			setText(setup.command);
			setDone(true);
			onSaved?.();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setSaving(false);
		}
	};

	return (
		<>
			{saved === null ? (
				error ? null : (
					<Loading label="Loading the setup command">
						<Skeleton width="100%" height={72} radius="var(--r-control)" />
					</Loading>
				)
			) : (
				<>
					<textarea
						id={ids.input}
						className="input input-mono textarea setup-input"
						rows={2}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
						autoComplete="off"
						maxLength={MAX_SETUP_COMMAND_CHARS}
						placeholder="none"
						value={text}
						onChange={event => {
							setText(event.target.value);
							setDone(false);
						}}
						disabled={saving}
						aria-labelledby={labelledBy}
						aria-describedby={ids.note}
					/>
					<p className="setup-actions">
						<button
							type="button"
							className="button button-outline button-small"
							onClick={save}
							disabled={!changed || saving}
						>
							{saving ? "Saving…" : "Save"}
						</button>
						{done && !changed ? (
							<span className="panel-empty" role="status">
								{saved.command === "" ? "Saved: no setup command." : "Saved."}
							</span>
						) : null}
					</p>
					{compact ? (
						<p className="panel-empty setup-note" id={ids.note}>
							Runs once before the agent starts (max {spelledDuration(saved.limitMs)}).{" "}
							<a className="link" href="/docs/settings#setup-command">
								Details
							</a>
						</p>
					) : (
						<p className="panel-empty setup-note" id={ids.note}>
							{howItRuns(`when a workspace is created for ${name}`, saved.limitMs, egress, hosted, domains)} {applies}
						</p>
					)}
				</>
			)}
			{error ? (
				<p className="panel-empty tone-bad setup-note" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : null}
		</>
	);
}

/** The side panel's section, for a session on a repository of the GitHub connection. */
export function SetupSection({
	summary,
	egress,
	hosted,
	domains,
}: {
	egress?: EgressMode;
	hosted?: boolean;
	domains?: number;
	summary: SessionSummary;
}) {
	const title = useId();
	const repository = summary.repository ?? null;
	if (!repository) return null;
	return (
		<section className="panel-section" aria-labelledby={title}>
			<h2 className="panel-title" id={title}>
				Setup command
			</h2>
			<SetupEditor
				egress={egress}
				domains={domains}
				hosted={hosted}
				repositoryId={repository.id}
				name={`${repository.owner}/${repository.name}`}
				labelledBy={title}
				applies={
					summary.sandbox === "none"
						? "This agent's workspace is created with its first prompt."
						: "A change applies to workspaces created after it: this agent's current one is not set up again."
				}
			/>
		</section>
	);
}
