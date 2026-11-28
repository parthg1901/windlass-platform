import type { RepositoryAutonomy, RepositoryView } from "@contract";
import { useEffect, useState } from "react";
import { ChecksEditor } from "../components/Checks";
import { RepositoryOverrides } from "../components/RunSettings";
import {
	SettingsGroup,
	SettingsLayout,
	SettingsPending,
	SettingsRefreshError,
	SettingsSection,
} from "../components/SettingsGroups";
import { EnvironmentSection } from "../components/Environments";
import { Dialog } from "../components/Dialog";
import { WarnIcon } from "../components/Icons";
import { NetworkSection } from "../components/Network";
import { SettingsSecrets } from "../components/Secrets";
import { RepositoryApprovals } from "../components/Servers";
import { SetupEditor } from "../components/SetupCommand";
import { ownAgents } from "../lib/repositories";
import { runOf } from "../lib/run";
import { sectionOf, useHash } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { useAccount, useNow } from "../state/hooks";
import type { RepositoryPage } from "./Repository";
import { Check } from "../components/ui/Check";

/** Repository permission for work item screenshots, read by each agent at its next turn. */
export function ScreenshotsSetting({
	page,
	view,
}: {
	page: Pick<RepositoryPage, "id" | "replace">;
	view: RepositoryView;
}) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const on = view.defaults.screenshots;
	// WLP_FACTORY_SCREENSHOTS=off: no work item takes screenshots, whatever is saved here. A saved "on" can still be turned off.
	const deploymentOff = platform.info?.items?.screenshots === false;
	const set = async (screenshots: boolean) => {
		if (busy) return;
		setBusy(true);
		setSaid(null);
		try {
			const defaults = await client.user(auth).saveRepositoryDefaults(page.id, { screenshots });
			page.replace({ ...view, defaults });
			setSaid({ tone: "good", text: "Saved." });
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="usage-section repo-saved repo-screenshots" aria-labelledby="repo-screenshots">
			<h3 className="usage-title" id="repo-screenshots">
				Screenshots
			</h3>
			<p className="usage-lede">Builders and reviewers can attach screenshots of the app.</p>
			<div className="repo-form">
				<Check checked={on} disabled={busy || (deploymentOff && !on)} onChange={on => set(on)}>
					<span className="check-name">Allow screenshots for work items</span>
					<span className="check-means">
						{deploymentOff
							? "Screenshots are turned off for this deployment."
							: "For features, only subtasks marked in the plan get a browser."}
					</span>
				</Check>
				{said ? (
					<p className={`field-note tone-${said.tone}`} role={said.tone === "bad" ? "alert" : "status"}>
						{said.text}
					</p>
				) : null}
			</div>
		</section>
	);
}

function AutonomySettings({ page, view }: { page: RepositoryPage; view: RepositoryView }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	async function save(field: keyof RepositoryAutonomy, on: boolean) {
		setBusy(true);
		setError("");
		try {
			const defaults = await client.user(auth).saveRepositoryDefaults(page.id, { [field]: on });
			page.replace({ ...view, defaults });
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}
	return (
		<SettingsSection id="repo-autonomy" title="Work item approvals">
			<div className="repo-form">
				<Check checked={!!view.defaults.autoApprovePlans} disabled={busy} onChange={on => save("autoApprovePlans", on)}>
					<span className="check-name">Auto-approve small plans</span>
					<span className="check-means">
						Up to three subtasks. A reviewer must accept the recommended answer to every open question.
					</span>
				</Check>
				<Check checked={!!view.defaults.autoMergeSingles} disabled={busy} onChange={on => save("autoMergeSingles", on)}>
					<span className="check-name">Auto-merge single items</span>
					<span className="check-means">
						Merge when checks, CI and review pass.
						{view.defaults.mergeKinds && " Enabled for: " + view.defaults.mergeKinds.join(", ") + "."}
					</span>
				</Check>
				<Check
					checked={!!view.defaults.waitForCiOnEachPart}
					disabled={busy}
					onChange={on => save("waitForCiOnEachPart", on)}
				>
					<span className="check-name">Wait for CI on each part</span>
					<span className="check-means">
						Require GitHub CI to pass on each part before it joins the feature branch.
					</span>
				</Check>
				{error && (
					<p className="field-note tone-bad" role="alert">
						{error}
					</p>
				)}
			</div>
		</SettingsSection>
	);
}

const hasOverrides = (view: RepositoryView) =>
	[
		view.defaults.place,
		view.defaults.machineProfile,
		view.defaults.placeFallback,
		view.defaults.harness,
		view.defaults.model,
		view.defaults.effort,
		view.defaults.reviewModel,
		view.defaults.reviewEffort,
		view.defaults.machineModel,
		view.defaults.machineEffort,
		view.defaults.profile,
		view.defaults.hostedSize,
	].some(value => value != null);

/** `agents`: the user's own agents on it; `items`: the sessions of its work items, which stay with their items. */
function ForgetDialog({
	page,
	view,
	name,
	agents,
	items,
	onClose,
	onDone,
}: {
	page: RepositoryPage;
	view: RepositoryView;
	name: string;
	agents: number;
	items: number;
	onClose(): void;
	onDone(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const parts = [
		view.saved.setup ? "the setup command" : null,
		view.saved.checks > 0 ? (view.saved.checks === 1 ? "its one check" : `its ${view.saved.checks} checks`) : null,
		view.saved.secrets > 0 ? (view.saved.secrets === 1 ? "its one secret" : `its ${view.saved.secrets} secrets`) : null,
		view.saved.network > 0 ? "its network list" : null,
		hasOverrides(view) ? "its overrides of your defaults" : null,
		view.defaults.autoApprovePlans || view.defaults.autoMergeSingles || view.defaults.waitForCiOnEachPart
			? "work item approval settings"
			: null,
		view.defaults.screenshots ? "permission to take screenshots" : null,
		view.approvals.length > 0
			? view.approvals.length === 1
				? "the remembered approval of one MCP server"
				: `the remembered approvals of ${view.approvals.length} MCP servers`
			: null,
	].filter((part): part is string => part !== null);
	const listed =
		parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

	const forget = async () => {
		setBusy(true);
		setError(null);
		try {
			page.replace(await client.user(auth).forgetRepository(page.id));
			onDone();
			onClose();
		} catch (failure) {
			setError(explain(failure));
			setBusy(false);
		}
	};

	return (
		<Dialog
			title="Delete what is saved?"
			size="small"
			onClose={onClose}
			dismissable={!busy}
			footer={
				<>
					<button type="button" className="button button-quiet" onClick={onClose} disabled={busy}>
						Keep it
					</button>
					<button type="button" className="button button-danger" onClick={forget} disabled={busy}>
						{busy ? "Deleting…" : "Delete"}
					</button>
				</>
			}
		>
			<p>
				What you saved for <strong>{name}</strong> is deleted: {listed}. This cannot be undone; a secret's value cannot
				be read back from here, so keep a copy of any you still need.
			</p>
			{agents + items > 0 ? (
				<p>
					{[
						agents === 0 ? null : agents === 1 ? "The agent on it" : `The ${agents} agents on it`,
						items === 0 ? null : items === 1 ? "the agent of its work item" : `the agents of its ${items} work items`,
					]
						.filter(part => part !== null)
						.join(" and ")
						.replace(/^t/, "T")}{" "}
					{agents + items === 1 ? "stays" : "stay"}, with{" "}
					{agents + items === 1 ? "its conversation and its workspace" : "their conversations and their workspaces"}. A
					sandbox made after this is set up without them, and {agents + items === 1 ? "its" : "their"} MCP servers are
					asked about again.
				</p>
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

export function RepositorySettings({ page }: { page: RepositoryPage }) {
	const { client, platform } = useApp();
	const auth = useAuth();
	const account = useAccount();
	const now = useNow(15_000);
	const [forgetting, setForgetting] = useState(false);
	// Remount the editors after a reset so they discard their old values.
	const [generation, setGeneration] = useState(0);
	const { view, sessions } = page;
	const name = page.name ?? `Repository ${page.id}`;
	const info = platform.info;
	const hostedProfile = runOf({
		account: account.settings?.defaults,
		repository: view?.defaults,
		item: { place: "hosted" },
	}).profile;
	const secretsProfile = info?.profiles.some(p => p.id === hostedProfile && p.available) ? hostedProfile : null;
	const anything =
		view !== null &&
		(view.saved.setup ||
			view.saved.checks > 0 ||
			view.saved.secrets > 0 ||
			view.saved.network > 0 ||
			hasOverrides(view) ||
			view.defaults.screenshots ||
			view.defaults.autoApprovePlans ||
			view.defaults.autoMergeSingles ||
			view.defaults.waitForCiOnEachPart ||
			view.approvals.length > 0);

	// Opened at a section: it is gone to once the sections stand, which is when what is saved was read. The sections
	// above it read their own lists after that and grow: it is kept in view while they do, until its person scrolls.
	const loaded = view !== null;
	const section = sectionOf(useHash());
	useEffect(() => {
		const heading = loaded && section ? document.getElementById(`repo-${section}`) : null;
		if (!heading) return;
		const go = () => heading.scrollIntoView({ block: "start" });
		go();
		const keep = new ResizeObserver(go);
		keep.observe(document.body);
		const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
		const stop = () => {
			keep.disconnect();
			for (const event of events) removeEventListener(event, stop);
		};
		for (const event of events) addEventListener(event, stop, { passive: true });
		const timer = setTimeout(stop, 3000);
		return () => {
			clearTimeout(timer);
			stop();
		};
	}, [loaded, section]);

	if (view === null)
		return <SettingsPending subject="What is saved for this repository" error={page.error} reload={page.reload} />;

	return (
		<>
			{page.error && <SettingsRefreshError error={page.error} reload={page.reload} />}
			<SettingsLayout label="Repository settings sections">
				<SettingsGroup
					id="repo-group-items"
					title="Work items"
					lede="What builders and reviewers may do by themselves."
				>
					<ScreenshotsSetting page={page} view={view} />
					<AutonomySettings page={page} view={view} />
				</SettingsGroup>

				<SettingsGroup
					id="repo-group-workspace"
					title="Workspace"
					lede="How an agent's workspace is prepared and checked."
				>
					<SettingsSection id="repo-setup" title="Setup command">
						<div className="repo-form">
							<SetupEditor
								compact
								key={generation}
								repositoryId={page.id}
								name={name}
								labelledBy="repo-setup"
								applies="Changes apply to new workspaces."
								onSaved={page.reload}
							/>
						</div>
					</SettingsSection>

					<SettingsSection id="repo-checks" title="Checks" count={view.saved.checks}>
						<div className="repo-form">
							<ChecksEditor
								key={generation}
								repositoryId={page.id}
								name={name}
								labelledBy="repo-checks"
								onSaved={page.reload}
							/>
						</div>
					</SettingsSection>

					<SettingsSection id="repo-environment" title="Environment">
						<p className="usage-lede">Windlass keeps a ready copy of this repository for faster starts.</p>
						<EnvironmentSection key={generation} repositoryId={page.id} labelledBy="repo-environment" />
					</SettingsSection>
				</SettingsGroup>

				<SettingsGroup id="repo-group-access" title="Access" lede={`What agents on ${name} can reach.`}>
					<SettingsSection id="repo-network" title="Network" count={view.saved.network}>
						<NetworkSection
							key={generation}
							repositoryId={page.id}
							name={name}
							labelledBy="repo-network"
							onSaved={page.reload}
						/>
					</SettingsSection>

					<SettingsSecrets
						key={generation}
						repository={{ id: page.id, name, count: view.saved.secrets }}
						profile={secretsProfile}
						onChanged={page.reload}
					/>

					<SettingsSection id="repo-servers" title="MCP server approvals" count={view.approvals.length}>
						<RepositoryApprovals
							repositoryId={page.id}
							name={name}
							approvals={view.approvals}
							forgetting={view.forgetting}
							now={now}
							onChanged={page.replace}
						/>
					</SettingsSection>
				</SettingsGroup>

				<SettingsGroup
					id="repo-group-runs"
					title="Overrides"
					lede={`${name} runs where your defaults say, with your default agent. Override either here for this repository only.`}
				>
					<RepositoryOverrides
						account={account}
						defaults={view.defaults}
						save={change => client.user(auth).saveRepositoryDefaults(page.id, change)}
						onSaved={next => page.replace({ ...view, defaults: next })}
					/>
				</SettingsGroup>

				<SettingsGroup id="repo-group-reset" title="Reset">
					<section className="usage-section" aria-labelledby="repo-forget">
						<h3 className="usage-title" id="repo-forget">
							Delete what is saved
						</h3>
						<p className="usage-lede">
							{anything
								? `Deletes everything saved for ${name} at once: setup, checks, network, secrets, overrides and approvals. Its agents stay.`
								: `Nothing is saved for ${name}.`}
						</p>
						{anything ? (
							<p className="repo-forget">
								<button
									type="button"
									className="button button-outline button-small"
									onClick={() => setForgetting(true)}
								>
									Delete what is saved…
								</button>
							</p>
						) : null}
					</section>
				</SettingsGroup>
			</SettingsLayout>

			{forgetting ? (
				<ForgetDialog
					page={page}
					view={view}
					name={name}
					agents={ownAgents(sessions ?? []).length}
					items={(sessions ?? []).length - ownAgents(sessions ?? []).length}
					onClose={() => setForgetting(false)}
					onDone={() => setGeneration(count => count + 1)}
				/>
			) : null}
		</>
	);
}
