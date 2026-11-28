/**
 * The settings page's API tokens: for a script that files work items and reads them over the
 * platform's HTTP API. The list is the user's actor's (`apiTokens`), read when the page opens; every
 * change answers with the list as it is then. A token's value is shown once, in the dialog that made
 * it, and never again: the platform keeps only a digest of it.
 */
import { MAX_API_TOKENS, type ApiToken, type ApiTokenScope } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { absoluteTime, day, relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { useNow } from "../state/hooks";
import { CopyButton } from "./Copy";
import { Dialog } from "./Dialog";
import { ApiIcon } from "./Icons";
import { CardHead } from "./IntegrationCard";
import { Check } from "./ui/Check";
import { Failure } from "./ui/Failure";
import { LoadError } from "./ui/LoadError";
import { Loading, SkeletonLines } from "./ui/Skeleton";

const SCOPES: Array<{ scope: ApiTokenScope; name: string; means: string }> = [
	{
		scope: "items:create",
		name: "File work items",
		means: "POST /api/items: on your repositories, as you would from a repository's page.",
	},
	{
		scope: "items:read",
		name: "Read work items",
		means: "GET /api/items/<id>: where an item is, its verdict and its cost.",
	},
];
const scopeWords = (scopes: ApiTokenScope[]) =>
	scopes.map(scope => (scope === "items:create" ? "files items" : "reads items")).join(", ");

/** Making a token: its name and what it may do; then its value, this once. */
function NewTokenDialog({ onClose, onMade }: { onClose(): void; onMade(token: ApiToken): void }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [name, setName] = useState("");
	const [scopes, setScopes] = useState<ApiTokenScope[]>(["items:create", "items:read"]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [secret, setSecret] = useState<string | null>(null);
	const ids = { form: useId(), name: useId() };
	const ready = name.trim() !== "" && scopes.length > 0;

	const make = async (event: FormEvent) => {
		event.preventDefault();
		if (!ready || busy) return;
		setBusy(true);
		setError(null);
		try {
			const made = await client.user(auth).createApiToken({ name: name.trim(), scopes });
			onMade(made.token);
			setSecret(made.secret);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	};

	if (secret !== null) {
		return (
			<Dialog
				title={`“${name.trim()}” is made`}
				lede="Copy its value now. It is not shown again: the platform keeps only a digest of it."
				onClose={onClose}
				footer={
					<button type="button" className="button button-primary" onClick={onClose} data-autofocus>
						Done
					</button>
				}
			>
				<div className="machine-command">
					<pre tabIndex={0} aria-label="The token">
						{secret}
					</pre>
					<CopyButton text={secret} label="Copy the token" />
				</div>
				<p className="field-note">
					To file an item, send <code>POST /api/items</code> with{" "}
					<code>Authorization: Bearer {secret.slice(0, 8)}…</code>. Anyone who has it can do what its scopes allow until
					you revoke it.
				</p>
			</Dialog>
		);
	}

	return (
		<Dialog
			title="New API token"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={!ready || busy}>
						{busy ? "Making…" : "Make token"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={make}>
				<div>
					<label className="label" htmlFor={ids.name}>
						Name
					</label>
					<input
						id={ids.name}
						className="input"
						value={name}
						maxLength={64}
						placeholder="Nightly triage script"
						onChange={event => setName(event.target.value)}
						readOnly={busy}
						data-autofocus
					/>
					<p className="field-note">For you to tell it apart: where it is used.</p>
				</div>
				<fieldset className="item-scopes">
					<legend className="label">What it may do</legend>
					{SCOPES.map(({ scope, name: label, means }) => {
						const on = scopes.includes(scope);
						return (
							<Check
								key={scope}
								checked={on}
								disabled={busy}
								onChange={on => setScopes(now => (on ? [...now, scope] : now.filter(one => one !== scope)))}
							>
								<span className="check-name">{label}</span>
								<span className="check-means">{means}</span>
							</Check>
						);
					})}
				</fieldset>
				<Failure error={error} />
			</form>
		</Dialog>
	);
}

function RevokeDialog({
	token,
	onClose,
	onRevoked,
}: {
	token: ApiToken;
	onClose(): void;
	onRevoked(list: ApiToken[]): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const revoke = async () => {
		setBusy(true);
		setError(null);
		try {
			onRevoked(await client.user(auth).revokeApiToken(token.id));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};
	return (
		<Dialog
			title={`Revoke “${token.name}”?`}
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={revoke} disabled={busy}>
						{busy ? "Revoking…" : "Revoke token"}
					</button>
				</>
			}
		>
			<p>It stops working at once: whatever sends it is refused from then on. Work items it filed stay.</p>
			<Failure error={error} />
		</Dialog>
	);
}

export function ApiTokens() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [state, setState] = useState<{ list: ApiToken[] | null; error: string | null }>({ list: null, error: null });
	const [making, setMaking] = useState(false);
	const [revoking, setRevoking] = useState<ApiToken | null>(null);
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		client
			.user(auth)
			.apiTokens()
			.then(
				list => mine === asked.current && setState({ list, error: null }),
				(failure: unknown) =>
					mine === asked.current && setState(current => ({ list: current.list, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		reload();
		return () => {
			asked.current += 1;
		};
	}, [reload]);

	const replace = (list: ApiToken[]) => {
		asked.current += 1;
		setState({ list, error: null });
	};
	const { list } = state;
	const full = list !== null && list.length >= MAX_API_TOKENS;

	return (
		<section className="usage-section integration api-tokens" aria-labelledby="settings-tokens">
			<CardHead
				titleId="settings-tokens"
				mark={<ApiIcon size={18} />}
				name="API tokens"
				badge={
					list && list.length > 0 ? <span className="usage-count">{`${list.length} of ${MAX_API_TOKENS}`}</span> : null
				}
				what="For scripts that file work items."
				action={
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => setMaking(true)}
						disabled={list === null || full}
						title={full ? `An account can keep ${MAX_API_TOKENS} tokens: revoke one first` : undefined}
					>
						New token…
					</button>
				}
			/>
			<div className="integration-body">
				{full ? (
					<p className="usage-note tone-warn">
						An account can keep {MAX_API_TOKENS} tokens: revoke one to make another.
					</p>
				) : null}
				{list === null ? (
					state.error ? (
						<LoadError subject="Your API tokens" error={state.error} reload={reload} />
					) : (
						<Loading label="Loading your tokens">
							<SkeletonLines title={false} lines={[58]} />
						</Loading>
					)
				) : list.length === 0 ? (
					<p className="usage-empty">No API token yet.</p>
				) : (
					<ul className="mapping-list" aria-label="Your API tokens">
						{list.map(token => (
							<li key={token.id} className="mapping-row">
								<div className="mapping-line token-line">
									<span className="token-main">
										<span className="mapping-from-name token-name">{token.name}</span>
										<span className="token-meta">
											{scopeWords(token.scopes)} · made {day(token.createdAt)}
										</span>
									</span>
									<span className="token-used" title={token.usedAt === null ? undefined : absoluteTime(token.usedAt)}>
										{token.usedAt === null ? "never used" : `used ${relativeTime(token.usedAt, now)}`}
									</span>
									<span className="mapping-actions">
										<button
											type="button"
											className="button button-quiet button-small token-revoke"
											onClick={() => setRevoking(token)}
										>
											<span>
												Revoke<span className="visually-hidden"> {token.name}</span>…
											</span>
										</button>
									</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>
			{making ? (
				<NewTokenDialog
					onClose={() => setMaking(false)}
					onMade={token => replace([token, ...(list ?? []).filter(one => one.id !== token.id)])}
				/>
			) : null}
			{revoking ? <RevokeDialog token={revoking} onClose={() => setRevoking(null)} onRevoked={replace} /> : null}
		</section>
	);
}
