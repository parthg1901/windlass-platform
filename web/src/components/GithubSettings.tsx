/**
 * Settings: the GitHub connection. Who connected, the accounts the app is installed on (each with the way to
 * choose its repositories at GitHub), and the ways to add an account or disconnect.
 */
import { useEffect } from "react";
import { useGithub, type GithubNotice } from "../state/github";
import { ExternalIcon, WarnIcon } from "./Icons";
import { IntegrationCard, IntegrationFacts, IntegrationSteps } from "./IntegrationCard";
import { OwnerAvatar } from "./RepoTile";

/** Notices said here already: the account menu does not open to say them again. */
export const shownInSettings = new WeakSet<GithubNotice>();

export function GithubSettings() {
	const github = useGithub();
	const { dismiss } = github;
	const notice = github.notice?.where === "account" ? github.notice : null;
	useEffect(() => {
		if (notice) shownInSettings.add(notice);
	}, [notice]);
	// Leaving Settings puts it away.
	useEffect(() => dismiss, [dismiss]);
	if (!github.enabled) return null;
	const connection = github.status?.connection ?? null;
	const busy = github.busy !== null;
	const opening =
		github.busy === "leaving" ? "Opening GitHub…" : github.busy === "popup" ? "In the GitHub window…" : null;
	const state = github.status === null && !github.error ? "loading" : connection ? "connected" : "disconnected";
	const canStart = github.status !== null && !github.error;
	return (
		<IntegrationCard
			id="settings-github"
			provider="github"
			name="GitHub"
			what="Agents work on your repositories, private ones included, and hand their work back as pull requests."
			state={state}
			action={
				connection ? (
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => github.connect({ where: "account", install: true })}
						disabled={busy && github.busy !== "popup"}
					>
						{opening ?? "Add an account"}
					</button>
				) : canStart ? (
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => github.connect({ where: "account" })}
						disabled={busy && github.busy !== "popup"}
					>
						{opening ?? "Connect GitHub…"}
					</button>
				) : null
			}
			more={
				connection
					? [
							{
								id: "disconnect",
								label: github.busy === "disconnecting" ? "Disconnecting…" : "Disconnect…",
								tone: "warn",
								disabled: busy,
								onSelect: () => void github.disconnect(),
							},
						]
					: []
			}
		>
			{notice ? (
				<p
					className={`callout${notice.tone === "bad" ? " callout-warn" : ""}`}
					role={notice.tone === "bad" ? "alert" : "status"}
				>
					{notice.tone === "bad" ? <WarnIcon /> : null}
					<span>{notice.text}</span>
				</p>
			) : null}
			{github.busy === "finishing" ? (
				<p className="usage-empty" aria-busy="true">
					Finishing the GitHub connection…
				</p>
			) : github.error ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>
						{github.error}{" "}
						<button type="button" className="link" onClick={github.reload}>
							Try again
						</button>
					</span>
				</p>
			) : github.status === null ? (
				<div className="usage-loading" aria-busy="true" aria-label="Loading GitHub">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			) : connection ? (
				<>
					<IntegrationFacts facts={[["Signed in as", <span className="mono">@{connection.login}</span>]]} />
					<ul className="mapping-list" aria-label="GitHub accounts">
						{connection.accounts.map(account => (
							<li key={account.installationId} className="mapping-row">
								<div className="mapping-line mapping-line-account">
									<span className="mapping-from">
										<span className="mapping-from-name">
											<OwnerAvatar owner={account.login} />
											{account.login}
										</span>
										<span className="mapping-from-note">
											{account.kind === "organization" ? "Organization" : "Personal account"}
										</span>
									</span>
									<span className="mapping-actions">
										<a
											className="button button-quiet button-small"
											href={account.manageUrl}
											target="_blank"
											rel="noreferrer"
										>
											Repositories
											<span className="visually-hidden"> of {account.login}, at GitHub</span>
											<ExternalIcon size={11} />
										</a>
									</span>
								</div>
							</li>
						))}
					</ul>
					<p className="field-note">Agents see the repositories you let the Windlass app reach in these accounts.</p>
				</>
			) : (
				<IntegrationSteps
					steps={[
						"Install the Windlass app on your account or organization.",
						"Choose the repositories it may reach.",
						"Start an agent on one; its work comes back as a pull request.",
					]}
				/>
			)}
		</IntegrationCard>
	);
}
