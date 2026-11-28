import type { GitlabProjectList, GitlabStatus } from "@contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";
import {
	IntegrationCard,
	IntegrationFacts,
	IntegrationSteps,
	MappedRepository,
	MappingForm,
	MappingList,
	MappingRow,
	useReturnRound,
} from "./IntegrationCard";
import { BranchName } from "./BranchName";

const RETURN = /^#gitlab(?:-error)?=/;

export function useGitlabSettings() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const api = useMemo(() => client.user(auth), [client, auth]);
	const [status, setStatus] = useState<GitlabStatus | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	// A return to the page already open (only its fragment changes) is read again.
	const returned = useReturnRound(RETURN);
	// Both StrictMode subscriptions await the same one-time ticket redemption.
	const load = useMemo(() => {
		let pending: Promise<{ status: GitlabStatus; error?: string }> | undefined;
		async function read() {
			const back = /^#(gitlab|gitlab-error)=(.*)$/.exec(location.hash);
			if (!back) return { status: await api.gitlab() };
			history.replaceState(history.state, "", location.pathname + location.search);
			let message = "GitLab could not be connected. Try again.";
			if (back[1] === "gitlab") {
				try {
					return { status: await api.gitlabComplete(back[2]!) };
				} catch (failure) {
					message = explain(failure);
				}
			} else if (["access_denied", "denied"].includes(back[2]!)) message = "GitLab was not given access.";
			return { status: await api.gitlab(), error: message };
		}
		return () => (pending ??= read());
	}, [api, explain, attempt, returned]);
	useEffect(() => {
		let live = true;
		void load().then(
			result => {
				if (live) {
					setStatus(result.status);
					setError(result.error ?? null);
				}
			},
			failure => {
				if (live) setError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [load, explain]);
	return { api, status, setStatus, error, setError, reload: () => retry(n => n + 1) };
}

export function GitlabSettings({ connection }: { connection: ReturnType<typeof useGitlabSettings> }) {
	const { api, status, setStatus, error, setError, reload } = connection;
	const { explain } = useApp();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState("");
	const [list, setList] = useState<GitlabProjectList | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [attempt, retry] = useState(0);
	const [busy, setBusy] = useState(false);
	// A chosen project is a row with a Change action; the picker opens only to choose one or to change it.
	const [changing, setChanging] = useState(false);
	const search = useRef<HTMLInputElement>(null);
	const connected = status?.state === "connected";
	const picking = connected && (!status.project || changing);
	useEffect(() => {
		if (changing) search.current?.focus();
	}, [changing]);
	useEffect(() => {
		if (!picking) return;
		let live = true;
		setList(null);
		setListError(null);
		setSelected("");
		const timer = setTimeout(
			() =>
				void api.gitlabProjects(query).then(
					next => {
						if (live) setList(next);
					},
					failure => {
						if (live) setListError(explain(failure));
					},
				),
			query ? 200 : 0,
		);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [api, picking, query, explain, attempt]);
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
	if (status?.state === "off" || (!status && !error)) return null;
	const connect = () =>
		void run(async () => {
			location.assign((await api.gitlabConnect({ origin: location.origin })).url);
		});
	const reconnect = status?.state === "disconnected" && status.reconnect;
	return (
		<IntegrationCard
			id="settings-gitlab"
			provider="gitlab"
			name="GitLab"
			what="Agents work on a GitLab project and hand their work back as merge requests."
			state={!status ? "loading" : connected ? "connected" : reconnect ? "reconnect" : "disconnected"}
			action={
				status?.state === "disconnected" ? (
					<button className="button button-outline button-small" disabled={busy} onClick={connect}>
						{reconnect ? "Reconnect GitLab…" : "Connect GitLab…"}
					</button>
				) : null
			}
			more={
				connected
					? [
							{
								id: "disconnect",
								label: "Disconnect…",
								tone: "warn",
								disabled: busy,
								onSelect: () => {
									if (confirm("Disconnect GitLab and forget the selected project?"))
										void run(async () => {
											setStatus(await api.gitlabDisconnect());
											setQuery("");
										});
								},
							},
						]
					: []
			}
		>
			{error && (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>
						{error}{" "}
						{!status && (
							<button className="link" onClick={reload}>
								Try again
							</button>
						)}
					</span>
				</p>
			)}
			{status?.state === "disconnected" &&
				(reconnect ? (
					<p className="callout callout-warn" role="status">
						<WarnIcon />
						<span>GitLab no longer accepts Windlass's access. Reconnect GitLab and choose the project again.</span>
					</p>
				) : (
					<IntegrationSteps
						steps={[
							"Connect your GitLab account.",
							"Choose the project agents work on.",
							"Their work comes back as a merge request, with its pipeline read.",
						]}
					/>
				))}
			{status?.state === "connected" && (
				<>
					<IntegrationFacts
						facts={[
							["Instance", <span className="mono">{status.baseUrl.replace(/^https?:\/\//, "")}</span>],
							!status.project && ["Project", <span className="faint">No project selected</span>],
						]}
					/>
					{status.project ? (
						<div role="status">
							<MappingList label="Selected project">
								<MappingRow
									from={
										<>
											<span className="visually-hidden">Selected project: </span>
											<MappedRepository host="gitlab" owner={status.project.owner} name={status.project.name} />
										</>
									}
									to={<BranchName branch={status.project.branch} />}
									busy={busy}
									onChange={changing ? undefined : () => setChanging(true)}
									changeLabel="Change the project"
								/>
							</MappingList>
						</div>
					) : null}
					{picking ? (
						<MappingForm
							title={status.project ? "Change the project" : "Choose the project"}
							to={
								<>
									<label className="visually-hidden" htmlFor="gitlab-query">
										Search GitLab projects
									</label>
									<input
										ref={search}
										className="input"
										type="search"
										maxLength={256}
										id="gitlab-query"
										placeholder="Search projects"
										value={query}
										onChange={e => setQuery(e.target.value)}
										disabled={busy}
									/>
									<label className="visually-hidden" htmlFor="gitlab-project">
										GitLab project
									</label>
									<select
										className="select"
										id="gitlab-project"
										value={selected}
										onChange={e => setSelected(e.target.value)}
										disabled={busy || !list?.projects.length}
									>
										<option value="">
											{listError
												? "Projects unavailable"
												: !list
													? "Loading projects…"
													: !list.projects.length
														? "No matching projects"
														: "Choose a project"}
										</option>
										{list?.projects.map(p => (
											<option key={p.id} value={String(p.id)}>
												{p.owner}/{p.name}
											</option>
										))}
									</select>
								</>
							}
							submit={
								<button
									className="button button-outline"
									aria-describedby="gitlab-hook-note"
									disabled={busy || !selected || selected === String(status.project?.id)}
									onClick={() =>
										void run(async () => {
											setStatus(await api.gitlabPickProject(selected));
											setChanging(false);
										})
									}
								>
									Save project
								</button>
							}
							cancel={
								changing ? (
									<button
										className="button button-quiet"
										disabled={busy}
										onClick={() => {
											setChanging(false);
											setQuery("");
										}}
									>
										Cancel
									</button>
								) : undefined
							}
							note={
								<>
									<p className="field-note" id="gitlab-hook-note">
										Saving registers a webhook on the selected GitLab project. You need Maintainer access or higher.
									</p>
									{list?.more && <p className="field-note">Search by project name to narrow the list.</p>}
								</>
							}
						/>
					) : null}
					{listError && (
						<p className="callout callout-warn" role="alert">
							<WarnIcon />
							<span>
								{listError}{" "}
								<button className="link" onClick={() => retry(n => n + 1)}>
									Try again
								</button>
							</span>
						</p>
					)}
				</>
			)}
		</IntegrationCard>
	);
}
