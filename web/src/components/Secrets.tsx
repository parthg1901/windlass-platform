/**
 * A repository's secrets, where their user manages them: a section of a session's side panel and of
 * the repository's own page, beside the setup command (`SecretsBlock`, the same in both), and a field
 * of the start composer's repository picker once a repository of the GitHub connection is chosen. All open the same dialog, in which a secret is added, its value replaced, its scope
 * changed, or it is deleted.
 *
 * A secret is a named value the platform hands to the repository's agents as an environment
 * variable. Its value goes to the server when it is saved and is never sent back: the list has
 * names, scopes and dates, and the value's field is empty whenever it is shown. What a secret reaches
 * depends on the sandbox profile and the secret's scope. Each list carries the server's explanation.
 *
 * The account's secrets are managed with the same list and the same dialog, on the account's settings
 * page. They are for MCP servers, the user's own and a project's that reads
 * one, and have a repository's two scopes without the setup command: MCP servers only, or the
 * agent's commands as well. Where a repository has a secret of the same name, its agents are handed
 * the repository's; both lists say so.
 */
import {
	type GithubId,
	MAX_ACCOUNT_SECRETS,
	MAX_SECRET_NAME_CHARS,
	MAX_SECRET_VALUE_BYTES,
	MAX_SECRETS_PER_REPOSITORY,
	MIN_SECRET_VALUE_CHARS,
	type SandboxProfileId,
	type SecretReach,
	type SecretScope,
	type SessionSummary,
} from "@contract";
import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { UserApi } from "../api/client";
import { absoluteTime, count, day } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { WarnIcon } from "./Icons";
import { LoadError, Loading, SkeletonLines } from "./ui";

/** A secret as either list has it: the account's has the repositories that stand in for it. */
interface ListedSecret {
	name: string;
	updatedAt: number;
	reach: SecretReach;
	/** Who gets it. */
	scope: SecretScope;
	/** A repository's secret: the account has one of this name too, which this one stands in for. */
	account?: boolean;
	/** The account's secret: the repositories that have one of their own under this name. */
	repositories?: string[];
}

interface SecretList {
	secrets: ListedSecret[];
	profile: SandboxProfileId;
}

/**
 * Whose secrets a list is, and how they are read and changed: a repository's, as a sandbox of the
 * profile gets them, or the account's.
 */
interface SecretsOwner {
	kind: "repository" | "account";
	/** In words: "acme/harbor", or "your account". */
	name: string;
	/** How many it may keep. */
	limit: number;
	read(api: UserApi, profile: SandboxProfileId): Promise<SecretList>;
	save(
		api: UserApi,
		profile: SandboxProfileId,
		secret: { name: string; value?: string; scope: SecretScope },
	): Promise<SecretList>;
	remove(api: UserApi, profile: SandboxProfileId, name: string): Promise<SecretList>;
}

function repositoryOwner(repositoryId: GithubId, name: string): SecretsOwner {
	return {
		kind: "repository",
		name,
		limit: MAX_SECRETS_PER_REPOSITORY,
		read: (api, profile) => api.repositorySecrets(repositoryId, profile),
		save: (api, profile, secret) => api.saveRepositorySecret(repositoryId, profile, secret),
		remove: (api, profile, secretName) => api.deleteRepositorySecret(repositoryId, profile, secretName),
	};
}

const ACCOUNT_OWNER: SecretsOwner = {
	kind: "account",
	name: "your account",
	limit: MAX_ACCOUNT_SECRETS,
	read: (api, profile) => api.accountSecrets(profile),
	save: (api, profile, secret) => api.saveAccountSecret(profile, secret),
	remove: (api, profile, name) => api.deleteAccountSecret(profile, name),
};

/** The narrow scope includes setup only for repository secrets. */
const SCOPES = [
	{ scope: "setup", means: "the agent's commands never see it." },
	{ scope: "agent", means: "they can read it and, with network access, send it out." },
] as const;

const scopeName = (scope: SecretScope, owner: SecretsOwner["kind"]) =>
	scope === "agent" ? "also the agent's commands" : owner === "account" ? "MCP servers only" : "setup and MCP servers";

/** When a change reaches whom. `workspace` is what the agent the panel is about has: none yet, or one that was set up already; null in the start composer. */
function applies(workspace: "none" | "made" | null, owner: SecretsOwner["kind"] = "repository"): string {
	if (owner === "account")
		return "A change reaches MCP servers, and the agent's commands where a secret is also for them, from each agent's next turn, also in a sandbox that exists already. A turn that is running keeps what it started with.";
	if (workspace === "none")
		return "A change reaches the setup command when this agent's workspace is created, with its next prompt, and MCP servers and the agent's commands from its next turn.";
	if (workspace === "made")
		return "A change reaches MCP servers and the agent's commands from this agent's next turn. The setup command has run in this workspace and is not run again: it gets a change when a workspace is next created.";
	return "A change reaches the setup command in workspaces created after it, and MCP servers and the agent's commands from an agent's next turn.";
}

const REMOVED =
	"The platform takes every saved value out of what it shows and keeps of an agent's work: the timeline, the output of commands, error messages. A value that a program changes before printing it, into base64 say, is not recognised.";

interface SecretsState {
	list: SecretList | null;
	error: string | null;
	set(list: SecretList): void;
	reload(): void;
}

function useSecrets(owner: SecretsOwner | null, profile: SandboxProfileId | null): SecretsState {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [list, setList] = useState<SecretList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [round, setRound] = useState(0);

	useEffect(() => {
		setList(null);
		setError(null);
		if (owner === null || profile === null) return;
		let current = true;
		owner.read(client.user(auth), profile).then(
			next => {
				if (current) setList(next);
			},
			(failure: unknown) => {
				if (current) setError(explain(failure));
			},
		);
		return () => {
			current = false;
		};
	}, [client, auth, explain, owner, profile, round]);

	const set = useCallback((next: SecretList) => {
		setList(next);
		setError(null);
	}, []);
	const reload = useCallback(() => setRound(n => n + 1), []);
	return { list, error, set, reload };
}

/** Under a secret: where another one of its name is used in its place, or it is used in another's. */
function sharedName(secret: ListedSecret, owner: SecretsOwner): string | null {
	if (secret.account)
		return `Your account has a secret of this name too. ${owner.name}'s agents are handed this one, with its scope, and not the account's.`;
	const repositories = secret.repositories ?? [];
	if (repositories.length === 0) return null;
	const named =
		repositories.length <= 3 ? repositories : [...repositories.slice(0, 2), `${repositories.length - 2} more`];
	const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
	return `${list} ${repositories.length === 1 ? "overrides" : "override"} this.`;
}

function Secret({ secret, owner, onChange }: { secret: ListedSecret; owner: SecretsOwner; onChange(): void }) {
	const shared = sharedName(secret, owner);
	return (
		<li className="secret">
			<p className="secret-head">
				<span className="secret-name">{secret.name}</span>
				<span className="secret-scope">{scopeName(secret.scope, owner.kind)}</span>
			</p>
			<p className="secret-foot">
				<span className="secret-when">
					changed{" "}
					<time dateTime={new Date(secret.updatedAt).toISOString()} title={absoluteTime(secret.updatedAt)}>
						{day(secret.updatedAt)}
					</time>
				</span>
				<button
					type="button"
					className="link secret-change"
					onClick={onChange}
					aria-label={`Change the secret ${secret.name}`}
				>
					Change…
				</button>
			</p>
			{secret.reach.note &&
				(owner.kind === "account" ? (
					<details className="secret-note">
						<summary>Details</summary>
						{secret.reach.note}
					</details>
				) : (
					<p className="secret-note">{secret.reach.note}</p>
				))}
			{shared ? <p className="secret-note">{shared}</p> : null}
		</li>
	);
}

function SecretList({
	secrets,
	owner,
	onChange,
}: {
	secrets: ListedSecret[];
	owner: SecretsOwner;
	onChange(name: string): void;
}) {
	if (secrets.length === 0) return <p className="panel-empty">No secret is saved for {owner.name}.</p>;
	return (
		<ul className="secrets" aria-label={`The secrets saved for ${owner.name}`}>
			{secrets.map(secret => (
				<Secret key={secret.name} secret={secret} owner={owner} onChange={() => onChange(secret.name)} />
			))}
		</ul>
	);
}

/** What the dialog opens on: the list, an empty form, or the form of the secret of that name. */
type DialogView = "list" | "add" | { name: string };

interface SecretsDialogProps {
	/** Whose they are: a repository's, said for a session's sandbox where the panel is that session's, or the account's. */
	owner: SecretsOwner;
	profile: SandboxProfileId;
	secrets: ListedSecret[];
	/** Where it starts. From the list, a finished form goes back to the list; otherwise it closes the dialog. */
	start: DialogView;
	workspace: "none" | "made" | null;
	/** The name an empty form starts with: the variable a server that could not start reads. Never a value. */
	initialName?: string;
	onSaved(list: SecretList): void;
	onClose(): void;
}

function SecretsDialog({
	owner,
	profile,
	secrets,
	start,
	workspace,
	initialName,
	onSaved,
	onClose,
}: SecretsDialogProps) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const account = owner.kind === "account";
	const ids = { name: useId(), value: useId(), nameNote: useId(), valueNote: useId(), scope: useId() };
	const [view, setView] = useState<DialogView>(start);
	const editing = typeof view === "object" ? (secrets.find(secret => secret.name === view.name) ?? null) : null;
	const [name, setName] = useState("");
	const [value, setValue] = useState("");
	const [scope, setScope] = useState<SecretScope>("setup");
	/** The value's field takes several lines: a key, a certificate. */
	const [lines, setLines] = useState(false);
	const [busy, setBusy] = useState<"saving" | "deleting" | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// A form starts empty each time it is opened: a value is never carried from one secret to the next, and never prefilled.
	const viewKey = typeof view === "object" ? view.name : view;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the form is reset when another one is opened, not when the list is read again
	useEffect(() => {
		setName(viewKey === "add" ? (initialName ?? "") : "");
		setValue("");
		setLines(false);
		setScope(editing?.scope ?? "setup");
		setConfirming(false);
		setError(null);
	}, [viewKey]);

	const done = (list: SecretList) => {
		onSaved(list);
		setValue("");
		if (start === "list") setView("list");
		else onClose();
	};
	const leave = () => {
		if (busy !== null) return;
		if (start === "list" && view !== "list") setView("list");
		else onClose();
	};

	const bytes = new TextEncoder().encode(value).length;
	const nameProblem =
		name === "" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
			? null
			: "Letters, digits and underscores only, not starting with a digit.";
	const valueProblem =
		value === ""
			? null
			: value.trim().length < MIN_SECRET_VALUE_CHARS
				? `At least ${MIN_SECRET_VALUE_CHARS} characters.`
				: bytes > MAX_SECRET_VALUE_BYTES
					? `At most ${count(MAX_SECRET_VALUE_BYTES)} bytes; this is ${count(bytes)}.`
					: null;
	const full = !editing && secrets.length >= owner.limit;
	const ready = editing
		? value !== ""
			? valueProblem === null
			: scope !== editing.scope
		: name !== "" && nameProblem === null && value !== "" && valueProblem === null && !full;

	const save = async () => {
		if (busy !== null || !ready) return;
		setBusy("saving");
		setError(null);
		try {
			done(
				await owner.save(client.user(auth), profile, {
					name: editing ? editing.name : name,
					scope,
					...(value === "" ? {} : { value }),
				}),
			);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	};
	const remove = async () => {
		if (busy !== null || !editing) return;
		setBusy("deleting");
		setError(null);
		try {
			done(await owner.remove(client.user(auth), profile, editing.name));
		} catch (failure) {
			setError(explain(failure));
			setConfirming(false);
		} finally {
			setBusy(null);
		}
	};

	if (view === "list") {
		return (
			<Dialog
				title="Secrets"
				lede={
					account
						? "Saved for your account · handed to MCP servers as environment variables"
						: `Saved for ${owner.name} · handed to its agents as environment variables`
				}
				onClose={onClose}
				footer={
					<>
						<button type="button" className="button button-quiet" onClick={onClose}>
							Done
						</button>
						<button
							type="button"
							className="button button-outline"
							onClick={() => setView("add")}
							disabled={secrets.length >= owner.limit}
						>
							Add a secret
						</button>
					</>
				}
			>
				<div className="secret-dialog">
					<SecretList secrets={secrets} owner={owner} onChange={chosen => setView({ name: chosen })} />
					<p className="secret-about">{applies(workspace, owner.kind)}</p>
					<p className="secret-about">
						A saved value is never shown again: it can be replaced or deleted. {account ? "An account" : "A repository"}{" "}
						can have {owner.limit} secrets.
					</p>
				</div>
			</Dialog>
		);
	}

	const valueField = {
		id: ids.value,
		value,
		disabled: busy !== null,
		spellCheck: false,
		autoCapitalize: "off",
		autoCorrect: "off",
		// Never filled in by the browser, and not offered to a password manager as a sign-in.
		autoComplete: "off",
		"data-1p-ignore": true,
		"data-lpignore": "true",
		"data-bwignore": true,
		"aria-describedby": ids.valueNote,
		"aria-invalid": valueProblem !== null,
	};

	return (
		<Dialog
			title={editing ? `Change ${editing.name}` : "Add a secret"}
			lede={account ? "For your account's MCP servers" : `For ${owner.name}`}
			onClose={leave}
			dismissable={busy === null}
			footer={
				confirming && editing ? (
					<>
						<span className="dialog-error secret-confirm">
							Delete {editing.name}? {account ? "MCP servers" : "Agents"} stop being handed it from{" "}
							{account ? "each agent's" : "their"} next turn.
						</span>
						<button
							type="button"
							className="button button-quiet"
							onClick={() => setConfirming(false)}
							disabled={busy !== null}
						>
							Keep it
						</button>
						<button type="button" className="button button-danger" onClick={remove} disabled={busy !== null}>
							{busy === "deleting" ? "Deleting…" : "Delete"}
						</button>
					</>
				) : (
					<>
						{editing ? (
							<button
								type="button"
								className="button button-quiet secret-delete"
								onClick={() => setConfirming(true)}
								disabled={busy !== null}
							>
								Delete…
							</button>
						) : null}
						<button type="button" className="button button-quiet" onClick={leave} disabled={busy !== null}>
							{start === "list" ? "Back" : "Cancel"}
						</button>
						<button type="button" className="button button-primary" onClick={save} disabled={!ready || busy !== null}>
							{busy === "saving" ? "Saving…" : editing ? "Save" : "Add secret"}
						</button>
					</>
				)
			}
		>
			<div className="secret-dialog">
				{editing ? null : (
					<div className="field">
						<label className="label" htmlFor={ids.name}>
							Name
						</label>
						<input
							id={ids.name}
							className={`input input-mono${nameProblem ? " input-invalid" : ""}`}
							type="text"
							maxLength={MAX_SECRET_NAME_CHARS}
							spellCheck={false}
							autoCapitalize="off"
							autoCorrect="off"
							autoComplete="off"
							placeholder={account ? "TRACKER_TOKEN" : "NPM_TOKEN"}
							value={name}
							onChange={event => setName(event.target.value)}
							disabled={busy !== null}
							aria-describedby={ids.nameNote}
							aria-invalid={nameProblem !== null}
						/>
						<p className={`field-note${nameProblem ? " tone-warn" : ""}`} id={ids.nameNote}>
							{nameProblem ?? "Servers read it as ${NAME}."}
						</p>
					</div>
				)}
				<div className="field">
					<label className="label" htmlFor={ids.value}>
						{editing ? "New value" : "Value"} {editing ? <span className="label-optional">optional</span> : null}
					</label>
					{lines ? (
						<textarea
							{...valueField}
							className={`input input-mono textarea secret-lines${valueProblem ? " input-invalid" : ""}`}
							rows={4}
							onChange={event => setValue(event.target.value)}
						/>
					) : (
						<input
							{...valueField}
							className={`input input-mono${valueProblem ? " input-invalid" : ""}`}
							type="password"
							onChange={event => setValue(event.target.value)}
							onPaste={event => {
								// A value of several lines does not fit a field of one: the field that takes them is opened with what was pasted.
								const pasted = event.clipboardData.getData("text").replace(/\r\n?/g, "\n");
								if (!pasted.replace(/\n+$/, "").includes("\n")) return;
								event.preventDefault();
								setLines(true);
								setValue(pasted);
							}}
						/>
					)}
					<p className={`field-note${valueProblem ? " tone-warn" : ""}`} id={ids.valueNote}>
						{valueProblem ?? (editing ? "Leave empty to keep the saved value." : "Not shown again after saving.")}{" "}
						{lines ? null : (
							<button type="button" className="link" onClick={() => setLines(true)} disabled={busy !== null}>
								Several lines
							</button>
						)}
					</p>
				</div>
				<fieldset className="secret-scopes">
					<legend className="label">Who gets it</legend>
					{SCOPES.map(choice => (
						<label
							key={choice.scope}
							className={`secret-choice${scope === choice.scope ? " secret-choice-chosen" : ""}`}
						>
							<input
								className="secret-radio"
								type="radio"
								name={ids.scope}
								value={choice.scope}
								checked={scope === choice.scope}
								onChange={() => setScope(choice.scope)}
								disabled={busy !== null}
							/>
							<span className="secret-pick" aria-hidden="true" />
							<span className="secret-choice-text">
								<span className="secret-choice-name">
									{choice.scope === "agent"
										? "Also the agent's commands"
										: account
											? "MCP servers only"
											: "Setup and MCP servers"}
								</span>
								<span className="secret-choice-means"> — {choice.means}</span>
							</span>
						</label>
					))}
				</fieldset>
				<details className="field-note">
					<summary>Details</summary>
					<p>
						The sandbox can limit which tools receive a secret. The saved list shows any limits.
						{account &&
							" A repository secret with the same name takes precedence. Setup commands never receive account secrets."}
					</p>
					<p>{REMOVED}</p>
				</details>
				{full ? (
					<p className="secret-about tone-warn">
						{account ? "Your account" : "This repository"} has {owner.limit} secrets, which is the most it can have.
						Delete one first.
					</p>
				) : null}
				{error ? (
					<p className="callout callout-bad" role="alert">
						<WarnIcon />
						<span className="callout-text">{error}</span>
					</p>
				) : null}
			</div>
		</Dialog>
	);
}

/**
 * The secrets of one repository, listed and changed in place, as a sandbox of `profile` gets them.
 * With `session`, one of the user's on that repository, the list is said for that session's own
 * sandbox and the sentences about when a change applies are about that agent; without, for a sandbox
 * made now. `title` draws the heading the list stands under, around the control that adds a secret.
 * `onChanged` hears of every save and delete.
 */
export function SecretsBlock({
	repositoryId,
	name,
	profile,
	session,
	title,
	onChanged,
}: {
	repositoryId: GithubId;
	/** The repository in words. */
	name: string;
	profile: SandboxProfileId | null;
	session?: SessionSummary;
	title(add: ReactNode): ReactNode;
	onChanged?(): void;
}) {
	const owner = useMemo(() => repositoryOwner(repositoryId, name), [repositoryId, name]);
	return <OwnedSecrets owner={owner} profile={profile} session={session} title={title} onChanged={onChanged} />;
}

export function SettingsSecrets({
	repository,
	profile,
	onChanged,
}: {
	repository?: { id: GithubId; name: string; count: number };
	profile: SandboxProfileId | null;
	onChanged(): void;
}) {
	// A secret's reach depends on the sandbox an agent will start in.
	const { platform } = useApp();
	const profiles = platform.info?.profiles;
	const reach = profiles?.find(one => one.id === profile) ?? profiles?.find(one => one.available) ?? profiles?.[0];
	const id = repository ? "repo-secrets" : "settings-secrets";
	const title = (add: ReactNode) => (
		<h3 className="usage-title" id={id}>
			Secrets{repository?.count ? <span className="usage-count">{repository.count}</span> : null}
			{add}
		</h3>
	);
	return (
		<section className="usage-section repo-saved" aria-labelledby={id}>
			{repository ? (
				<SecretsBlock
					repositoryId={repository.id}
					name={repository.name}
					profile={reach?.id ?? null}
					title={title}
					onChanged={onChanged}
				/>
			) : (
				<OwnedSecrets owner={ACCOUNT_OWNER} profile={reach?.id ?? null} title={title} onChanged={onChanged} />
			)}
		</section>
	);
}

function OwnedSecrets({
	owner,
	profile,
	session,
	title,
	onChanged,
}: {
	owner: SecretsOwner;
	profile: SandboxProfileId | null;
	session?: SessionSummary;
	title(add: ReactNode): ReactNode;
	onChanged?(): void;
}) {
	const secrets = useSecrets(owner, profile);
	const { list, error } = secrets;
	const [open, setOpen] = useState<DialogView | null>(null);
	const workspace = session === undefined ? null : session.sandbox === "none" ? "none" : "made";
	const account = owner.kind === "account";
	const set = (next: SecretList) => {
		secrets.set(next);
		onChanged?.();
	};
	return (
		<>
			{title(
				<>
					{account && list && (
						<span className="usage-count">
							{list.secrets.length} of {owner.limit}
						</span>
					)}
					<button
						type="button"
						className="link secret-add"
						onClick={() => setOpen("add")}
						disabled={list === null}
						aria-label={`Add a secret for ${owner.name}`}
					>
						Add…
					</button>
				</>,
			)}
			{list === null ? (
				error ? null : (
					<Loading label="Loading the secrets">
						<SkeletonLines title={false} />
					</Loading>
				)
			) : (
				<>
					{account || list.secrets.length > 0 ? (
						<p className="panel-empty secret-lede">
							{account
								? "Values for MCP servers and, if you allow it, the agent's commands."
								: `Environment variables for ${owner.name}'s agents. A saved value is not shown again.`}
						</p>
					) : null}
					<SecretList secrets={list.secrets} owner={owner} onChange={chosen => setOpen({ name: chosen })} />
					{account ? (
						<details className="panel-empty secret-applies">
							<summary>Who gets which secret</summary>
							<p>
								A repository secret with the same name takes precedence. Changes apply from the next turn. Setup
								commands never receive account secrets.
							</p>
						</details>
					) : (
						<p className="panel-empty secret-applies">{applies(workspace, owner.kind)}</p>
					)}
				</>
			)}
			{error ? <LoadError inline error={error} reload={secrets.reload} /> : null}
			{open !== null && list !== null && profile !== null
				? createPortal(
						<SecretsDialog
							owner={owner}
							profile={profile}
							secrets={list.secrets}
							start={open}
							workspace={workspace}
							onSaved={set}
							onClose={() => setOpen(null)}
						/>,
						document.body,
					)
				: null}
		</>
	);
}

/**
 * The form that adds one secret, opened from a problem the side panel names (an MCP server that could not
 * start because `name` is not set): the repository's for a server the repository names, the account's for
 * one of the user's own. It closes once saved.
 */
export function AddSecretDialog({
	repository,
	profile,
	name,
	onClose,
}: {
	repository: { id: GithubId; name: string } | null;
	profile: SandboxProfileId;
	name: string;
	onClose(): void;
}) {
	const owner = useMemo(
		() => (repository ? repositoryOwner(repository.id, repository.name) : ACCOUNT_OWNER),
		[repository?.id, repository?.name],
	);
	const { list } = useSecrets(owner, profile);
	if (list === null) return null;
	return createPortal(
		<SecretsDialog
			owner={owner}
			profile={profile}
			secrets={list.secrets}
			start="add"
			workspace={null}
			initialName={name}
			onSaved={onClose}
			onClose={onClose}
		/>,
		document.body,
	);
}

/** The side panel's section, for a session on a repository of the GitHub connection. */
export function SecretsSection({ summary }: { summary: SessionSummary }) {
	const repository = summary.repository ?? null;
	if (!repository) return null;
	return (
		<section className="panel-section" aria-labelledby="panel-secrets">
			<SecretsBlock
				repositoryId={repository.id}
				name={`${repository.owner}/${repository.name}`}
				profile={summary.profile}
				session={summary}
				title={add => (
					<h2 className="panel-title" id="panel-secrets">
						Secrets
						{add}
					</h2>
				)}
			/>
		</section>
	);
}

/** The start composer's field: what is saved for the chosen repository, and the way to the dialog. `repository` is the chosen one, in words. */
export function SecretsField({
	repositoryId,
	repository,
	profile,
	disabled,
}: {
	repositoryId: GithubId;
	repository: string;
	profile: SandboxProfileId | null;
	disabled: boolean;
}) {
	const owner = useMemo(() => repositoryOwner(repositoryId, repository), [repositoryId, repository]);
	const { list, error, set } = useSecrets(owner, profile);
	const [open, setOpen] = useState(false);
	const note = useId();
	const names = list?.secrets.map(secret => secret.name) ?? [];
	const narrowed = list?.secrets.filter(secret => secret.reach.note !== null).length ?? 0;
	return (
		<div className="field field-wide">
			<span className="label">
				Secrets <span className="label-optional">optional</span>
			</span>
			<div className="secret-field">
				<p className="secret-field-names" aria-busy={profile !== null && list === null && error === null}>
					{profile === null
						? "Choose a sandbox first: what a secret reaches depends on it."
						: list === null
							? error
								? "Not read."
								: "Reading…"
							: names.length === 0
								? `None saved for ${repository}.`
								: names.join(", ")}
				</p>
				<button
					type="button"
					className="button button-outline button-small"
					onClick={() => setOpen(true)}
					disabled={disabled || list === null || profile === null}
					aria-describedby={note}
				>
					Manage…
				</button>
			</div>
			<p className="field-note" id={note}>
				Environment variables for {repository}'s setup command, its MCP servers and, where you choose so, the agent's
				commands. They are saved for the repository at once, not with this launch.
				{narrowed > 0
					? ` In the sandbox chosen above, ${narrowed === 1 ? "one of them reaches" : `${narrowed} of them reach`} less than its scope says: the list says which, and why.`
					: ""}
			</p>
			{error ? (
				<p className="field-note tone-warn" role="status">
					The secrets saved for {repository} could not be read: {error}
				</p>
			) : null}
			{open && list !== null && profile !== null
				? // Outside the start composer: Enter in one of its fields must not launch an agent.
					createPortal(
						<SecretsDialog
							owner={owner}
							profile={profile}
							secrets={list.secrets}
							start="list"
							workspace={null}
							onSaved={set}
							onClose={() => setOpen(false)}
						/>,
						document.body,
					)
				: null}
		</div>
	);
}
