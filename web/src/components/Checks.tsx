/**
 * A repository's checks, where its user sets them: a section of the repository's page, beside the
 * setup command (`ChecksEditor`).
 *
 * A check is a command that tells whether the code is right. Windlass runs the list before it calls
 * a turn done, in the agent's sandbox, and sends the agent back with what fails. They are the
 * user's own, kept for the repository and handed to every agent on it; nothing in the repository
 * sets them, and whether its own file can replace them depends on the Windlass in a sandbox. The
 * list is saved whole, by one control.
 */
import {
	type GithubId,
	MAX_CHECKS_PER_REPOSITORY,
	MAX_CHECK_NAME_CHARS,
	MAX_CHECK_TIMEOUT_SECONDS,
	MAX_SETUP_COMMAND_CHARS,
	type RepositoryCheck,
} from "@contract";
import { useEffect, useId, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { PlusIcon, TrashIcon, WarnIcon } from "./Icons";
import { Check } from "./ui/Check";
import { Loading, SkeletonLines } from "./ui";

/** A check as its row holds it: every field is text until it is saved. */
export interface CheckDraft {
	key: number;
	name: string;
	command: string;
	when: string;
	seconds: string;
	showOutput: boolean;
}

let nextKey = 1;

export function draftOf(check: RepositoryCheck): CheckDraft {
	return {
		key: nextKey++,
		name: check.name,
		command: check.command,
		when: (check.when ?? []).join(", "),
		seconds: check.timeoutSeconds === undefined ? "" : String(check.timeoutSeconds),
		showOutput: check.showOutput === true,
	};
}

/** The rows as the list that is sent: what a field says, with nothing around it. A row with neither a name nor a command is no check. */
export function checksOf(drafts: readonly CheckDraft[]): RepositoryCheck[] {
	return drafts
		.filter(draft => draft.name.trim() !== "" || draft.command.trim() !== "")
		.map(draft => {
			const when = draft.when
				.split(/[,\n]/)
				.map(pattern => pattern.trim())
				.filter(pattern => pattern !== "");
			const seconds = draft.seconds.trim();
			return {
				name: draft.name.trim(),
				command: draft.command.replace(/\r\n?/g, "\n").trim(),
				...(seconds === "" ? {} : { timeoutSeconds: Number(seconds) }),
				...(when.length === 0 ? {} : { when }),
				...(draft.showOutput ? { showOutput: true } : {}),
			};
		});
}

/** What it is and whose it is: the same wherever the list is shown. */
export const CHECKS_ABOUT = "Checks run before each turn ends. Failed checks go back to the agent up to three times.";

/**
 * The checks of one repository, read and changed in place. `labelledBy` is the heading it stands
 * under; `onSaved` hears of a save.
 */
export function ChecksEditor({
	repositoryId,
	name,
	labelledBy,
	onSaved,
}: {
	repositoryId: GithubId;
	name: string;
	labelledBy: string;
	onSaved?(): void;
}) {
	const { client, explain, platform } = useApp();
	// Said only where the deployment offers work items, as every other word of them is.
	const items = Boolean(platform.info?.items);
	const auth = useAuth();
	const note = useId();
	const [saved, setSaved] = useState<RepositoryCheck[] | null>(null);
	const [drafts, setDrafts] = useState<CheckDraft[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	/** True after a save, until a field is changed again. */
	const [done, setDone] = useState(false);

	useEffect(() => {
		let current = true;
		setSaved(null);
		setError(null);
		client
			.user(auth)
			.repositoryChecks(repositoryId)
			.then(
				found => {
					if (!current) return;
					setSaved(found.checks);
					setDrafts(found.checks.map(draftOf));
				},
				(failure: unknown) => {
					if (current) setError(explain(failure));
				},
			);
		return () => {
			current = false;
		};
	}, [client, auth, explain, repositoryId]);

	const list = checksOf(drafts);
	const changed = saved !== null && JSON.stringify(list) !== JSON.stringify(saved);
	const change = (key: number, fields: Partial<CheckDraft>) => {
		setDrafts(now => now.map(draft => (draft.key === key ? { ...draft, ...fields } : draft)));
		setDone(false);
	};

	const save = async () => {
		if (saving || !changed) return;
		setSaving(true);
		setError(null);
		try {
			const kept = await client.user(auth).saveRepositoryChecks(repositoryId, list);
			setSaved(kept.checks);
			setDrafts(kept.checks.map(draftOf));
			setDone(true);
			onSaved?.();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setSaving(false);
		}
	};

	if (saved === null) {
		return error ? (
			<p className="panel-empty tone-bad setup-note" role="alert">
				<WarnIcon size={13} /> {error}
			</p>
		) : (
			<Loading label="Loading the checks">
				<SkeletonLines title={false} />
			</Loading>
		);
	}

	return (
		<>
			{drafts.length === 0 ? (
				<p className="usage-empty">
					No checks saved for {name}.{items && " Work items use CI."}
				</p>
			) : null}
			<ul className="verify-list" aria-labelledby={labelledBy} aria-describedby={note}>
				{drafts.map((draft, index) => (
					<li key={draft.key} className="verify-check">
						<div className="verify-main">
							<input
								className="input input-mono verify-name"
								aria-label={`Name of check ${index + 1}`}
								placeholder="name"
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								maxLength={MAX_CHECK_NAME_CHARS}
								value={draft.name}
								onChange={event => change(draft.key, { name: event.target.value })}
								disabled={saving}
							/>
							<input
								className="input input-mono verify-command"
								aria-label={`Command of check ${draft.name.trim() || index + 1}`}
								placeholder="npm test"
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								autoComplete="off"
								maxLength={MAX_SETUP_COMMAND_CHARS}
								value={draft.command}
								onChange={event => change(draft.key, { command: event.target.value })}
								disabled={saving}
							/>
							<button
								type="button"
								className="icon-button icon-button-small icon-button-danger"
								aria-label={`Remove the check ${draft.name.trim() || index + 1}`}
								title="Remove"
								onClick={() => {
									setDrafts(now => now.filter(other => other.key !== draft.key));
									setDone(false);
								}}
								disabled={saving}
							>
								<TrashIcon size={13} />
							</button>
						</div>
						<div className="verify-options">
							<label className="verify-option verify-option-wide">
								<span>only when these change</span>
								<input
									className="input input-mono verify-small"
									placeholder="Any file, or globs: src/**, test/**"
									spellCheck={false}
									autoCapitalize="off"
									autoCorrect="off"
									autoComplete="off"
									value={draft.when}
									onChange={event => change(draft.key, { when: event.target.value })}
									disabled={saving}
								/>
							</label>
							<label className="verify-option">
								<span>seconds allowed</span>
								<input
									className="input input-mono verify-small verify-seconds"
									inputMode="numeric"
									placeholder="120"
									maxLength={String(MAX_CHECK_TIMEOUT_SECONDS).length}
									value={draft.seconds}
									onChange={event => change(draft.key, { seconds: event.target.value.replace(/[^0-9]/g, "") })}
									disabled={saving}
								/>
							</label>
							<Check
								className="verify-shows"
								checked={draft.showOutput}
								disabled={saving}
								onChange={on => change(draft.key, { showOutput: on })}
							>
								<span className="check-means">show its output in a pull request also when it passes</span>
							</Check>
						</div>
					</li>
				))}
			</ul>
			<p className="setup-actions">
				<button
					type="button"
					className="button button-outline button-small"
					onClick={() => {
						setDrafts(now => [
							...now,
							{ key: nextKey++, name: "", command: "", when: "", seconds: "", showOutput: false },
						]);
						setDone(false);
					}}
					disabled={saving || drafts.length >= MAX_CHECKS_PER_REPOSITORY}
				>
					<PlusIcon size={12} /> Add a check
				</button>
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
						{saved.length === 0 ? "Saved: no checks." : "Saved. Agents on it have them from their next turn."}
					</span>
				) : null}
			</p>
			{error ? (
				<p className="panel-empty tone-bad setup-note" role="alert">
					<WarnIcon size={13} /> {error}
				</p>
			) : null}
			<p className="panel-empty setup-note" id={note}>
				{CHECKS_ABOUT}
			</p>
		</>
	);
}
