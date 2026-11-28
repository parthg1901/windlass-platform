/**
 * A repository's network list, on its settings page: the hosts its hosted sandboxes may reach besides
 * the platform's and the deployment's (server/src/repository-network.ts). Presets as checkboxes, exact
 * host names one by one, the hosts its agents' commands asked for and could not reach (requests), and
 * a reading of the repository's files that proposes hosts with where each was found.
 *
 * Nothing here is applied without its person's click: a proposal names what a file in the repository
 * says, and a request what a command looked up, and either could be a host chosen to send data to.
 * Each change saves the whole list; a running sandbox gets it at its next turn (from a session's
 * timeline, "Allow for this repository" changes that session's sandbox at once while a turn runs in it).
 */
import {
	type GithubId,
	type NetworkPreset,
	type NetworkProposal,
	type NetworkScan,
	type RepositoryNetwork,
	WIDE_HOSTS,
} from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { absoluteTime, plural } from "../lib/format";
import { useApp, useAuth } from "../state/app";
import { WarnIcon } from "./Icons";
import { Check } from "./ui/Check";
import { LoadError, Loading, SkeletonLines } from "./ui";

/** What the deployment's hosted sandboxes do with the list, in a sentence. */
function appliesHere(network: RepositoryNetwork): string {
	const hosted = network.hosted;
	if (!hosted) return "Host lists are unavailable here.";
	if (hosted.mode === "open") return "Hosted agents can reach any host. This list applies when access is restricted.";
	if (hosted.mode === "none") return "Hosted agents can only reach the model API.";
	return "What hosted agents can reach.";
}

/** What allowing any of these hosts reaches besides what was asked for, said where the click is: none for most. */
export function WideHostNote({ hosts }: { hosts: readonly string[] }) {
	const said = hosts.flatMap(host => (WIDE_HOSTS[host] ? [WIDE_HOSTS[host]] : []));
	if (said.length === 0) return null;
	return (
		<p className="server-subject tone-warn">
			<WarnIcon size={13} /> {said.join(" ")}
		</p>
	);
}

/** One host or preset the scan found: what it is, what it reaches when it is a preset, and where the files name it. */
export function ProposalItem({
	proposal,
	preset,
	busy,
	onAllow,
}: {
	proposal: NetworkProposal;
	preset: NetworkPreset | undefined;
	busy: string | null;
	onAllow(proposal: NetworkProposal): void;
}) {
	return (
		<li className="server">
			<p className="server-head">
				<span className="server-name" title={preset?.about}>
					{proposal.entry}
				</span>
				{proposal.entry.startsWith("@") ? <span className="server-state">{proposal.hosts.join(", ")}</span> : null}
			</p>
			<WideHostNote hosts={proposal.hosts} />
			<p className="server-subject">{proposal.sources.join(" · ")}</p>
			<p className="server-foot">
				<button
					type="button"
					className="link"
					onClick={() => onAllow(proposal)}
					disabled={busy !== null}
					aria-label={`Allow ${proposal.entry}`}
				>
					{busy === `proposal:${proposal.entry}` ? "Allowing…" : "Allow"}
				</button>
			</p>
		</li>
	);
}

const ago = (at: number, now: number) => {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export function NetworkSection({
	repositoryId,
	name,
	labelledBy,
	onSaved,
}: {
	repositoryId: GithubId;
	name: string;
	labelledBy: string;
	onSaved?(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const ids = { host: useId(), hostNote: useId() };
	const [network, setNetwork] = useState<RepositoryNetwork | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [said, setSaid] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
	const [host, setHost] = useState("");
	const [scan, setScan] = useState<NetworkScan | null>(null);
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);

	const load = useCallback(() => {
		let current = true;
		setLoadError(null);
		client
			.user(auth)
			.repositoryNetwork(repositoryId)
			.then(
				read => current && setNetwork(read),
				(failure: unknown) => current && setLoadError(explain(failure)),
			);
		return () => {
			current = false;
		};
	}, [client, auth, repositoryId, explain]);
	useEffect(() => load(), [load]);

	const save = async (entries: string[], what: string) => {
		if (busy !== null) return false;
		setBusy(what);
		setSaid(null);
		try {
			setNetwork(await client.user(auth).saveRepositoryNetwork(repositoryId, entries));
			setSaid({ tone: "good", text: "Saved." });
			onSaved?.();
			return true;
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
			return false;
		} finally {
			setBusy(null);
		}
	};

	const dismiss = async (requested: string) => {
		if (busy !== null) return;
		setBusy(`dismiss:${requested}`);
		setSaid(null);
		try {
			setNetwork(await client.user(auth).dismissNetworkRequest(repositoryId, requested));
		} catch (failure) {
			setSaid({ tone: "bad", text: explain(failure) });
		} finally {
			setBusy(null);
		}
	};

	const look = async () => {
		setScanning(true);
		setScanError(null);
		try {
			setScan(await client.user(auth).scanRepositoryNetwork(repositoryId));
		} catch (failure) {
			setScanError(explain(failure));
		} finally {
			setScanning(false);
		}
	};

	if (network === null) {
		return loadError ? (
			<LoadError inline error={loadError} reload={load} />
		) : (
			<Loading label="Loading the network list">
				<SkeletonLines title={false} />
			</Loading>
		);
	}

	const entries = network.entries;
	const presetIds = new Set(network.presets.map(preset => preset.id));
	const singles = entries.filter(entry => !presetIds.has(entry));
	const always = new Set(network.hosted?.mode === "restricted" ? network.hosted.hosts : []);
	const has = (entry: string) => entries.includes(entry);
	const toggle = (id: string, on: boolean) =>
		void save(on ? [...entries, id] : entries.filter(entry => entry !== id), id);
	const add = async () => {
		const typed = host.trim().toLowerCase().replace(/\.$/, "");
		if (typed === "") return;
		if (await save([...entries, typed], "add")) setHost("");
	};
	const allowProposal = async (proposal: NetworkProposal) => {
		if (await save([...entries, proposal.entry], `proposal:${proposal.entry}`))
			setScan(current =>
				current ? { ...current, proposals: current.proposals.filter(item => item.entry !== proposal.entry) } : current,
			);
	};
	const now = Date.now();

	return (
		<>
			<p className="usage-lede">{appliesHere(network)}</p>
			<div className="repo-form">
				<fieldset className="repo-network-presets" aria-labelledby={labelledBy}>
					<legend className="label">Presets</legend>
					{network.presets.map(preset => {
						const on = has(preset.id);
						const everywhere = preset.hosts.every(presetHost => always.has(presetHost));
						return (
							<Check
								key={preset.id}
								checked={on || everywhere}
								disabled={busy !== null || everywhere}
								onChange={on => toggle(preset.id, on)}
							>
								<span className="check-name" title={preset.about}>
									{preset.name} <code className="repo-network-id">{preset.id}</code>
								</span>
								<span className="check-means">
									{everywhere ? (
										"Allowed for every sandbox of this deployment."
									) : (
										<>
											{preset.hosts.map((presetHost, index) => (
												<span key={presetHost}>
													{index > 0 ? ", " : null}
													<HostName host={presetHost} />
												</span>
											))}
										</>
									)}
								</span>
							</Check>
						);
					})}
				</fieldset>

				<div className="field">
					<label className="label" htmlFor={ids.host}>
						Hosts
					</label>
					{singles.length > 0 ? (
						<ul className="repo-network-hosts" aria-label={`Hosts allowed for ${name}`}>
							{singles.map(single => (
								<li key={single} className="repo-network-host">
									<code title={WIDE_HOSTS[single]}>{single}</code>
									<button
										type="button"
										className="link"
										onClick={() =>
											void save(
												entries.filter(entry => entry !== single),
												`remove:${single}`,
											)
										}
										disabled={busy !== null}
										aria-label={`Remove ${single}`}
									>
										{busy === `remove:${single}` ? "Removing…" : "Remove"}
									</button>
								</li>
							))}
						</ul>
					) : null}
					<div className="repo-network-add">
						<input
							id={ids.host}
							className="input"
							value={host}
							placeholder="registry.example.com"
							spellCheck={false}
							autoCapitalize="off"
							aria-describedby={ids.hostNote}
							onChange={event => setHost(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Enter") {
									event.preventDefault();
									void add();
								}
							}}
							readOnly={busy !== null}
						/>
						<button
							type="button"
							className="button button-outline"
							onClick={() => void add()}
							disabled={busy !== null || host.trim() === ""}
						>
							{busy === "add" ? "Adding…" : "Add"}
						</button>
					</div>
					<p className="field-note" id={ids.hostNote}>
						Exact host names only, no wildcards. {network.hosts.length} of {network.limit}.
					</p>
				</div>
				{said ? (
					<p className={`field-note tone-${said.tone}`} role={said.tone === "bad" ? "alert" : "status"}>
						{said.text}
					</p>
				) : null}
			</div>

			{network.requests.length > 0 ? (
				<>
					<h3 className="repo-network-subtitle">Asked for by its agents</h3>
					<p className="usage-note">
						A command in one of {name}'s sandboxes looked these up and could not reach them. The agent and the
						repository's scripts choose what a command looks up: allow only a host you expect.
					</p>
					<ul className="servers repo-network-requests" aria-label={`Hosts the agents on ${name} could not reach`}>
						{network.requests.map(request => (
							<li key={request.host} className="server">
								<p className="server-head">
									<span className="server-name">{request.host}</span>
									<span className="server-state">
										<time dateTime={new Date(request.at).toISOString()} title={absoluteTime(request.at)}>
											{ago(request.at, now)}
										</time>
									</span>
								</p>
								<WideHostNote hosts={[request.host]} />
								<p className="server-foot">
									<button
										type="button"
										className="link"
										onClick={() => void save([...entries, request.host], `request:${request.host}`)}
										disabled={busy !== null}
										aria-label={`Allow ${request.host}`}
									>
										{busy === `request:${request.host}` ? "Allowing…" : "Allow"}
									</button>
									<button
										type="button"
										className="link"
										onClick={() => void dismiss(request.host)}
										disabled={busy !== null}
										aria-label={`Dismiss ${request.host}`}
									>
										{busy === `dismiss:${request.host}` ? "Dismissing…" : "Dismiss"}
									</button>
								</p>
							</li>
						))}
					</ul>
				</>
			) : null}

			<h3 className="repo-network-subtitle">Found in the repository</h3>
			<p className="usage-note">Find hosts this repository needs. Nothing is allowed until you allow it.</p>
			<p className="repo-forget">
				<button
					type="button"
					className="button button-outline button-small"
					onClick={() => void look()}
					disabled={scanning}
				>
					{scanning ? "Reading the files…" : scan ? "Read them again" : "Look for hosts in the repository"}
				</button>
			</p>
			{scanError ? (
				<p className="panel-empty tone-bad" role="alert">
					<WarnIcon size={13} /> {scanError}
				</p>
			) : null}
			{scan ? (
				scan.proposals.length === 0 ? (
					<p className="usage-empty">
						{plural(scan.files, "file")} read{scan.branch ? ` on ${scan.branch}` : ""}: nothing they name is out of
						reach.{scan.incomplete ? " Not every file was read, so something may be missing." : ""}
					</p>
				) : (
					<>
						<ul className="servers repo-network-proposals" aria-label={`Hosts found in ${name}'s files`}>
							{scan.proposals.map(proposal => (
								<ProposalItem
									key={proposal.entry}
									proposal={proposal}
									preset={network.presets.find(preset => preset.id === proposal.entry)}
									busy={busy}
									onAllow={chosen => void allowProposal(chosen)}
								/>
							))}
						</ul>
						<p className="usage-note">
							{plural(scan.files, "file")} read{scan.branch ? ` on ${scan.branch}` : ""}
							{scan.commit ? ` at ${scan.commit.slice(0, 7)}` : ""}.
							{scan.incomplete ? " Not every file was read, so something may be missing." : ""}
						</p>
					</>
				)
			) : null}

			{always.size > 0 ? <p className="usage-note">Always reachable here: {[...always].join(", ")}.</p> : null}
		</>
	);
}

/** A host name that wraps only after its dots, never inside a label ("playwright.download.prss.microsoft.com"). */
function HostName({ host }: { host: string }) {
	const labels = host.split(".");
	return (
		<span>
			{labels.map((label, index) => (
				<span key={index}>
					{label}
					{index < labels.length - 1 ? (
						<>
							.<wbr />
						</>
					) : null}
				</span>
			))}
		</span>
	);
}
