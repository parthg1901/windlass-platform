/**
 * Settings: the Linear integration. The owner connects a workspace through Linear's OAuth, then maps a team
 * to one repository they can push to. An issue of a mapped team that gains a Windlass filing label, or is
 * assigned to the Windlass app user, is filed as a work item.
 *
 * The signed-in user redeems the ticket returned by the OAuth callback.
 */
import type { GithubRepository, LinearStatus, LinearTeam } from "@contract";
import { useEffect, useId, useRef, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";
import { LinkLine, useLinks, useReportConnection, useUnlinkItems } from "./LinkedAccounts";
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

const RETURN = /^#linear(?:-error)?=/;

const ERRORS: Record<string, string> = {
	access_denied: "Linear was not given access, so nothing is connected.",
	state: "That connection attempt expired. Connect again.",
};

export function LinearSettings() {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const ids = { team: useId(), repository: useId() };
	const [status, setStatus] = useState<LinearStatus | null>(null);
	const [teams, setTeams] = useState<LinearTeam[] | null>(null);
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [connected, setConnected] = useState(false);
	const [teamId, setTeamId] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	const [repositoryProblem, setRepositoryProblem] = useState<string | null>(null);
	const repositorySelect = useRef<HTMLSelectElement>(null);
	// A return to the page already open (only its fragment changes) is read again.
	const returned = useReturnRound(RETURN);
	const links = useLinks();
	const ensureLinked = links?.ensureLinked;
	const unlinkItems = useUnlinkItems("linear");

	useEffect(() => {
		const back = /^#(linear|linear-error)=(.+)$/.exec(location.hash);
		if (!back) return;
		history.replaceState(null, "", location.pathname + location.search);
		const [, kind, value] = back;
		if (kind === "linear-error") {
			setError(
				ERRORS[value === "denied" ? "access_denied" : value!] ?? `Linear could not be connected (${value}). Try again.`,
			);
			return;
		}
		void client
			.user(auth)
			.linearComplete(value!)
			.then(
				next => {
					setConnected(true);
					// Linear's connection acts as the app, not as you: a read-only sign-in as yourself links you too.
					if (next.state === "connected") ensureLinked?.("linear", next.connection.workspace.id);
				},
				failure => setError(explain(failure)),
			);
	}, [client, auth, explain, returned, ensureLinked]);

	useEffect(() => {
		let live = true;
		(async () => {
			try {
				const api = client.user(auth);
				const next = await api.linear();
				if (!live) return;
				setStatus(next);
				if (next.state !== "connected") return;
				const list = await api.linearTeams();
				if (!live) return;
				setTeams(list.teams);
				// A GitHub problem leaves the connection and its teams on show: only choosing a repository needs GitHub.
				const repos = platform.info?.github
					? await api
							.githubRepositories("")
							.then(found => found.repositories)
							.catch((failure: unknown) => explain(failure))
					: [];
				if (!live) return;
				if (typeof repos === "string") setRepositoryProblem(repos);
				else setRepositories(repos);
			} catch (failure) {
				if (live) setFailed(explain(failure));
			}
		})();
		return () => {
			live = false;
		};
	}, [client, auth, explain, platform.info?.github, connected]);

	const run = async (work: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	};
	const connect = () =>
		run(async () => {
			const { url } = await client.user(auth).linearConnect({ origin: location.origin });
			location.assign(url);
		});
	const save = () =>
		run(async () => {
			const list = await client.user(auth).saveLinearMapping({ teamId, repositoryId: Number(repositoryId) });
			setTeams(list.teams);
			setTeamId("");
			setRepositoryId("");
		});
	const disconnect = () => {
		if (
			!confirm(
				"Disconnect Linear? Its team mappings are removed and nothing more is filed from Linear. Items already filed stay.",
			)
		)
			return;
		void run(async () => {
			setStatus(await client.user(auth).disconnectLinear());
			setConnected(false);
			setTeams(null);
		});
	};
	const remove = (team: LinearTeam) =>
		run(async () => setTeams((await client.user(auth).removeLinearMapping(team.id)).teams));

	const workspaceId = status?.state === "connected" ? status.connection.workspace.id : null;
	useReportConnection("linear", workspaceId);
	if (status?.state === "off") return null;
	const ready = teamId !== "" && repositoryId !== "";
	const unmapped = teams?.filter(team => !team.mapping) ?? [];
	const canMap = !repositoryProblem && teams !== null && repositories !== null && unmapped.length > 0;
	return (
		<IntegrationCard
			id="settings-linear"
			provider="linear"
			name="Linear"
			what={
				<>
					File work items from Linear issues labelled <code>windlass</code>.
				</>
			}
			state={
				status === null
					? failed
						? "disconnected"
						: "loading"
					: status.state === "connected"
						? "connected"
						: "disconnected"
			}
			testId="linear-settings"
			action={
				status?.state === "disconnected" ? (
					<button
						type="button"
						className="button button-outline button-small"
						onClick={() => void connect()}
						disabled={busy}
					>
						{busy ? "Connecting…" : "Connect Linear…"}
					</button>
				) : null
			}
			more={[
				...unlinkItems,
				...(status?.state === "connected"
					? [{ id: "disconnect", label: "Disconnect…", tone: "warn" as const, disabled: busy, onSelect: disconnect }]
					: []),
			]}
		>
			<LinkLine surface="linear" tenant={workspaceId} />
			{connected && status?.state === "connected" ? (
				<p className="callout" role="status">
					Linear is connected. Choose a repository for a team below.
				</p>
			) : null}
			{failed ? (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{failed}</span>
				</p>
			) : status === null ? (
				<div className="usage-loading" aria-busy="true" aria-label="Loading Linear">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			) : status.state === "connected" ? (
				<>
					<IntegrationFacts
						testId="linear-workspace"
						facts={[
							["Workspace", status.connection.workspace.name],
							["Connected as", status.connection.user.name],
						]}
					/>
					<details className="integration-details">
						<summary>How filing works</summary>
						Label an issue <code>windlass</code> or assign it to Windlass, then review and start the draft here. Use{" "}
						<code>windlass-quick</code> or <code>windlass:quick</code> for Quick mode.
					</details>
					{teams === null ? (
						<div className="usage-loading" aria-busy="true" aria-label="Loading teams">
							<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
						</div>
					) : (
						<MappingList label="Teams">
							{teams.map(team => (
								<MappingRow
									key={team.id}
									testId={`linear-team-${team.key}`}
									from={team.name}
									fromNote={team.key}
									to={
										team.mapping ? (
											<MappedRepository owner={team.mapping.repository.owner} name={team.mapping.repository.name} />
										) : null
									}
									unmapped="Not mapped · its issues are ignored"
									busy={busy}
									onRemove={team.mapping ? () => void remove(team) : undefined}
									removeLabel={`Remove the mapping of ${team.name}`}
									onChange={
										!team.mapping && canMap
											? () => {
													setTeamId(team.id);
													repositorySelect.current?.focus();
												}
											: undefined
									}
									changeLabel={`Map ${team.name} to a repository`}
								/>
							))}
						</MappingList>
					)}
					{repositoryProblem ? (
						<p className="usage-note tone-warn">
							{repositoryProblem} A team can be mapped once your repositories load.
						</p>
					) : canMap ? (
						<MappingForm
							title="Map a team"
							from={
								<>
									<label className="visually-hidden" htmlFor={ids.team}>
										Team
									</label>
									<select
										id={ids.team}
										className="select"
										value={teamId}
										onChange={event => setTeamId(event.target.value)}
										disabled={busy}
									>
										<option value="">Choose a team</option>
										{unmapped.map(team => (
											<option key={team.id} value={team.id}>
												{team.name} ({team.key})
											</option>
										))}
									</select>
								</>
							}
							to={
								<>
									<label className="visually-hidden" htmlFor={ids.repository}>
										Repository
									</label>
									<select
										ref={repositorySelect}
										id={ids.repository}
										className="select"
										value={repositoryId}
										onChange={event => setRepositoryId(event.target.value)}
										disabled={busy}
									>
										<option value="">Choose a repository</option>
										{repositories!.map(repository => (
											<option key={repository.id} value={String(repository.id)}>
												{repository.owner}/{repository.name}
											</option>
										))}
									</select>
								</>
							}
							submit={
								<button
									type="button"
									className="button button-outline"
									onClick={() => void save()}
									disabled={!ready || busy}
								>
									Map team
								</button>
							}
							note={
								<p className="field-note">
									A team files to one repository you can push to. Removing a mapping, or unlabelling or unassigning an
									issue, does not change items already filed.
								</p>
							}
						/>
					) : null}
				</>
			) : (
				<IntegrationSteps
					steps={[
						"Connect your Linear workspace.",
						"Map a team to a repository.",
						<>
							Label an issue <code>windlass</code>: it is filed here as a draft.
						</>,
					]}
				/>
			)}
			{error ? (
				<p className="callout callout-bad" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			) : null}
		</IntegrationCard>
	);
}
