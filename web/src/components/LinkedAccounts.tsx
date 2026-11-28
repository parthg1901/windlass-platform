/**
 * Settings: accounts on Slack, Linear and Jira linked to this Windlass account. Work a person files on one of those
 * surfaces is filed as theirs, so each surface's link is proved here: Slack's private one-time link and Linear's
 * sign-in come back as `#link=<ticket>`, which the user confirms.
 */
import type { LinkedAccount, LinkSurface } from "@contract";
import { useEffect, useRef, useState } from "react";
import { useApp, useAuth } from "../state/app";
import { useReturnRound } from "./IntegrationCard";

const RETURN = /^#link(?:-error)?=/;

const SURFACES: Record<LinkSurface, string> = { slack: "Slack", linear: "Linear", jira: "Jira" };

const callbackErrors = new Map([
	["denied", "Linear was not given access. Try again when you’re ready."],
	["state", "That link expired. Start again."],
	["used", "That link expired. Start again."],
]);

interface Available {
	slack: boolean;
	linear: boolean;
	jira: boolean;
}

export function LinkedAccounts() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);
	const [available, setAvailable] = useState<Available>({ slack: false, linear: false, jira: false });
	const [ticket, setTicket] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const card = useRef<HTMLElement>(null);
	const confirmLink = useRef<HTMLButtonElement>(null);
	const showReturn = useRef(false);
	const initial = useRef<{ ticket: string; error: string } | null>(null);
	// A return to the page already open (only its fragment changes) is read again.
	const returned = useReturnRound(RETURN);
	const initialRound = useRef(returned);

	useEffect(() => {
		// StrictMode may replay this effect after the fragment is gone, so read it once per return.
		if (!initial.current || initialRound.current !== returned) {
			initialRound.current = returned;
			const back = /^#(link|link-error)=(.*)$/.exec(location.hash);
			showReturn.current = !!back || location.hash === "#linked-accounts";
			if (back) history.replaceState(history.state, "", location.pathname + location.search);
			initial.current =
				back?.[1] === "link"
					? { ticket: back[2]!, error: "" }
					: back?.[1] === "link-error"
						? { ticket: "", error: callbackErrors.get(back[2]!) ?? "The account could not be linked. Try again." }
						: { ticket: "", error: "" };
		}
		setTicket(initial.current.ticket);
		if (initial.current.error) setError(initial.current.error);
	}, [returned]);

	useEffect(() => {
		let live = true;
		const api = client.user(auth);
		api.linkedAccounts().then(
			list => {
				if (live) setAccounts(list);
			},
			failure => {
				if (live) setError(explain(failure));
			},
		);
		// Where a surface is off, there is nothing to link on it; a failure to ask just leaves its note out.
		const on = (status: Promise<{ state: string }>) => status.then(next => next.state !== "off").catch(() => false);
		Promise.all([on(api.slack()), on(api.linear()), on(api.jira())]).then(([slack, linear, jira]) => {
			if (live) setAvailable({ slack, linear, jira });
		});
		return () => {
			live = false;
		};
	}, [client, auth, explain]);

	useEffect(() => {
		if (!showReturn.current || (!accounts && !error) || !card.current) return;
		showReturn.current = false;
		card.current.scrollIntoView?.({ block: "start" });
		confirmLink.current?.focus({ preventScroll: true });
	}, [accounts, error]);

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

	const api = client.user(auth);
	return (
		<section
			ref={card}
			className="usage-section repo-saved"
			aria-labelledby="linked-accounts"
			data-testid="linked-accounts"
		>
			<h3 className="usage-title" id="linked-accounts">
				Linked accounts
			</h3>
			<p className="usage-lede">
				Work you file from Slack, Linear or Jira is filed in the Windlass account linked to the person who asked for it,
				and uses that account’s connections. Nothing is filed for a person who hasn’t linked.
			</p>
			{!accounts && !error && <p aria-busy="true">Loading linked accounts…</p>}
			{accounts?.length === 0 && <p className="field-note">No linked accounts.</p>}
			{accounts && accounts.length > 0 && (
				<ul className="settings-list" aria-label="Linked accounts">
					{accounts.map(account => {
						const surface = SURFACES[account.surface];
						return (
							<li className="usage-kept-row" key={`${account.surface}:${account.tenant}`}>
								<div className="usage-kept-main">
									<span className="usage-kept-title">{surface}</span>
									<p className="agent-meta">
										{account.tenantName}
										{account.name ? ` · ${account.name}` : ""}
									</p>
								</div>
								<span />
								<button
									type="button"
									className="button button-outline button-small"
									aria-label={`Unlink ${surface} account in ${account.tenantName}`}
									disabled={busy}
									onClick={() =>
										void run(async () =>
											setAccounts(await api.unlinkAccount({ surface: account.surface, tenant: account.tenant })),
										)
									}
								>
									Unlink
								</button>
							</li>
						);
					})}
				</ul>
			)}
			{ticket && (
				<button
					ref={confirmLink}
					type="button"
					className="button button-outline"
					disabled={busy}
					onClick={() => {
						const proof = ticket;
						setTicket("");
						void run(async () => setAccounts(await api.linkAccount(proof)));
					}}
				>
					Link this account
				</button>
			)}
			<h4 className="usage-title">How to link</h4>
			{available.slack && (
				<p className="field-note">
					Slack: Mention Windlass in a mapped channel and open the private, one-time link it sends you.
				</p>
			)}
			{available.linear && (
				<p className="field-note">
					Linear:{" "}
					<button
						type="button"
						className="button button-outline button-small"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								location.assign((await api.linkAccountStart({ surface: "linear", origin: location.origin })).url);
							})
						}
					>
						Link Linear account…
					</button>
				</p>
			)}
			{available.jira && (
				<p className="field-note">Jira: Connecting Jira in Settings links the Jira account you connect with.</p>
			)}
			{error && (
				<p className="callout callout-warn" role="alert">
					{error}
				</p>
			)}
		</section>
	);
}
