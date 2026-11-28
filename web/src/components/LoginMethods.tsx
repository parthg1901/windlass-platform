import type { LinkedLogin, LoginProvider } from "@contract";
import { useEffect, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { Dialog } from "./Dialog";
import { GitHubLogo, GoogleLogo } from "./AgentLogos";
import { LoadError, Loading, Skeleton, SkeletonButton } from "./ui";

const providers = [
	{ id: "github", name: "GitHub", logo: <GitHubLogo /> },
	{ id: "google", name: "Google", logo: <GoogleLogo /> },
] as const;
const lastMethodReason = "Link another sign-in method before unlinking this one.";

export function LoginMethods() {
	const { client, platform, explain } = useApp();
	const auth = useAuth();
	const [linked, setLinked] = useState<LinkedLogin[] | null>(null);
	const [removing, setRemoving] = useState<(typeof providers)[number] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const info = platform.info;
	const host = info?.github && new URL(info.github.url).host;

	useEffect(() => {
		let active = true;
		client
			.user(auth)
			.linkedLogins()
			.then(methods => {
				if (active) setLinked(methods);
			})
			.catch(failure => {
				if (active) setError(explain(failure));
			});
		return () => {
			active = false;
		};
	}, [auth, client, explain]);

	async function link(provider: LoginProvider) {
		setBusy(true);
		setError("");
		try {
			location.assign((await client.login.start(provider, auth)).url);
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	}

	async function unlink(provider: LoginProvider) {
		setBusy(true);
		setError("");
		try {
			await client.user(auth).unlinkLogin(provider);
			setLinked(current => current?.filter(method => method.provider !== provider) ?? null);
			setRemoving(null);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="usage-section" aria-labelledby="account-login">
			<h3 className="usage-title" id="account-login">
				Sign-in
			</h3>
			{linked && info ? (
				<ul className="settings-list" aria-label="Sign-in methods">
					{providers.map(provider => {
						const { id, name, logo } = provider;
						if (id === "github" ? !info.github : !info.googleLogin) return null;
						const method = linked.find(one => one.provider === id);
						const last = method && linked.length === 1;
						const instance = method && id === "github" && host !== "github.com" && host;
						const action = method ? "Unlink…" : "Link";
						return (
							<li key={id} className="usage-kept-row login-method">
								<div className="usage-kept-main">
									<span className="provider-name">
										{logo}
										{name}
									</span>
									{(method?.display || instance) && (
										<p className="agent-meta">
											{method?.display && (
												<span>
													{id === "github" && "@"}
													{method.display}
												</span>
											)}
											{instance && <span>{instance}</span>}
										</p>
									)}
								</div>
								<span className={method ? "machine-used tone-good" : "machine-used"}>
									{method ? "linked" : "not linked"}
								</span>
								<button
									type="button"
									className="button button-outline button-small"
									aria-label={method ? `Unlink ${name}…` : `Link ${name}`}
									aria-describedby={last ? "last-login-reason" : undefined}
									title={last ? lastMethodReason : undefined}
									disabled={busy || last}
									onClick={() => {
										if (method) {
											setError("");
											setRemoving(provider);
										} else void link(id);
									}}
								>
									{action}
								</button>
							</li>
						);
					})}
				</ul>
			) : !info && platform.error ? (
				<LoadError inline error={platform.error} reload={platform.reload} />
			) : (
				!error && (
					<Loading label="Loading sign-in methods">
						<ul className="settings-list" aria-hidden="true">
							{providers
								.filter(({ id }) => !info || (id === "github" ? info.github : info.googleLogin))
								.map(({ id, name, logo }) => (
									<li key={id} className="usage-kept-row login-method">
										<div className="usage-kept-main">
											<span className="provider-name">
												{logo}
												{name}
											</span>
										</div>
										<Skeleton width={56} />
										<SkeletonButton />
									</li>
								))}
						</ul>
					</Loading>
				)
			)}
			{linked?.length === 1 && (
				<p className="usage-note" id="last-login-reason">
					{lastMethodReason}
				</p>
			)}
			{error && !removing && (
				<p className="callout callout-warn" role="alert">
					{error}
				</p>
			)}
			{removing && (
				<Dialog
					title={`Unlink ${removing.name}?`}
					size="small"
					dismissable={!busy}
					onClose={() => {
						setRemoving(null);
						setError("");
					}}
					footer={
						<>
							<button
								type="button"
								className="button button-quiet"
								disabled={busy}
								data-autofocus
								onClick={() => {
									setRemoving(null);
									setError("");
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="button button-danger"
								disabled={busy}
								onClick={() => void unlink(removing.id)}
							>
								{busy ? "Unlinking…" : "Unlink"}
							</button>
						</>
					}
				>
					<p>You’ll need to use your other sign-in method to access this account.</p>
					{error && (
						<p className="callout callout-warn" role="alert">
							{error}
						</p>
					)}
				</Dialog>
			)}
		</section>
	);
}
