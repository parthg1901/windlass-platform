import type { JiraProject, JiraSite, JiraStatus } from "@contract";
import { useEffect, useRef, useState } from "react";
import { useHash } from "../lib/router";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";
import { LoadError, Loading, Select, SkeletonLines } from "./ui";
import {
	IntegrationCard,
	IntegrationFacts,
	IntegrationSteps,
	MappedRepository,
	MappingForm,
	MappingList,
	MappingRow,
} from "./IntegrationCard";
import { LinkLine, useReportConnection, useUnlinkItems } from "./LinkedAccounts";
import { useRepositorySearch } from "./RepositoryMenu";

const callbackErrors = new Map([
	["denied", "Jira was not given access. Connect again when you’re ready."],
	["scope", "Jira did not grant the required permissions. Connect again."],
	["sites", "No Jira sites granted all the required permissions. Check your site access and connect again."],
]);

export function JiraSettings() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const hash = useHash();
	const [status, setStatus] = useState<JiraStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [siteId, setSiteId] = useState("");
	const unlinkItems = useUnlinkItems("jira");

	// StrictMode can restart the effect after the single-use fragment has been stripped.
	const redemption = useRef<{ auth: typeof auth; client: typeof client; result: Promise<JiraStatus> } | null>(null);
	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		const back = /^#(jira|jira-error)=(.*)$/.exec(location.hash);
		if (back) {
			history.replaceState(history.state, "", location.pathname + location.search);
			document.getElementById("settings-jira")?.scrollIntoView?.({ block: "center" });
			if (back[1] === "jira-error") setError(callbackErrors.get(back[2]!) ?? "Jira could not be connected. Try again.");
			else redemption.current = { auth, client, result: api.jiraComplete(back[2]!) };
		}
		const pending = redemption.current;
		const result =
			pending?.auth === auth && pending.client === client
				? pending.result.catch(failure => {
						if (live) setError(explain(failure));
						return api.jira();
					})
				: api.jira();
		void result.then(
			next => {
				if (live) {
					setStatus(next);
					redemption.current = null;
				}
			},
			failure => {
				if (live) setError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [client, auth, explain, hash]);

	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}
	// Jira's accounts are Atlassian's, one directory for every site.
	useReportConnection("jira", status?.state === "connected" ? "*" : null);
	if (status?.state === "off") return null;
	const api = client.user(auth);
	const connection = status?.state === "connected" ? status.connection : null;
	function disconnect() {
		if (!confirm("Disconnect Jira and remove its project mappings? Items already filed stay.")) return;
		void run(async () => {
			setStatus(await api.disconnectJira());
			setSiteId("");
		});
	}
	return (
		<IntegrationCard
			id="settings-jira"
			provider="jira"
			name="Jira Cloud"
			what="File drafts from Jira issues in the projects you map to repositories."
			state={!status ? (error ? "unknown" : "loading") : connection ? "connected" : "disconnected"}
			action={
				status?.state === "disconnected" ? (
					<button
						className="button button-outline button-small"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								const { url } = await api.jiraConnect({ origin: location.origin });
								location.assign(url);
							})
						}
					>
						Connect Jira…
					</button>
				) : null
			}
			more={[
				...unlinkItems,
				...(connection
					? [
							{
								id: "disconnect",
								label: "Disconnect Jira…",
								tone: "warn" as const,
								disabled: busy,
								onSelect: disconnect,
							},
						]
					: []),
			]}
		>
			<LinkLine surface="jira" />
			{!status && !error && (
				<Loading label="Loading Jira">
					<SkeletonLines title={false} lines={[58]} />
				</Loading>
			)}
			{status?.state === "disconnected" && (
				<IntegrationSteps
					steps={[
						"Connect your Atlassian account and choose a site.",
						"Map a Jira project to a repository.",
						<>
							Label an issue <code>windlass</code> or assign it to the connected account: it is filed here as a draft.
						</>,
					]}
				/>
			)}
			{connection && (
				<>
					{connection.site ? (
						<>
							<IntegrationFacts
								facts={[
									[
										"Site",
										<>
											{connection.site.name}{" "}
											<span className="faint mono">{connection.site.url.replace(/^https?:\/\//, "")}</span>
										</>,
									],
									["Connected as", connection.user.name],
								]}
							/>
							<JiraProjects key={connection.site.id} site={connection.site} busy={busy} run={run} />
						</>
					) : (
						<MappingForm
							title="Choose the Jira site to file from"
							from={
								<Select
									aria-label="Jira site"
									menuLabel="Jira site"
									value={siteId}
									onChange={setSiteId}
									disabled={busy}
									placeholder="Choose a Jira site"
									options={connection.sites.map(site => ({
										value: site.id,
										label: `${site.name} (${site.url})`,
									}))}
								/>
							}
							to={null}
							submit={
								<button
									className="button button-outline"
									disabled={busy || !siteId}
									onClick={() => void run(async () => setStatus(await api.jiraSelectSite(siteId)))}
								>
									Connect site
								</button>
							}
						/>
					)}
				</>
			)}
			{error && (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			)}
		</IntegrationCard>
	);
}

function JiraProjects({
	site,
	busy,
	run,
}: {
	site: JiraSite;
	busy: boolean;
	run: (work: () => Promise<void>) => Promise<void>;
}) {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [projects, setProjects] = useState<JiraProject[] | null>(null);
	const [projectError, setProjectError] = useState<string | null>(null);
	const [projectId, setProjectId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		void api.jiraProjects().then(
			list => {
				if (live) setProjects(list.projects);
			},
			failure => {
				if (live) setProjectError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [client, auth, explain]);
	const unmapped = projects?.filter(project => !project.mapping) ?? [];
	const { query, setQuery, found } = useRepositorySearch(!!platform.info?.github && unmapped.length > 0);
	const searching = found.loading || found.query !== query.trim() || !found.list;
	const repositories = searching ? [] : found.list!.repositories.filter(repo => repo.canPush);
	const repository = repositories.find(repo => String(repo.id) === repositoryId);
	const api = client.user(auth);
	return (
		<>
			<details className="integration-details">
				<summary>How filing works</summary>Add <code>windlass</code> or assign the issue to the Jira account shown above
				to file a draft. Use <code>windlass-quick</code> to file in Quick mode. Qualifying bugs also use Quick.
			</details>
			{projectError ? (
				<LoadError inline error={projectError} />
			) : projects === null ? (
				<Loading label="Loading Jira projects">
					<SkeletonLines title={false} lines={[58]} />
				</Loading>
			) : projects.length === 0 ? (
				<p className="usage-empty">No Jira projects found on this site.</p>
			) : (
				<MappingList label="Jira projects">
					{projects.map(project => (
						<MappingRow
							key={project.id}
							from={project.name}
							fromNote={project.key}
							to={
								project.mapping ? (
									<MappedRepository owner={project.mapping.repository.owner} name={project.mapping.repository.name} />
								) : null
							}
							unmapped="Not mapped"
							busy={busy}
							onRemove={
								project.mapping
									? () =>
											void run(async () => {
												setProjects((await api.removeJiraMapping({ siteId: site.id, projectId: project.id })).projects);
											})
									: undefined
							}
							removeLabel={`Remove the mapping of ${project.name}`}
						/>
					))}
				</MappingList>
			)}
			{found.error && (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{found.error}</span>
				</p>
			)}
			{unmapped.length > 0 &&
				(platform.info?.github ? (
					<MappingForm
						title="Map a project"
						from={
							<Select
								aria-label="Jira project"
								menuLabel="Jira project"
								disabled={busy}
								value={projectId}
								onChange={setProjectId}
								placeholder="Choose a project"
								options={unmapped.map(project => ({
									value: project.id,
									label: `${project.name} (${project.key})`,
								}))}
							/>
						}
						to={
							<Select
								aria-label="Repository"
								menuLabel="Repository"
								disabled={busy}
								value={repositoryId}
								onChange={setRepositoryId}
								placeholder="Choose a repository"
								filter={{
									placeholder: "Search repositories",
									value: query,
									onChange: next => {
										setQuery(next);
										setRepositoryId("");
									},
									busy: searching && !found.error,
								}}
								empty={
									searching
										? found.error
											? "Repositories unavailable"
											: "Searching repositories…"
										: "No writable matches"
								}
								options={repositories.map(repo => ({ value: String(repo.id), label: `${repo.owner}/${repo.name}` }))}
							/>
						}
						submit={
							<button
								className="button button-outline"
								disabled={busy || !projectId || !repository}
								onClick={() =>
									void run(async () => {
										if (!repository) return;
										setProjects(
											(await api.saveJiraMapping({ siteId: site.id, projectId, repositoryId: repository.id })).projects,
										);
										setProjectId("");
										setRepositoryId("");
										setQuery("");
									})
								}
							>
								Map project
							</button>
						}
						note={
							found.list?.more || found.list?.incomplete ? (
								<>
									{found.list?.more && <p className="field-note">Search by name to see more repositories.</p>}
									{found.list?.incomplete && (
										<p className="field-note">The repository list is partial: search to narrow it.</p>
									)}
								</>
							) : undefined
						}
					/>
				) : (
					<p className="field-note">Connect a repository you can push to before mapping a Jira project.</p>
				))}
		</>
	);
}
