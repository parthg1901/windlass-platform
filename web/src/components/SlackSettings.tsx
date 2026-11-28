import type { GithubRepository, SlackChannel, SlackStatus } from "@contract";
import { useEffect, useRef, useState } from "react";
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
import { ProviderIcon } from "./ProviderIcon";
import { Check } from "./ui";

const RETURN = /^#slack(?:-error|-link)?=/;

const callbackErrors = new Map([
	["denied", "Slack was not given access. Connect again when you’re ready."],
	["state", "That connection attempt expired. Connect Slack again."],
]);

export function SlackSettings() {
	const { client, explain, platform } = useApp();
	const auth = useAuth();
	const [status, setStatus] = useState<SlackStatus | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [channels, setChannels] = useState<SlackChannel[] | null>(null);
	const [channel, setChannel] = useState("");
	const [repositoryId, setRepositoryId] = useState("");
	const [repositories, setRepositories] = useState<GithubRepository[] | null>(null);
	const [repoProblem, setRepoProblem] = useState("");
	const [proof, setProof] = useState("");
	const card = useRef<HTMLElement>(null);
	const repoSelect = useRef<HTMLSelectElement>(null);
	const confirmLink = useRef<HTMLButtonElement>(null);
	const showReturn = useRef(false);
	const initial = useRef<Promise<SlackStatus> | null>(null);
	// A return to the page already open (only its fragment changes) is read again.
	const returned = useReturnRound(RETURN);
	const initialRound = useRef(returned);

	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		// StrictMode may replay this effect, but a callback ticket can only be redeemed once.
		if (!initial.current || initialRound.current !== returned) {
			initialRound.current = returned;
			const back = /^#(slack|slack-error|slack-link)=(.*)$/.exec(location.hash);
			if (back) {
				showReturn.current = true;
				history.replaceState(history.state, "", location.pathname + location.search);
			}
			initial.current = (async () => {
				if (back?.[1] === "slack") {
					try {
						return await api.slackComplete(back[2]!);
					} catch {
						setError("That connection could not be completed. Connect Slack again.");
					}
				} else if (back?.[1] === "slack-error") {
					setError(callbackErrors.get(back[2]!) ?? "Slack could not be connected. Try again.");
				} else if (back?.[1] === "slack-link") setProof(back[2]!);
				return api.slack();
			})();
		}
		initial.current.then(
			next => {
				if (live) setStatus(next);
			},
			failure => {
				if (live) setError(explain(failure));
			},
		);
		return () => {
			live = false;
		};
	}, [client, auth, explain, returned]);

	useEffect(() => {
		if (status?.state !== "connected") return;
		let live = true;
		client
			.user(auth)
			.slackChannels()
			.then(
				list => {
					if (live) setChannels(list);
				},
				failure => {
					if (live) setError(explain(failure));
				},
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain, status?.state]);

	useEffect(() => {
		if (status?.state !== "connected" || !platform.info?.github) return;
		let live = true;
		client
			.user(auth)
			.githubRepositories("")
			.then(
				list => {
					if (live) {
						setRepositories(list.repositories.filter(repo => repo.canPush));
						setRepoProblem("");
					}
				},
				failure => {
					if (live) setRepoProblem(explain(failure));
				},
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain, status?.state, platform.info?.github]);

	useEffect(() => {
		if (!showReturn.current || (!status && !error) || !card.current) return;
		showReturn.current = false;
		card.current.scrollIntoView?.({ block: "start" });
		confirmLink.current?.focus({ preventScroll: true });
	}, [status, error]);

	async function run(work: () => Promise<void>) {
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(false);
		}
	}
	if (status?.state === "off") return null;
	const api = client.user(auth);
	const selectedChannel = channels?.find(ch => ch.id === channel);
	const repository = repositories?.find(repo => String(repo.id) === repositoryId);
	const connected = status?.state === "connected";
	return (
		<IntegrationCard
			id="settings-slack"
			provider="slack"
			name="Slack"
			what={
				<>
					File work items with <code>/windlass</code> or by mentioning Windlass in a mapped channel.
				</>
			}
			state={!status ? (error ? "disconnected" : "loading") : connected ? "connected" : "disconnected"}
			sectionRef={card}
			testId="slack-settings"
			action={
				status?.state === "disconnected" ? (
					<button
						type="button"
						className="button button-outline button-small"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								location.assign((await api.slackConnect({ origin: location.origin })).url);
							})
						}
					>
						Connect Slack…
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
									if (confirm("Disconnect Slack and remove all its channel mappings? Items already filed stay."))
										void run(async () => setStatus(await api.disconnectSlack()));
								},
							},
						]
					: []
			}
		>
			{!status && !error && (
				<div className="usage-loading" aria-busy="true" aria-label="Loading Slack">
					<span className="skeleton skeleton-meta" style={{ width: "58%" }} />
				</div>
			)}
			{status?.state === "disconnected" && (
				<>
					<IntegrationSteps
						steps={[
							"Connect your Slack workspace and invite Windlass to a channel.",
							"Map the channel to a repository.",
							<>
								Type <code>/windlass</code> and the task there: plans and questions come back in its thread.
							</>,
						]}
					/>
				</>
			)}
			{status?.state === "connected" && (
				<>
					<IntegrationFacts facts={[["Workspace", status.workspaceName]]} />
					{status.mappings.length > 0 ? (
						<MappingList label="Mapped channels">
							{status.mappings.map(mapping => {
								const name = channels?.find(ch => ch.id === mapping.channel.id)?.name ?? mapping.channel.name;
								return (
									<MappingRow
										key={mapping.channel.id}
										from={
											<>
												<ProviderIcon id="slack" size={12} />#{name}
											</>
										}
										to={<MappedRepository owner={mapping.repository.owner} name={mapping.repository.name} />}
										busy={busy}
										onChange={() => {
											setChannel(mapping.channel.id);
											setRepositoryId(String(mapping.repository.id));
											repoSelect.current?.focus();
										}}
										changeLabel={`Change mapping for ${name}`}
										onRemove={() => void run(async () => setStatus(await api.removeSlackMapping(mapping.channel.id)))}
										removeLabel={`Remove mapping for ${name}`}
										options={
											<Check
												checked={mapping.details}
												disabled={busy}
												onChange={details =>
													void run(async () =>
														setStatus(await api.setSlackDetails({ channelId: mapping.channel.id, details })),
													)
												}
												label="Post plan and question details"
											/>
										}
									/>
								);
							})}
						</MappingList>
					) : null}
					<p className="field-note">
						Invite Windlass to a channel, then choose its repository. With details on, every channel member can read
						posted plans and questions; with them off, Windlass posts links and choice buttons only.
					</p>
					{channels?.length === 0 && (
						<p className="field-note">
							No channels available. Invite Windlass to a channel, then{" "}
							<button
								type="button"
								className="link"
								disabled={busy}
								onClick={() => void run(async () => setChannels(await api.slackChannels()))}
							>
								refresh the list
							</button>
							.
						</p>
					)}
					{repoProblem && (
						<p className="callout callout-warn" role="alert">
							<WarnIcon />
							<span>{repoProblem}</span>
						</p>
					)}
					{(!platform.info?.github || repositories?.length === 0) && (
						<p className="field-note">A repository you can push to is needed to map a channel.</p>
					)}
					<MappingForm
						title="Map a channel"
						onSubmit={event => {
							event.preventDefault();
							if (repository && selectedChannel)
								void run(async () => {
									setStatus(await api.saveSlackMapping({ channelId: channel, repositoryId: repository.id }));
									setChannel("");
									setRepositoryId("");
								});
						}}
						from={
							<select
								aria-label="Slack channel"
								className="select"
								value={channel}
								onChange={event => setChannel(event.target.value)}
								disabled={busy}
							>
								<option value="">Choose a channel</option>
								{channels?.map(ch => (
									<option key={ch.id} value={ch.id}>
										#{ch.name}
									</option>
								))}
							</select>
						}
						to={
							<select
								ref={repoSelect}
								aria-label="Repository"
								className="select"
								value={repositoryId}
								onChange={event => setRepositoryId(event.target.value)}
								disabled={busy}
							>
								<option value="">Choose a repository</option>
								{repositories?.map(repo => (
									<option value={repo.id} key={repo.id}>
										{repo.owner}/{repo.name}
									</option>
								))}
							</select>
						}
						submit={
							<button className="button button-outline" disabled={!repository || !selectedChannel || busy}>
								Map channel
							</button>
						}
					/>
				</>
			)}
			{status && (
				<div className="integration-part">
					<h4 className="usage-title">Your Slack account</h4>
					{status.links.length === 0 && (
						<p className="field-note">
							Not linked. To file work as this account, open the private, one-time link Windlass sends you in Slack.
						</p>
					)}
					<ul className="settings-list" aria-label="Linked Slack identities">
						{status.links.map(link => (
							<li className="usage-kept-row" key={link.teamId}>
								<div className="usage-kept-main">
									<span className="usage-kept-title">{link.workspaceName}</span>
								</div>
								<span />
								<button
									type="button"
									className="button button-outline button-small"
									aria-label={`Unlink Slack identity in ${link.workspaceName}`}
									disabled={busy}
									onClick={() => void run(async () => setStatus(await api.unlinkSlack(link.teamId)))}
								>
									Unlink
								</button>
							</li>
						))}
					</ul>
					{proof && (
						<button
							ref={confirmLink}
							type="button"
							className="button button-outline"
							disabled={busy}
							onClick={() => {
								const ticket = proof;
								setProof("");
								void run(async () => setStatus(await api.linkSlack(ticket)));
							}}
						>
							Link Slack identity
						</button>
					)}
				</div>
			)}
			{error && (
				<p className="callout callout-warn" role="alert">
					<WarnIcon />
					<span>{error}</span>
				</p>
			)}
		</IntegrationCard>
	);
}
