import { useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { ApiTokens } from "../components/ApiTokens";
import { SettingsSecrets } from "../components/Secrets";
import { DefaultAgent } from "../components/RunSettings";
import { CopyButton } from "../components/Copy";
import { GithubSettings } from "../components/GithubSettings";
import { GitlabSettings, useGitlabSettings } from "../components/GitlabSettings";
import { SlackSettings } from "../components/SlackSettings";
import { LinearSettings } from "../components/LinearSettings";
import { JiraSettings } from "../components/JiraSettings";
import { LinkNotice, LinksProvider } from "../components/LinkedAccounts";
import { LoginMethods } from "../components/LoginMethods";
import { PersonalServers } from "../components/PersonalServers";
import { PlanSection } from "../components/Plan";
import { runOf } from "../lib/run";
import { linkProps } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount } from "../state/hooks";
import { useGithub } from "../state/github";
import { Check } from "../components/ui/Check";
import { SettingsGroup, SettingsLayout, SettingsPending } from "../components/SettingsGroups";
import { IntegrationSkeleton } from "../components/IntegrationCard";
import { LoadError, Loading, SkeletonLines } from "../components/ui";

export function Settings() {
	const { platform } = useApp();
	const auth = useAuth();
	const github = useGithub();
	const gitlab = useGitlabSettings();
	const account = useAccount();
	const { settings } = account;
	const info = platform.info;
	// A disabled integration has no Settings component to consume its callback.
	useEffect(() => {
		if (info && !info.items && /^#(?:slack|linear|link)(?:-error|-return)?=/.test(location.hash)) {
			history.replaceState(history.state, "", location.pathname + location.search);
		}
	}, [info]);
	const hostedProfile = runOf({
		account: settings?.defaults,
		item: { place: "hosted" },
	}).profile;
	const secretsProfile = info?.profiles.some(p => p.id === hostedProfile && p.available) ? hostedProfile : null;

	return (
		<main className="home usage repo settings">
			<header className="home-head">
				<div className="repo-head">
					<h1 className="display display-small">Settings</h1>
					<p className="home-account">Used by all your agents. Settings for a single repository are on its page.</p>
				</div>
			</header>

			{account.error && settings !== null && <LoadError inline stale error={account.error} reload={account.reload} />}

			<SettingsLayout label="Settings sections">
				<SettingsGroup id="settings-account" title="Account" lede="How you sign in, and your plan.">
					{!auth.profile.demo && <LoginMethods />}
					{info?.billing ? (
						<PlanSection />
					) : info === null ? (
						<section className="usage-section billing" aria-labelledby="settings-plan">
							<h3 className="usage-title" id="settings-plan">
								Plan
							</h3>
							<Loading label="Loading your plan">
								<SkeletonLines title={false} />
							</Loading>
						</section>
					) : null}
					<SessionSettings />
					{!auth.profile.demo ? (
						<div className="settings-row settings-account-id">
							<span className="settings-row-text">Account id</span>
							<code className="settings-row-meta">{auth.profile.uid}</code>
							<CopyButton text={auth.profile.uid} label="Copy the account id" />
						</div>
					) : null}
				</SettingsGroup>

				<SettingsGroup
					id="settings-models"
					title="Models"
					lede={
						<>
							The agent and model your work uses, unless a repository or an item says otherwise. Plans and API keys that
							pay for the agents are on{" "}
							<a className="link" {...linkProps({ name: "connections" })}>
								Connections →
							</a>
						</>
					}
				>
					<section className="usage-section" aria-label="Default models">
						{settings === null && account.error ? (
							<SettingsPending subject="Your settings" error={account.error} reload={account.reload} />
						) : (
							<DefaultAgent account={account} />
						)}
					</section>
					<div className="settings-row">
						<span className="settings-row-text">
							Your Claude and ChatGPT plans and your API keys moved to Connections.
						</span>
						<a className="button button-outline button-small settings-row-end" {...linkProps({ name: "connections" })}>
							Open Connections
						</a>
					</div>
				</SettingsGroup>

				<SettingsGroup
					id="settings-tools"
					title="Tools"
					lede="MCP servers every agent gets, and the secrets they read."
				>
					{settings !== null ? (
						<>
							<PersonalServers settings={settings} onChanged={account.replace} />
							<SettingsSecrets profile={secretsProfile} onChanged={account.reload} />
						</>
					) : (
						<section className="usage-section" aria-label="Tools">
							<SettingsPending subject="Your tools" error={account.error} reload={account.reload} />
						</section>
					)}
				</SettingsGroup>

				{info === null ? (
					<SettingsGroup id="settings-integrations" title="Integrations" lede="Where agents find your code.">
						<IntegrationSkeleton label="Loading your integrations" />
						<IntegrationSkeleton />
					</SettingsGroup>
				) : info.items || github.enabled || gitlab.error || (gitlab.status && gitlab.status.state !== "off") ? (
					<SettingsGroup
						id="settings-integrations"
						title="Integrations"
						lede={
							info?.items
								? "Where agents find your code, and the places work items can be filed from."
								: "Where agents find your code."
						}
					>
						<LinksProvider key={`linked-${auth.profile.uid}`} enabled={!!info?.items}>
							<LinkNotice />
							<GithubSettings />
							<GitlabSettings connection={gitlab} />
							{info?.items ? <LinearSettings /> : null}
							{info?.items ? <JiraSettings /> : null}
							{info?.items ? <SlackSettings key={auth.profile.uid} /> : null}
						</LinksProvider>
						{info?.items ? <ApiTokens /> : null}
					</SettingsGroup>
				) : null}
			</SettingsLayout>
		</main>
	);
}

function SessionSettings() {
	const { client, signOut, explain } = useApp();
	const auth = useAuth();
	const [confirm, setConfirm] = useState(false);
	const [revokeApiTokens, setRevokeApiTokens] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function revoke() {
		setBusy(true);
		setError(null);
		try {
			await client.user(auth).signOutEverywhere({ revokeApiTokens });
			signOut("You signed out everywhere.");
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	}
	return (
		<section className="settings-row" aria-label="Sign out">
			<span className="settings-row-text">Signed in on this device</span>
			<button
				type="button"
				className="button button-outline button-small settings-row-end"
				onClick={() => {
					setError(null);
					setRevokeApiTokens(true);
					setConfirm(true);
				}}
			>
				Sign out everywhere
			</button>
			{confirm && (
				<Dialog
					title="Sign out everywhere?"
					size="small"
					dismissable={!busy}
					onClose={() => setConfirm(false)}
					footer={
						<>
							<button
								type="button"
								className="button button-quiet"
								disabled={busy}
								onClick={() => setConfirm(false)}
								data-autofocus
							>
								Cancel
							</button>
							<button type="button" className="button button-danger" disabled={busy} onClick={revoke}>
								{busy ? "Signing out…" : "Sign out everywhere"}
							</button>
						</>
					}
				>
					<p>
						You’ll need to sign in again on every device, including this one. Your running agents will keep working.
					</p>
					<p>
						Paired machines keep working. You can remove them on the{" "}
						<a className="link" {...linkProps({ name: "machines" })}>
							Machines
						</a>{" "}
						page.
					</p>
					<Check
						checked={revokeApiTokens}
						disabled={busy}
						onChange={setRevokeApiTokens}
						label="Also revoke all API tokens"
					/>
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
