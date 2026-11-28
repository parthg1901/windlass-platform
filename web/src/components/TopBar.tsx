/**
 * The bar across the top: the wordmark, the app's places (Agents · Factory · Machines · Connections · Settings), where you are
 * on a page further in, the docs, the theme toggle and the account, whose menu opens from its picture.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIdentity, type Identity } from "../lib/identity";
import type { Section } from "../lib/nav";
import { linkProps, useRoute, type Route } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp } from "../state/app";
import { useGithub } from "../state/github";
import { useChatgpt } from "../state/hooks";
import { shownInSettings } from "./GithubSettings";
import { SectionMenu } from "./Nav";
import { CheckIcon, Mark, MoonIcon, SunIcon, UserIcon, WarnIcon } from "./Icons";
import { PickerPanel } from "./ui/Menu";
import { Tooltip } from "./ui/Tooltip";

export function Wordmark({ size = "small" }: { size?: "small" | "large" }) {
	return (
		<span className={`wordmark wordmark-${size}`}>
			<Mark size={size === "large" ? 44 : 22} />
			<span className="wordmark-name">windlass</span>
		</span>
	);
}

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle(): void }) {
	const next = theme === "dark" ? "light" : "dark";
	return (
		<Tooltip content={`Switch to the ${next} theme`} side="bottom">
			<button type="button" className="icon-button" onClick={onToggle} aria-label={`Switch to the ${next} theme`}>
				{theme === "dark" ? <SunIcon /> : <MoonIcon />}
			</button>
		</Tooltip>
	);
}

type Tone = "good" | "warn" | "quiet";

/** One line of the account menu: a connection, how it stands, and the way to where it is connected. */
function StatusRow({
	name,
	to,
	tone,
	state,
	onFollow,
}: {
	name: string;
	to: Route;
	tone: Tone;
	state: string;
	onFollow(): void;
}) {
	return (
		<a className={`menu-status menu-status-${tone}`} {...linkProps(to)} onClickCapture={onFollow}>
			<span className="menu-status-name">{name}</span>
			<span className="menu-status-state">
				{tone === "good" ? <CheckIcon size={12} /> : tone === "warn" ? <WarnIcon size={12} /> : null}
				{state}
			</span>
		</a>
	);
}

function chatgptRow({ status, error }: ReturnType<typeof useChatgpt>): { tone: Tone; state: string } {
	if (error) return { tone: "warn", state: "Check" };
	if (!status) return { tone: "quiet", state: "checking…" };
	return status.connected ? { tone: "good", state: "connected" } : { tone: "warn", state: "Connect" };
}

function githubRow(github: ReturnType<typeof useGithub>): { tone: Tone; state: string } {
	if (github.busy === "finishing") return { tone: "quiet", state: "finishing…" };
	if (github.error || (github.notice?.where === "account" && github.notice.tone === "bad"))
		return { tone: "warn", state: "Check" };
	if (github.status === null) return { tone: "quiet", state: "checking…" };
	return github.status.connection ? { tone: "good", state: "connected" } : { tone: "quiet", state: "Connect" };
}

/** The account's picture: the GitHub one where there is one, else the first letter of the name. */
function Avatar({ identity, size }: { identity: Identity; size: "small" | "large" }) {
	const [broken, setBroken] = useState<string | null>(null);
	const picture = identity.avatar && identity.avatar !== broken ? identity.avatar : null;
	return (
		<span className={`account-avatar account-avatar-${size}`} aria-hidden="true">
			{picture ? (
				<img src={picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(picture)} />
			) : (
				(identity.initial ?? <UserIcon size={size === "large" ? 16 : 13} />)
			)}
		</span>
	);
}

function AccountMenu() {
	const { auth } = useApp();
	// The menu's parts ask about the signed-in user: without one there is no menu.
	return auth ? <SignedInMenu /> : null;
}

function SignedInMenu() {
	const { auth, signOut, client, platform } = useApp();
	const identity = useIdentity();
	const github = useGithub();
	const chatgpt = useChatgpt();
	const route = useRoute();
	const [open, setOpen] = useState(false);
	const button = useRef<HTMLButtonElement>(null);
	const { notice, dismiss } = github;
	const onSettings = route.name === "settings";

	// Back from GitHub, started from the account: Settings says what came of it; elsewhere the menu opens.
	useEffect(() => {
		if (notice?.where === "account" && !onSettings && !shownInSettings.has(notice)) setOpen(true);
	}, [notice, onSettings]);
	// Said once: closing the menu puts it away.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && !open) dismiss();
		wasOpen.current = open;
	}, [open, dismiss]);

	if (!auth) return null;
	const close = () => setOpen(false);
	const header = (
		<span className="menu-who">
			<Avatar identity={identity} size="large" />
			<span className="menu-who-text">
				<span className="menu-who-name">{identity.name}</span>
				{identity.detail ? <span className="menu-who-detail">{identity.detail}</span> : null}
			</span>
		</span>
	);
	const problem = notice?.where === "account" && notice.tone === "bad" ? notice.text : null;
	return (
		<div className="account">
			<button
				ref={button}
				type="button"
				className="account-button"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`Account: ${identity.name}`}
				onClick={() => setOpen(value => !value)}
			>
				<Avatar identity={identity} size="small" />
			</button>
			<PickerPanel
				open={open}
				onClose={close}
				anchor={button}
				title="Account"
				header={header}
				width={296}
				id="account-menu"
			>
				<div className="menu" role="group" aria-label="Account">
					{auth.profile.demo ? <p className="menu-note">The demo runs a scripted model with real tool calls.</p> : null}
					{client.kind === "mock" ? <p className="menu-note">Mock backend: nothing leaves this page.</p> : null}
					<div className="menu-statuses">
						{auth.profile.demo ? null : (
							<StatusRow
								name="ChatGPT plan"
								to={{ name: "connections", section: "plan-openai" }}
								onFollow={close}
								{...chatgptRow(chatgpt)}
							/>
						)}
						{github.enabled ? (
							<StatusRow
								name="GitHub"
								to={{ name: "settings", section: "settings-github" }}
								onFollow={close}
								{...githubRow(github)}
							/>
						) : null}
						{problem ? (
							<p className="menu-note tone-bad" role="alert">
								{problem}
							</p>
						) : null}
					</div>
					{/* The account's own pages: closing the menu is the link's doing, the way there is the router's. */}
					<div className="menu-actions">
						{platform.info?.machines ? (
							<a className="menu-action menu-action-phone" {...linkProps({ name: "machines" })} onClickCapture={close}>
								Machines
							</a>
						) : null}
						<a className="menu-action menu-action-phone" {...linkProps({ name: "connections" })} onClickCapture={close}>
							Connections
						</a>
						<a className="menu-action" {...linkProps({ name: "usage" })} onClickCapture={close}>
							Usage
						</a>
						<a className="menu-action menu-action-phone" {...linkProps({ name: "settings" })} onClickCapture={close}>
							Settings
						</a>
						<a
							className="menu-action menu-action-phone"
							{...linkProps({ name: "docs", slug: "" })}
							onClickCapture={close}
						>
							Docs
						</a>
						<button type="button" className="menu-action menu-action-out" onClick={() => signOut()}>
							Sign out
						</button>
					</div>
				</div>
			</PickerPanel>
		</div>
	);
}

/**
 * The app's places: Agents, the Factory where the deployment offers work items, Machines where it
 * offers them, Connections (what pays for each agent), and Settings, the account's. `current` is the section of the page you are on, on every
 * page; `asking`, how many work items ask their person something, said beside "Factory" when there are any.
 */
export function ListTabs({ current, asking = 0 }: { current?: Section | null; asking?: number }) {
	const { platform } = useApp();
	return (
		<nav className="topbar-tabs" aria-label="Main">
			<a
				className="topbar-tab"
				aria-current={current === "agents" ? "page" : undefined}
				{...linkProps({ name: "home" })}
			>
				Agents
			</a>
			{platform.info?.items ? (
				<a
					className="topbar-tab"
					aria-current={current === "factory" ? "page" : undefined}
					{...linkProps({ name: "factory" })}
				>
					Factory
					{asking > 0 ? (
						<span className="topbar-tab-count">
							<span className="topbar-tab-dot" aria-hidden="true">
								{" · "}
							</span>
							{asking}
							<span className="visually-hidden"> {asking === 1 ? "needs" : "need"} you</span>
						</span>
					) : null}
				</a>
			) : null}
			{platform.info?.machines ? (
				<a
					className="topbar-tab"
					aria-current={current === "machines" ? "page" : undefined}
					{...linkProps({ name: "machines" })}
				>
					Machines
				</a>
			) : null}
			{/* On a phone there is no room for these two: they are in the account menu there. */}
			<a
				className="topbar-tab topbar-tab-wide"
				aria-current={current === "connections" ? "page" : undefined}
				{...linkProps({ name: "connections" })}
			>
				Connections
			</a>
			<a
				className="topbar-tab topbar-tab-wide"
				aria-current={current === "account" ? "page" : undefined}
				{...linkProps({ name: "settings" })}
			>
				Settings
			</a>
		</nav>
	);
}

/**
 * `current`: the section of the page you are on; `asking`, the Factory's needs-you count; `children`,
 * where you are further in (lib/nav.ts: the back control and the trail). On a phone's page further
 * in, the section's name stands for the tabs and opens them.
 */
export function TopBar({
	theme,
	onToggleTheme,
	current,
	asking,
	children,
}: {
	theme: Theme;
	onToggleTheme(): void;
	current?: Section | null;
	asking?: number;
	children?: ReactNode;
}) {
	const { auth, client } = useApp();
	return (
		<header className={`topbar${children ? " topbar-deep" : ""}`}>
			<a
				className="topbar-home"
				{...linkProps(auth ? { name: "home" } : { name: "signin" })}
				aria-label="Windlass, home"
			>
				<Wordmark />
			</a>
			{client.kind === "mock" ? (
				<span className="mock-flag" title="The mock backend is in use: no network, scripted turns.">
					mock
				</span>
			) : null}
			{auth ? <ListTabs current={current} asking={asking} /> : null}
			{auth && children ? <SectionMenu current={current ?? null} asking={asking} /> : null}
			<div className="topbar-middle">{children}</div>
			<div className="topbar-end">
				<a className="topbar-docs" {...linkProps({ name: "docs", slug: "" })}>
					Docs
				</a>
				<ThemeToggle theme={theme} onToggle={onToggleTheme} />
				<AccountMenu />
			</div>
		</header>
	);
}
