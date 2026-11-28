/**
 * The Connections page's API keys: one per provider, which every agent that can use that provider
 * uses. The list is the user's actor's (`modelProviders`); a key is sent once, when it is saved, and
 * only its last four characters come back. `KeyDialog` is also opened from a Connections cell and the
 * first-run setup.
 */
import { MODEL_PROVIDERS, type ModelProvider, type ModelProviderCheck, type ModelProviderStatus } from "@contract";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { absoluteTime, day, relativeTime } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { PROVIDERS_CHANGED, useNow } from "../state/hooks";
import { Dialog } from "./Dialog";
import { AnthropicLogo, GeminiLogo, OpenAILogo, OpenRouterLogo } from "./AgentLogos";
import { ExternalIcon } from "./Icons";
import { Failure } from "./ui/Failure";
import { LoadError } from "./ui/LoadError";
import { Loading, SkeletonBadge, SkeletonButton } from "./ui/Skeleton";
import { StatusTag } from "./ui/StatusTag";

const PROVIDERS: Record<ModelProvider, { name: string; placeholder: string; keysUrl: string; logo?: ReactNode }> = {
	openai: {
		name: "OpenAI",
		placeholder: "sk-proj-…",
		keysUrl: "https://platform.openai.com/api-keys",
		logo: <OpenAILogo />,
	},
	anthropic: {
		name: "Anthropic",
		placeholder: "sk-ant-api03-…",
		keysUrl: "https://console.anthropic.com/settings/keys",
		logo: <AnthropicLogo />,
	},
	google: {
		name: "Google Gemini",
		placeholder: "AIza…",
		keysUrl: "https://aistudio.google.com/apikey",
		logo: <GeminiLogo />,
	},
	openrouter: {
		name: "OpenRouter",
		placeholder: "sk-or-v1-…",
		keysUrl: "https://openrouter.ai/settings/keys",
		logo: <OpenRouterLogo />,
	},
};

function ProviderName({ provider }: { provider: ModelProvider }) {
	const { name, logo } = PROVIDERS[provider];
	return (
		<span className="provider-name">
			{logo}
			{name}
		</span>
	);
}

function GetKey({ provider }: { provider: ModelProvider }) {
	const { name, keysUrl } = PROVIDERS[provider];
	return (
		<a className="provider-get" href={keysUrl} target="_blank" rel="noopener noreferrer">
			Get a key<span className="visually-hidden"> from {name} (opens in a new tab)</span>
			<ExternalIcon size={11} />
		</a>
	);
}

export function KeyDialog({
	provider,
	replacing,
	onClose,
	onSaved,
}: {
	provider: ModelProvider;
	replacing: boolean;
	onClose(): void;
	onSaved(status: ModelProviderCheck): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ids = { form: useId(), key: useId() };
	const { name, placeholder } = PROVIDERS[provider];

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (!key.trim() || busy) return;
		setBusy(true);
		setError(null);
		try {
			onSaved(await client.user(auth).saveModelProvider({ provider, key: key.trim() }));
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title={
				<span className="provider-name">
					{PROVIDERS[provider].logo}
					{`${replacing ? "Replace" : "Add"} the ${name} key`}
				</span>
			}
			lede={
				<>
					It is checked with the provider when it is saved, and never shown again: only its last four characters are.{" "}
					<GetKey provider={provider} />
				</>
			}
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Cancel
					</button>
					<button type="submit" form={ids.form} className="button button-primary" disabled={!key.trim() || busy}>
						{busy ? "Saving…" : "Save key"}
					</button>
				</>
			}
		>
			<form id={ids.form} className="item-form" onSubmit={save}>
				<div>
					<label className="label" htmlFor={ids.key}>
						API key
					</label>
					<input
						id={ids.key}
						className="input"
						type="password"
						autoComplete="off"
						spellCheck={false}
						value={key}
						placeholder={placeholder}
						onChange={event => setKey(event.target.value)}
						readOnly={busy}
						data-autofocus
					/>
				</div>
				<Failure error={error} />
			</form>
		</Dialog>
	);
}

function RemoveDialog({
	provider,
	onClose,
	onRemoved,
}: {
	provider: ModelProvider;
	onClose(): void;
	onRemoved(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { name } = PROVIDERS[provider];
	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).removeModelProvider(provider);
			onRemoved();
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};
	return (
		<Dialog
			title={`Remove the ${name} key?`}
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={remove} disabled={busy}>
						{busy ? "Removing…" : "Remove key"}
					</button>
				</>
			}
		>
			<p>Removing the key blocks new requests. A request already running may finish.</p>
			<Failure error={error} />
		</Dialog>
	);
}

export function ModelProviders() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const now = useNow(60_000);
	const [state, setState] = useState<{ list: ModelProviderStatus[] | null; error: string | null }>({
		list: null,
		error: null,
	});
	// What the last check said, for this visit: the saved status keeps only whether it passed.
	const [checks, setChecks] = useState<Partial<Record<ModelProvider, { busy?: boolean; message?: string }>>>({});
	const [editing, setEditing] = useState<{ provider: ModelProvider; replacing: boolean } | null>(null);
	const [removing, setRemoving] = useState<ModelProvider | null>(null);
	const asked = useRef(0);

	const reload = useCallback(() => {
		const mine = ++asked.current;
		client
			.user(auth)
			.modelProviders()
			.then(
				list => mine === asked.current && setState({ list, error: null }),
				(failure: unknown) =>
					mine === asked.current && setState(current => ({ list: current.list, error: explain(failure) })),
			);
	}, [client, auth, explain]);

	useEffect(() => {
		reload();
		// A key saved elsewhere on the page (a Connections cell) shows here too.
		window.addEventListener(PROVIDERS_CHANGED, reload);
		return () => {
			asked.current += 1;
			window.removeEventListener(PROVIDERS_CHANGED, reload);
		};
	}, [reload]);

	const put = (provider: ModelProvider, status: ModelProviderCheck | null) => {
		window.dispatchEvent(new Event(PROVIDERS_CHANGED));
		asked.current += 1;
		setChecks(current => ({ ...current, [provider]: status?.message ? { message: status.message } : {} }));
		setState(current => {
			const rest = (current.list ?? []).filter(one => one.provider !== provider);
			if (!status) return { list: rest, error: null };
			const { message: _message, ...saved } = status;
			return { list: [...rest, saved], error: null };
		});
	};

	const check = async (provider: ModelProvider) => {
		setChecks(current => ({ ...current, [provider]: { busy: true } }));
		try {
			put(provider, await client.user(auth).checkModelProvider(provider));
		} catch (failure) {
			setChecks(current => ({ ...current, [provider]: { message: explain(failure) } }));
		}
	};

	const { list } = state;
	return (
		<section className="usage-section repo-saved" aria-label="Model keys">
			{list === null ? (
				state.error ? (
					<LoadError subject="Your model providers" error={state.error} reload={reload} />
				) : (
					<Loading label="Loading your model providers">
						<ul className="settings-list" aria-hidden="true">
							{MODEL_PROVIDERS.map(provider => (
								<li key={provider} className="usage-kept-row provider-row">
									<div className="usage-kept-main">
										<span className="usage-kept-title">
											<ProviderName provider={provider} />
										</span>
									</div>
									<SkeletonBadge />
									<div className="provider-actions">
										<SkeletonButton />
									</div>
								</li>
							))}
						</ul>
					</Loading>
				)
			) : (
				<ul className="settings-list" aria-label="Your model providers">
					{MODEL_PROVIDERS.map(provider => {
						const { name } = PROVIDERS[provider];
						const saved = list.find(one => one.provider === provider);
						const last = checks[provider] ?? {};
						const failed =
							last.message ?? (saved && saved.checkedAt !== null && !saved.ok ? "The last check failed." : undefined);
						return (
							<li
								key={provider}
								id={`key-${provider}`}
								className="usage-kept-row provider-row"
								data-provider={provider}
							>
								<div className="usage-kept-main">
									<span className="usage-kept-title">
										<ProviderName provider={provider} />
									</span>
									{saved ? (
										<p className="agent-meta">
											<span className="provider-last4">…{saved.last4}</span>
											<span>added {day(saved.addedAt)}</span>
											{saved.ok && saved.models ? (
												<span>{saved.models.length === 1 ? "1 model" : `${saved.models.length} models`}</span>
											) : null}
											{saved.checkedAt !== null ? (
												<span title={absoluteTime(saved.checkedAt)}>checked {relativeTime(saved.checkedAt, now)}</span>
											) : null}
										</p>
									) : null}
									{saved?.needsWindlassCheck && (
										<p className="field-note">Recheck this key to find its Windlass-compatible models.</p>
									)}
									{failed ? (
										<p className="field-note tone-bad" role="status">
											{failed}
										</p>
									) : null}
								</div>
								<StatusTag tone={saved ? (saved.ok ? "good" : "bad") : "off"} className="provider-state">
									{saved ? (saved.ok ? "Connected" : "Check failed") : "No key"}
								</StatusTag>
								<div className="provider-actions">
									{saved ? (
										<>
											<button
												type="button"
												className="button button-outline button-small"
												onClick={() => void check(provider)}
												disabled={last.busy}
											>
												<span>
													{last.busy ? "Checking…" : saved.needsWindlassCheck ? "Recheck" : "Check"}
													<span className="visually-hidden"> {name}</span>
												</span>
											</button>
											<button
												type="button"
												className="button button-outline button-small"
												onClick={() => setEditing({ provider, replacing: true })}
											>
												<span>
													<span>
														Replace<span className="visually-hidden"> {name}</span>…
													</span>
												</span>
											</button>
											<button
												type="button"
												className="button button-outline button-small"
												onClick={() => setRemoving(provider)}
											>
												<span>
													<span>
														Remove<span className="visually-hidden"> {name}</span>…
													</span>
												</span>
											</button>
										</>
									) : (
										<button
											type="button"
											className="button button-outline button-small"
											onClick={() => setEditing({ provider, replacing: false })}
										>
											<span>
												Add key<span className="visually-hidden"> for {name}</span>…
											</span>
										</button>
									)}
								</div>
							</li>
						);
					})}
				</ul>
			)}
			{list !== null && state.error ? <LoadError inline stale error={state.error} reload={reload} /> : null}
			{editing ? (
				<KeyDialog
					provider={editing.provider}
					replacing={editing.replacing}
					onClose={() => setEditing(null)}
					onSaved={status => put(editing.provider, status)}
				/>
			) : null}
			{removing ? (
				<RemoveDialog provider={removing} onClose={() => setRemoving(null)} onRemoved={() => put(removing, null)} />
			) : null}
		</section>
	);
}
