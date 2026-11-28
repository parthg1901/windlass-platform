/**
 * Settings: which Slack, Linear, Jira and GitLab user is you. Work a person files on one of those is filed in the Windlass
 * account they linked, so each integration's card says whether you are linked there (`LinkLine`), with its Link button and,
 * behind ⋯, "Unlink me" (`unlinkItems`). `LinkNotice` above the cards names the sources you connected but aren't linked on.
 *
 * Linking is a read-only sign-in at the surface. It comes back as `#link-return=<ticket>`, which is linked at once: the user
 * already confirmed at the surface, and the ticket opens only for the Windlass account that began it. A private link Slack
 * sent (`#link=<ticket>`) may have been opened by anyone, so it names the Slack user and workspace and waits for a confirm.
 */
import type { LinkedAccount, LinkedAccounts, LinkOffer, LinkSurface } from "@contract";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApp, useAuth } from "../state/app";
import { CheckIcon, WarnIcon } from "./Icons";
import { useReturnRound } from "./IntegrationCard";
import type { MenuItem } from "./ui";
import { Skeleton } from "./ui/Skeleton";

const RETURN = /^#link(?:-return|-error)?=/;

export const SURFACE_NAMES: Record<LinkSurface, string> = {
	slack: "Slack",
	linear: "Linear",
	jira: "Jira",
	gitlab: "GitLab",
};

const ERRORS: Record<string, string> = {
	denied: "was not given access, so nothing was linked. Try again when you’re ready.",
	state: "sign-in expired. Link again.",
	used: "sign-in expired. Link again.",
	scope:
		"refused the read-only sign-in: its Windlass application does not allow the read_user scope. Ask whoever runs Windlass to enable it.",
	unreachable: "could not be reached. Try again.",
};

/** "Linear user Ada Lovelace (Acme workspace)": the account a link names. */
export function describeLink(account: Pick<LinkedAccount, "surface" | "name" | "tenantName">): string {
	const surface = SURFACE_NAMES[account.surface];
	const who = account.name ? `${surface} user ${account.name}` : `your ${surface} user`;
	const where = account.surface === "slack" || account.surface === "linear" ? " workspace" : "";
	return account.tenantName ? `${who} (${account.tenantName}${where})` : who;
}

type Note = { tone: "ok" | "bad"; text: string };

interface Links {
	data: LinkedAccounts | null;
	busy: boolean;
	notes: Partial<Record<LinkSurface, Note>>;
	offer: { ticket: string; offer: LinkOffer } | null;
	connected: Partial<Record<LinkSurface, string>>;
	report(surface: LinkSurface, tenant: string | null): void;
	start(surface: LinkSurface): void;
	/** After connecting: links the connector too, when they are not linked in that tenant yet (Linear's connection is an app). */
	ensureLinked(surface: LinkSurface, tenant: string): void;
	confirmOffer(): void;
	dismissOffer(): void;
	unlink(account: LinkedAccount): void;
}

const LinksContext = createContext<Links | null>(null);
export const useLinks = () => useContext(LinksContext);

/** The link of `surface` that counts for this card: in the tenant this user connected, or anywhere when not connected. */
export function linkOn(data: LinkedAccounts | null, surface: LinkSurface, tenant?: string | null) {
	return data?.accounts.find(a => a.surface === surface && (tenant == null || tenant === "*" || a.tenant === tenant));
}

/** Where filing from other surfaces is off (`enabled` false), there is nothing to link: the cards show no line. */
export function LinksProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
	return enabled ? <LiveLinks>{children}</LiveLinks> : children;
}

function LiveLinks({ children }: { children: ReactNode }) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const api = useMemo(() => client.user(auth), [client, auth]);
	const [data, setData] = useState<LinkedAccounts | null>(null);
	const [busy, setBusy] = useState(false);
	const [notes, setNotes] = useState<Partial<Record<LinkSurface, Note>>>({});
	const [offer, setOffer] = useState<Links["offer"]>(null);
	const [connected, setConnected] = useState<Partial<Record<LinkSurface, string>>>({});
	const note = useCallback((surface: LinkSurface, value: Note | null) => {
		setNotes(current => {
			const next = { ...current };
			if (value) next[surface] = value;
			else delete next[surface];
			return next;
		});
	}, []);
	// A return to the page already open (only its fragment changes) is read again.
	const returned = useReturnRound(RETURN);
	// StrictMode may replay the effect after the fragment is gone, and a ticket is redeemed once: one read per return.
	const read = useRef<{ round: number; work: Promise<void> } | null>(null);

	useEffect(() => {
		let live = true;
		if (read.current?.round !== returned) {
			const back = /^#(link-return|link|link-error)=(.+)$/.exec(location.hash);
			if (back) history.replaceState(history.state, "", location.pathname + location.search);
			read.current = { round: returned, work: arrive(back?.[1], back?.[2]) };
		}
		void read.current.work
			.then(
				() => api.linkedAccounts(),
				() => api.linkedAccounts(),
			)
			.then(
				next => {
					if (live) setData(next);
				},
				() => {
					if (live) setData({ accounts: [], signIn: [] });
				},
			);
		return () => {
			live = false;
		};

		async function arrive(kind: string | undefined, value: string | undefined) {
			if (!kind || !value) return;
			const dot = value.indexOf(".");
			const prefix = value.slice(0, Math.max(dot, 0));
			const surface = (prefix === "slack-signin" ? "slack" : prefix) as LinkSurface;
			const known = Object.hasOwn(SURFACE_NAMES, surface);
			if (kind === "link-error") {
				if (!known) return;
				const words = ERRORS[value.slice(dot + 1)] ?? "could not be linked. Try again.";
				note(surface, { tone: "bad", text: `${SURFACE_NAMES[surface]} ${words}` });
				focusCard(surface);
				return;
			}
			if (kind === "link") {
				// A private link from Slack: named, and linked only once the user confirms it.
				try {
					setOffer({ ticket: value, offer: await api.linkOffer(value) });
				} catch (failure) {
					note("slack", { tone: "bad", text: explain(failure) });
				}
				focusCard("slack");
				return;
			}
			if (!known) return;
			try {
				const { linked, ...next } = await api.linkAccount(value);
				setData(next);
				note(surface, { tone: "ok", text: `Linked ${describeLink(linked)}.` });
			} catch (failure) {
				note(surface, { tone: "bad", text: explain(failure) });
			}
			focusCard(surface);
		}
	}, [api, explain, note, returned]);

	const run = useCallback(
		async (surface: LinkSurface, work: () => Promise<void>) => {
			setBusy(true);
			note(surface, null);
			try {
				await work();
			} catch (failure) {
				note(surface, { tone: "bad", text: explain(failure) });
			} finally {
				setBusy(false);
			}
		},
		[explain, note],
	);
	const start = useCallback(
		(surface: LinkSurface) =>
			void run(surface, async () => {
				location.assign((await api.linkAccountStart({ surface, origin: location.origin })).url);
			}),
		[api, run],
	);
	const value: Links = {
		data,
		busy,
		notes,
		offer,
		connected,
		report: useCallback((surface, tenant) => {
			setConnected(current => {
				if ((current[surface] ?? null) === tenant) return current;
				const next = { ...current };
				if (tenant === null) delete next[surface];
				else next[surface] = tenant;
				return next;
			});
		}, []),
		start,
		ensureLinked: useCallback(
			(surface, tenant) =>
				void api.linkedAccounts().then(next => {
					setData(next);
					if (!linkOn(next, surface, tenant) && next.signIn.includes(surface)) {
						note(surface, {
							tone: "ok",
							text: `Now sign in to ${SURFACE_NAMES[surface]} as yourself to link your account…`,
						});
						start(surface);
					}
				}),
			[api, note, start],
		),
		confirmOffer: () => {
			const pending = offer;
			if (!pending) return;
			setOffer(null);
			void run("slack", async () => {
				const { linked, ...next } = await api.linkAccount(pending.ticket);
				setData(next);
				note("slack", { tone: "ok", text: `Linked ${describeLink(linked)}.` });
			});
		},
		dismissOffer: () => setOffer(null),
		unlink: account =>
			void run(account.surface, async () => {
				setData(await api.unlinkAccount({ surface: account.surface, tenant: account.tenant }));
				note(account.surface, { tone: "ok", text: `Unlinked ${describeLink(account)}.` });
			}),
	};
	return <LinksContext.Provider value={value}>{children}</LinksContext.Provider>;
}

function focusCard(surface: LinkSurface) {
	// The card may still be loading: look for it once the page has drawn.
	setTimeout(() => {
		const line = document.querySelector<HTMLElement>(`[data-link-surface="${surface}"]`);
		line?.closest("section")?.scrollIntoView?.({ block: "start" });
		line?.querySelector<HTMLButtonElement>("button[data-link-confirm]")?.focus({ preventScroll: true });
	}, 0);
}

/** Tells the notice which tenant this user connected a source in (`"*"`: the source has one), or null when not connected. */
export function useReportConnection(surface: LinkSurface, tenant: string | null) {
	const report = useLinks()?.report;
	useEffect(() => {
		report?.(surface, tenant);
	}, [report, surface, tenant]);
	useEffect(() => () => report?.(surface, null), [report, surface]);
}

/**
 * One line under a card's connection status: "You: linked as …" or "You: not linked yet", with the Link button. A private
 * Slack link waiting for its confirm, and what the last link or unlink did, show here too.
 */
export function LinkLine({ surface, tenant }: { surface: LinkSurface; tenant?: string | null }) {
	const links = useLinks();
	if (!links) return null;
	// While the links are read, the line keeps its place.
	if (!links.data)
		return (
			<div className="integration-you" aria-busy="true">
				<p className="integration-you-line">
					<Skeleton width={240} />
				</p>
			</div>
		);
	const { data, busy, notes, offer } = links;
	const account = linkOn(data, surface, tenant);
	const name = SURFACE_NAMES[surface];
	const signIn = data.signIn.includes(surface);
	const message = notes[surface];
	const pending = surface === "slack" ? offer : null;
	return (
		<div className="integration-you" data-link-surface={surface} data-testid={`${surface}-link`}>
			{account ? (
				<p className="integration-you-line">
					<span className="integration-you-label">You:</span> linked as{" "}
					<strong>{account.name || `your ${name} user`}</strong>
					{account.tenantName ? <span className="faint"> in {account.tenantName}</span> : null} <CheckIcon size={13} />
				</p>
			) : (
				<p className="integration-you-line integration-you-unlinked">
					<span className="integration-you-label">You:</span> not linked yet: items you file here won’t run.{" "}
					{signIn ? (
						<button
							type="button"
							className="button button-outline button-small"
							disabled={busy}
							onClick={() => links.start(surface)}
						>
							{surface === "slack" ? "Sign in with Slack…" : `Link ${name}…`}
						</button>
					) : surface === "slack" ? (
						<span className="faint">Mention Windlass in a mapped channel and open the private link it sends you.</span>
					) : null}
				</p>
			)}
			{pending ? (
				<p className="callout" role="status">
					<span>A private link from Slack is open. Link it only if this is your Slack account.</span>{" "}
					<button
						type="button"
						data-link-confirm
						className="button button-primary button-small"
						disabled={busy}
						onClick={links.confirmOffer}
					>
						Link Slack user {pending.offer.name} in {pending.offer.tenantName} to this account
					</button>{" "}
					<button type="button" className="button button-quiet button-small" onClick={links.dismissOffer}>
						Not me
					</button>
				</p>
			) : null}
			{message ? (
				<p
					className={`callout ${message.tone === "bad" ? "callout-warn" : ""}`}
					role={message.tone === "bad" ? "alert" : "status"}
				>
					{message.tone === "bad" ? <WarnIcon /> : null}
					<span>{message.text}</span>
				</p>
			) : null}
		</div>
	);
}

/** "Unlink me" for a card's ⋯ menu: one per link this user has on the surface. */
export function useUnlinkItems(surface: LinkSurface): MenuItem[] {
	const links = useLinks();
	const accounts = links?.data?.accounts.filter(a => a.surface === surface) ?? [];
	return accounts.map(account => ({
		id: `unlink-${account.tenant}`,
		label: accounts.length > 1 ? `Unlink me in ${account.tenantName}` : "Unlink me",
		disabled: links!.busy,
		onSelect: () => {
			if (
				confirm(
					`Unlink ${describeLink(account)}? Items you file from ${SURFACE_NAMES[surface]} won’t run until you link again.`,
				)
			)
				links!.unlink(account);
		},
	}));
}

/** The sources this user connected but is not linked on: what they file there runs nowhere. */
export function unlinkedSources(links: Pick<Links, "data" | "connected"> | null): LinkSurface[] {
	if (!links?.data) return [];
	return (Object.keys(SURFACE_NAMES) as LinkSurface[]).filter(surface => {
		const tenant = links.connected[surface];
		return tenant !== undefined && !linkOn(links.data, surface, tenant);
	});
}

export function sourceList(surfaces: LinkSurface[]): string {
	const names = surfaces.map(s => SURFACE_NAMES[s]);
	return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** At the top of Integrations: the connected sources whose items won't run until this user links there. */
export function LinkNotice() {
	const links = useLinks();
	const missing = unlinkedSources(links);
	if (missing.length === 0) return null;
	return (
		<p className="callout callout-warn integration-link-notice" role="status" data-testid="link-notice">
			<WarnIcon />
			<span>
				Items you file from {sourceList(missing)} won’t run until you link. Use <strong>Link</strong> on{" "}
				{missing.length > 1 ? "their cards" : "its card"} below.
			</span>
		</p>
	);
}
