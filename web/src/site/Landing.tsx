/**
 * The public landing page, at `/` for people who are not signed in. It is rendered twice from this one
 * component: to static HTML at build time (web/site-build.ts), which is what a visitor, a crawler or an
 * answer engine gets with no JavaScript at all, and by the app itself when a signed-out person lands on
 * `/` inside it. So it holds no state and reads nothing from the browser: everything that moves is CSS
 * (landing.css), and the theme button is wired by whoever renders it (`onToggleTheme` in the app,
 * public/site.js on the static page).
 *
 * The pictures are illustrations drawn from the app's own parts, not screenshots, and their captions say
 * so. The hero's session plays on a loop; the steering card, the Factory's rope and the runner's line
 * move too. Under prefers-reduced-motion each holds its finished state.
 */
import type { ReactNode } from "react";
import { ClaudeLogo, GitHubLogo, GoogleLogo } from "../components/AgentLogos";
import { machineProfileName } from "../lib/machines";
import {
	ArrowUpIcon,
	AskIcon,
	BranchIcon,
	CheckIcon,
	CloudIcon,
	FileIcon,
	LockIcon,
	MachineIcon,
	Mark,
	MoonIcon,
	PullRequestIcon,
	RepoIcon,
	ShieldIcon,
	SteerIcon,
	StopIcon,
	SunIcon,
	ThoughtIcon,
} from "../components/Icons";
import { ACCESS_URL } from "./config";
import { AGENTS, FACTORY_STEPS, FAQ, SESSION_FEATURES, type Feature } from "./content";
import { IsoWindlass } from "./IsoWindlass";
import { Wordmark } from "../components/Wordmark";

/**
 * `signIn` is the live sign-in panel when the app renders the page (at "/" and "/signin" for someone
 * signed out). The static page has no script for it, so it draws `StaticSignIn`: links into the app's
 * "/signin", which starts the chosen sign-in straight away.
 */
export function Landing({ onToggleTheme, signIn }: { onToggleTheme?: () => void; signIn?: ReactNode }) {
	return (
		<div className="landing">
			<a className="landing-skip" href="#main">
				Skip to the content
			</a>
			<SiteBar onToggleTheme={onToggleTheme} />
			<main id="main" className="lp-main">
				<Hero signIn={signIn} />
				<Sessions />
				<WhereItRuns />
				<Factory />
				<Agents />
				<Questions />
				<Closing />
			</main>
			<SiteFoot />
		</div>
	);
}

/* ---- the mark and the bar ----------------------------------------------------------------------- */

/** The mark (the tile), or the drum alone turning: the site draws the app's own (components/Icons.tsx). */
function MarkGlyph({ size, turning = false }: { size: number; turning?: boolean }) {
	return <Mark size={size} turning={turning} />;
}

function SiteBar({ onToggleTheme }: { onToggleTheme?: () => void }) {
	return (
		<header className="lp-bar">
			<div className="lp-wrap lp-bar-inner">
				<a className="lp-brand" href="/" aria-label="Windlass, home">
					<Wordmark />
				</a>
				<nav className="lp-nav" aria-label="On this page">
					<a href="#sessions">Sessions</a>
					<a href="#where">Where it runs</a>
					<a href="#factory">Factory</a>
					<a href="#agents">Agents</a>
					<a href="#questions">FAQ</a>
					<a href="/docs">Docs</a>
				</nav>
				<div className="lp-bar-end">
					<button
						type="button"
						className="icon-button lp-theme"
						data-theme-toggle=""
						aria-label="Switch between the light and dark theme"
						title="Switch theme"
						onClick={onToggleTheme}
					>
						<SunIcon className="lp-theme-sun" />
						<MoonIcon className="lp-theme-moon" />
					</button>
					<a className={`lp-btn lp-btn-line${ACCESS_URL ? " lp-bar-signin" : ""}`} href="#sign-in">
						Sign in
					</a>
					{ACCESS_URL ? (
						<a className="lp-btn lp-btn-accent" href={ACCESS_URL}>
							Request access
						</a>
					) : null}
				</div>
			</div>
		</header>
	);
}

/** The ways in: "Request access" where the deployment names a place for it, and always "Sign in". */
function Calls({ note = true }: { note?: boolean }) {
	return (
		<div className="lp-calls">
			{ACCESS_URL ? (
				<>
					<a className="lp-btn lp-btn-accent lp-btn-lg" href={ACCESS_URL}>
						Request access
					</a>
					<a className="lp-btn lp-btn-line lp-btn-lg" href="#sign-in">
						Sign in
					</a>
				</>
			) : (
				<>
					<a className="lp-btn lp-btn-accent lp-btn-lg" href="#sign-in">
						Sign in
					</a>
					<a className="lp-btn lp-btn-line lp-btn-lg" href="/docs">
						Read the docs
					</a>
				</>
			)}
			{note ? <p className="lp-calls-note">By invitation for now. No public sign-up, no pricing yet.</p> : null}
		</div>
	);
}

/* ---- the hero ----------------------------------------------------------------------------------- */

function Hero({ signIn }: { signIn?: ReactNode }) {
	return (
		<section className="lp-hero" aria-labelledby="hero-title">
			<div className="lp-grid-bg" aria-hidden="true" />
			<div className="lp-wrap">
				<div className="lp-hero-top">
					<div className="lp-hero-copy">
						<p className="lp-eyebrow">
							<MarkGlyph size={18} turning />
							<b>Coding agents</b>
							<span>in sandboxes you choose</span>
						</p>
						<h1 id="hero-title" className="lp-h1">
							Put an agent to work.
							<span className="lp-dim"> Watch every turn.</span>
						</h1>
						<p className="lp-lede">
							Windlass runs coding agents in a sandbox of their own, hosted or on a machine of yours. Every step shows
							up as it happens, and the work comes in as a pull request for you to merge.
						</p>
						<div id="sign-in" className="lp-signin" tabIndex={-1}>
							{signIn ?? <StaticSignIn />}
						</div>
					</div>
					<figure className="lp-iso-stage">
						<IsoWindlass />
					</figure>
				</div>
				<dl className="lp-manifest">
					<div>
						<dt>agents</dt>
						<dd>
							<b>Windlass, Claude Code and OpenCode</b>
							<span>Codex coming</span>
						</dd>
					</div>
					<div>
						<dt>sandbox</dt>
						<dd>
							<b>Hosted or on your machine</b>
							<span>a runner that dials out; nothing exposed</span>
						</dd>
					</div>
					<div>
						<dt>output</dt>
						<dd>
							<b>A pull request you review</b>
							<span>checks, CI and a second agent first; never merges</span>
						</dd>
					</div>
				</dl>
				<SessionFrame />
			</div>
		</section>
	);
}

/** The sign-in panel's frame, shared by the static page and the app's live panel (screens/SignIn.tsx). */
export function SignInShell({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
	return (
		<div className="lp-signin-card">
			<div className="lp-signin-head">
				<h2 className="lp-signin-title">Sign in</h2>
				<span className="lp-signin-badge">by invitation</span>
			</div>
			<div className="lp-signin-actions">{children}</div>
			<p className="lp-signin-foot">
				{foot ?? (
					<>
						No public sign-up or pricing yet.{" "}
						{ACCESS_URL ? <a href={ACCESS_URL}>Request access</a> : <a href="/docs">Read the docs</a>}
					</>
				)}
			</p>
		</div>
	);
}

/** Without the app: each button opens "/signin?with=…", where the app starts that sign-in at once. */
function StaticSignIn() {
	return (
		<SignInShell>
			<a className="lp-btn lp-btn-accent lp-btn-lg lp-signin-btn" href="/signin?with=github">
				<GitHubLogo /> Continue with GitHub
			</a>
			<a className="lp-btn lp-btn-line lp-btn-lg lp-signin-btn" href="/signin?with=google">
				<GoogleLogo /> Continue with Google
			</a>
		</SignInShell>
	);
}

/** A row of the timeline as the app draws it: a glyph on the rope, a verb in mono, its subject, quiet facts. */
function Row({
	k,
	verb,
	subject,
	facts,
	glyph,
	className = "",
}: {
	k: number;
	verb: string;
	subject: ReactNode;
	facts?: ReactNode;
	glyph?: ReactNode;
	className?: string;
}) {
	return (
		<li className={`lp-row lp-k${k} ${className}`}>
			<span className="lp-row-glyph">{glyph ?? <CheckIcon size={13} />}</span>
			<span className="lp-row-verb">{verb}</span>
			<span className="lp-row-subject">{subject}</span>
			{facts ? <span className="lp-row-facts">{facts}</span> : null}
		</li>
	);
}

function SessionFrame() {
	return (
		<figure className="lp-stage">
			<div className="lp-frame lp-loop" aria-hidden="true">
				<div className="lp-frame-bar">
					<span className="lp-dots">
						<i />
						<i />
						<i />
					</span>
					<span className="lp-crumbs">harbor-web /</span>
					<b className="lp-frame-title">Fix the slug test and open a pull request</b>
					<span className="lp-status">
						<span className="lp-status-working">
							<MarkGlyph size={14} turning /> working <span className="lp-clock" />
						</span>
						<span className="lp-status-done">
							<CheckIcon size={13} /> done · 5 steps
						</span>
					</span>
				</div>
				<div className="lp-frame-main">
					<p className="lp-person lp-k1">The slugify test fails on punctuation. Fix it and open a pull request.</p>
					<ol className="lp-rows">
						<Row
							k={2}
							verb="thought"
							glyph={<ThoughtIcon size={13} />}
							className="lp-row-thought"
							subject="Leading punctuation turns into dashes at the ends."
						/>
						<Row k={3} verb="read" subject={<code>slugify/slugify.js</code>} facts="8 lines · 9 ms" />
						<Row
							k={4}
							verb="edit"
							subject={<code>slugify/slugify.js</code>}
							facts={
								<>
									<span className="lp-add">+2</span> <span className="lp-del">−1</span>
								</>
							}
						/>
						<li className="lp-diff lp-k5">
							<span className="lp-diff-line lp-diff-del">{'-    .replace(/[^a-z0-9]+/g, "-");'}</span>
							<span className="lp-diff-line lp-diff-add">{'+    .replace(/[^a-z0-9]+/g, "-")'}</span>
							<span className="lp-diff-line lp-diff-add">{'+    .replace(/^-+|-+$/g, "");'}</span>
						</li>
						<li className="lp-row lp-k6 lp-row-shell">
							<span className="lp-row-glyph">
								<span className="lp-spin" />
								<CheckIcon size={13} className="lp-shell-ok" />
							</span>
							<span className="lp-row-verb">shell</span>
							<span className="lp-row-subject">
								<code>node --test</code>
							</span>
							<span className="lp-row-facts">
								<span className="lp-shell-running">running</span>
								<span className="lp-shell-done">exit 0 · 820 ms</span>
							</span>
						</li>
						<li className="lp-tail lp-k6">
							<span className="lp-tail-1">✓ slugify › trims punctuation</span>
							<span className="lp-tail-2">✓ slugify › keeps inner dashes</span>
						</li>
						<li className="lp-text lp-k7">
							Fixed: <code>slugify</code> now trims dashes at both ends, and both tests pass.
						</li>
						<li className="lp-row lp-k8 lp-row-done">
							<span className="lp-row-glyph">
								<CheckIcon size={13} />
							</span>
							<span className="lp-row-verb">done</span>
							<span className="lp-row-facts">checks passed · 5 steps</span>
							<span className="lp-pr lp-k9">
								<PullRequestIcon size={13} /> Pull request opened
							</span>
						</li>
					</ol>
					<div className="lp-composer">
						<div className="lp-composer-field">
							<span className="lp-typed">The slugify test fails on punctuation. Fix it and open a pull request.</span>
							<span className="lp-placeholder">Steer — it reads this at its next step</span>
						</div>
						<div className="lp-composer-tools">
							<span className="lp-pill">
								<span className="lp-glyph lp-glyph-accent" aria-hidden="true">
									<Mark size={12} />
								</span>
								Windlass
							</span>
							<span className="lp-pill">
								<CloudIcon size={13} />
								Hosted
							</span>
							<span className="lp-pill lp-pill-wide">
								<RepoIcon size={13} />
								harbor-web
							</span>
							<span className="lp-send">
								<ArrowUpIcon size={14} className="lp-send-go" />
								<StopIcon size={12} className="lp-send-stop" />
							</span>
						</div>
					</div>
				</div>
				<aside className="lp-frame-side">
					<p className="lp-side-h">Agent</p>
					<dl className="lp-side-dl">
						<dt>Agent</dt>
						<dd>Windlass</dd>
						<dt>Sandbox</dt>
						<dd>Hosted</dd>
						<dt>Mode</dt>
						<dd>Auto</dd>
						<dt>Branch</dt>
						<dd>
							<code>wl/slug-trim</code>
						</dd>
					</dl>
					<p className="lp-side-h">Context</p>
					<span className="lp-meter">
						<i />
					</span>
					<p className="lp-side-h">Files changed</p>
					<p className="lp-side-row lp-side-empty lp-side-files-none">none yet</p>
					<p className="lp-side-row lp-k4">
						<code>slugify.js</code>
						<span>
							<span className="lp-add">+2</span> <span className="lp-del">−1</span>
						</span>
					</p>
					<p className="lp-side-h">Checks</p>
					<p className="lp-side-row lp-side-empty lp-side-checks-none">not run</p>
					<p className="lp-side-row lp-side-check lp-k6b">
						<CheckIcon size={13} /> <code>node --test</code>
					</p>
					<p className="lp-side-h">Pull request</p>
					<p className="lp-side-row lp-side-empty lp-side-pr-none">after the turn</p>
					<p className="lp-side-row lp-side-pr lp-k9">
						<PullRequestIcon size={13} /> opened · ready for review
					</p>
				</aside>
			</div>
			<figcaption className="lp-caption">
				<span className="lp-live">
					<i /> A session, drawn from the app’s own parts. It plays on a loop: an illustration, not a recording.
				</span>
				<span>Windlass · hosted</span>
			</figcaption>
		</figure>
	);
}

/* ---- the sections ------------------------------------------------------------------------------- */

function Head({
	id,
	number,
	kicker,
	title,
	dim,
	lede,
}: {
	id: string;
	number: string;
	kicker: string;
	title: string;
	dim: string;
	lede: ReactNode;
}) {
	return (
		<header className="lp-head">
			<p className="lp-kicker">
				<span className="lp-knot" aria-hidden="true" />
				{number} — {kicker}
			</p>
			<h2 id={`${id}-title`} className="lp-h2">
				{title}
				<span className="lp-dim"> {dim}</span>
			</h2>
			<p className="lp-section-lede">{lede}</p>
		</header>
	);
}

const FEATURE_ICONS: Record<string, ReactNode> = {
	start: <ArrowUpIcon size={15} />,
	watch: <span className="lp-feat-prompt">›_</span>,
	steer: <SteerIcon size={15} />,
	ask: <AskIcon size={15} />,
	diff: <FileIcon size={15} />,
	publish: <PullRequestIcon size={15} />,
};

const feature = (key: string): Feature => {
	const found = SESSION_FEATURES.find(item => item.key === key);
	if (!found) throw new Error(`No session feature ${key}`);
	return found;
};

function Sessions() {
	return (
		<section id="sessions" className="lp-section" aria-labelledby="sessions-title">
			<div className="lp-wrap">
				<div className="lp-split">
					<div>
						<Head
							id="sessions"
							number="01"
							kicker="Sessions"
							title="Steer it mid-turn."
							dim="No restart, no lost work."
							lede="A session is one agent on one piece of work. It runs turn by turn and the browser shows each step as it happens, so you step in when it matters and leave it alone when it does not."
						/>
						<ul className="lp-feats">
							{["start", "watch", "steer"].map(key => {
								const item = feature(key);
								return (
									<li key={key} className="lp-feat">
										<span className="lp-feat-icon" aria-hidden="true">
											{FEATURE_ICONS[key]}
										</span>
										<div>
											<h3>{item.title}</h3>
											<p>{item.text}</p>
										</div>
									</li>
								);
							})}
						</ul>
					</div>
					<SteerCard />
				</div>
				<div className="lp-tiles">
					<AskTile />
					<DiffTile />
					<PublishTile />
				</div>
			</div>
		</section>
	);
}

function SteerCard() {
	return (
		<figure className="lp-steer">
			<div className="lp-card lp-steer-card" aria-hidden="true">
				<div className="lp-card-bar">
					<b>Metres and feet settings panel</b>
					<span className="lp-card-meta">
						<span className="lp-glyph" aria-hidden="true">
							<ClaudeLogo size={12} />
						</span>{" "}
						Claude Code · on your machine
					</span>
				</div>
				<ol className="lp-rows lp-steer-rows">
					<Row
						k={0}
						verb="edit"
						subject={<code>lib/format.ts</code>}
						facts={
							<>
								<span className="lp-add">+11</span> <span className="lp-del">−3</span>
							</>
						}
					/>
					<li className="lp-row lp-row-shell lp-s-shell">
						<span className="lp-row-glyph">
							<span className="lp-spin" />
						</span>
						<span className="lp-row-verb">shell</span>
						<span className="lp-row-subject">
							<code>pnpm vitest run settings</code>
						</span>
						<span className="lp-stopcall">
							<StopIcon size={9} /> Stop call
						</span>
					</li>
					<li className="lp-steer-in lp-s1">
						<span className="lp-steer-knot">
							<SteerIcon size={12} />
						</span>
						<div className="lp-steer-msg">
							<p>
								Use <code>Intl.NumberFormat</code> for the units, not string templates.
							</p>
							<p className="lp-steer-meta">you · sent while working · read at step 7</p>
						</div>
					</li>
					<Row
						k={0}
						verb="thought"
						glyph={<ThoughtIcon size={13} />}
						className="lp-row-thought lp-s2"
						subject="Switching the formatter to Intl.NumberFormat with unit “meter” and “foot”."
					/>
					<Row
						k={0}
						verb="edit"
						className="lp-s3"
						subject={<code>lib/format.ts</code>}
						facts={
							<>
								<span className="lp-add">+6</span> <span className="lp-del">−4</span>
							</>
						}
					/>
					<Row
						k={0}
						verb="shell"
						className="lp-s4"
						subject={<code>pnpm vitest run settings</code>}
						facts="9 passed · 2.1 s"
					/>
				</ol>
				<div className="lp-steer-composer">
					<SteerIcon size={14} />
					<span className="lp-steer-field">
						<span className="lp-steer-typed">Use Intl.NumberFormat for the units, not string templates.</span>
						<span className="lp-steer-ph">Steer — it reads this at its next step</span>
					</span>
					<span className="lp-send">
						<ArrowUpIcon size={14} />
					</span>
				</div>
			</div>
			<figcaption className="lp-caption">
				A message sent mid-turn, read at the agent’s next step. Illustration.
			</figcaption>
		</figure>
	);
}

function Tile({ item, children }: { item: Feature; children: ReactNode }) {
	return (
		<article className="lp-tile">
			<div className="lp-tile-pic" aria-hidden="true">
				{children}
			</div>
			<h3 className="lp-tile-title">
				<span className="lp-feat-icon" aria-hidden="true">
					{FEATURE_ICONS[item.key]}
				</span>
				{item.title}
			</h3>
			<p className="lp-tile-text">{item.text}</p>
		</article>
	);
}

function AskTile() {
	return (
		<Tile item={feature("ask")}>
			<div className="lp-ask">
				<p className="lp-ask-head">
					<AskIcon size={14} /> The agent asks
				</p>
				<p className="lp-ask-q">
					Run <code>pnpm install</code> with network access?
				</p>
				<div className="lp-ask-choices">
					<span className="lp-choice lp-choice-main">Allow once</span>
					<span className="lp-choice">For this session</span>
					<span className="lp-choice">Decline…</span>
				</div>
			</div>
		</Tile>
	);
}

function DiffTile() {
	return (
		<Tile item={feature("diff")}>
			<div className="lp-difftile">
				<p className="lp-difftile-head">
					<code>web/src/lib/format.ts</code>
					<span>
						<span className="lp-add">+6</span> <span className="lp-del">−4</span>
					</span>
				</p>
				<pre>
					<span className="lp-diff-line">{" export function length(m: number, unit: Unit) {"}</span>
					<span className="lp-diff-line lp-diff-del">{'-  return unit === "ft" ? `${m * 3.28} ft` : `${m} m`;'}</span>
					<span className="lp-diff-line lp-diff-add">{'+  const style = { style: "unit", unit: UNITS[unit] };'}</span>
					<span className="lp-diff-line lp-diff-add">{"+  return new Intl.NumberFormat(locale, style)"}</span>
				</pre>
			</div>
		</Tile>
	);
}

function PublishTile() {
	return (
		<Tile item={feature("publish")}>
			<div className="lp-prtile">
				<p className="lp-prtile-title">
					<PullRequestIcon size={15} /> Metres and feet settings panel
				</p>
				<p className="lp-prtile-branch">
					<BranchIcon size={12} /> <code>wl/metres-feet</code> → <code>main</code>
				</p>
				<ul>
					<li>
						<CheckIcon size={12} /> checks passed
					</li>
					<li>
						<CheckIcon size={12} /> 3 files · <span className="lp-add">+59</span> <span className="lp-del">−3</span>
					</li>
				</ul>
				<span className="lp-prtile-state">Open</span>
			</div>
		</Tile>
	);
}

/** The sandbox line, as the composer shows it under the task: what the chosen sandbox lets commands do. */
function SandboxLine({ facts }: { facts: string[] }) {
	return (
		<p className="lp-sandbox-line">
			<ShieldIcon size={13} />
			{facts.map(fact => (
				<span key={fact}>{fact}</span>
			))}
		</p>
	);
}

function WhereItRuns() {
	return (
		<section id="where" className="lp-section lp-section-band" aria-labelledby="where-title">
			<div className="lp-wrap">
				<Head
					id="where"
					number="02"
					kicker="Where it runs"
					title="Hosted, or on your own machine."
					dim="Always in a box."
					lede="Choose where the agent runs and what its commands can reach before you start."
				/>
				<div className="lp-places">
					<article className="lp-place">
						<p className="lp-place-kicker">
							<CloudIcon size={15} /> hosted
						</p>
						<h3 className="lp-place-title">A workspace for each agent</h3>
						<p className="lp-place-text">Start an agent from your browser. Windlass runs it in its own workspace.</p>
						<div className="lp-layers" aria-hidden="true">
							<div className="lp-layer">
								<p className="lp-layer-name">
									<span>1</span> Hosted workspace
								</p>
								<p className="lp-layer-detail">Isolated from other agents</p>
								<div className="lp-layer-core">the agent’s commands, as a non-root user</div>
							</div>
						</div>
						<dl className="lp-facts">
							<div>
								<dt>idle</dt>
								<dd>Suspended when nobody uses it; your next prompt resumes it with its files.</dd>
							</div>
							<div>
								<dt>time</dt>
								<dd>See the hosted time you’ve used on the Usage page.</dd>
							</div>
						</dl>
						<SandboxLine facts={["Hosted", "Pauses when idle"]} />
					</article>

					<article className="lp-place">
						<p className="lp-place-kicker">
							<MachineIcon size={15} /> your machine
						</p>
						<h3 className="lp-place-title">Connect your computer</h3>
						<p className="lp-place-text">
							Pair a Mac, Linux or Windows (WSL) computer with Docker. It connects to Windlass.{" "}
							<strong>No inbound connection is needed.</strong>
						</p>
						<div className="lp-dial" aria-hidden="true">
							<div className="lp-dial-box">
								<p className="lp-dial-label">your machine</p>
								<div className="lp-dial-runner">
									runner
									<div className="lp-dial-container">
										container
										<span>commands</span>
									</div>
								</div>
							</div>
							<div className="lp-dial-line">
								<span className="lp-dial-flow" />
								<span className="lp-dial-word">dials out</span>
							</div>
							<div className="lp-dial-platform">
								<MarkGlyph size={18} turning />
								platform
							</div>
						</div>
						<div className="lp-profiles">
							<div className="lp-profile">
								<p className="lp-profile-name">{machineProfileName("docker-windlass-sandbox")}</p>
								<SandboxLine facts={["Commands are locked down", "No internet"]} />
							</div>
							<div className="lp-profile">
								<p className="lp-profile-name">{machineProfileName("docker-hardened")}</p>
								<SandboxLine facts={["Commands run freely", "Internet access"]} />
							</div>
						</div>
					</article>
				</div>
				<p className="lp-note">
					<LockIcon size={14} />
					<span>
						Use Strict for untrusted code. In Open, commands can reach the network and read credentials available to the
						agent.
					</span>
				</p>
			</div>
		</section>
	);
}

function Factory() {
	return (
		<section id="factory" className="lp-section" aria-labelledby="factory-title">
			<div className="lp-wrap">
				<Head
					id="factory"
					number="03"
					kicker="Factory"
					title="File the work."
					dim="Get back a pull request."
					lede="A work item is a task on one repository that the platform carries to a pull request by itself. The next step is decided by what the platform observed — checks, CI, the review — never by what the agent says. It never merges: you do, on GitHub."
				/>
				<div className="lp-card lp-factory">
					<div className="lp-factory-head" aria-hidden="true">
						<span className="lp-factory-item">
							<span className="lp-factory-dot" />
							<b>Rate-limit the public API</b>
						</span>
						<span className="lp-factory-meta">
							<code>northwind/harbor-api</code> · filed from issue #37
						</span>
					</div>
					<ol className="lp-rope">
						{FACTORY_STEPS.map((step, index) => (
							<li key={step.label} className={`lp-step lp-step-${index}`}>
								<span className="lp-step-knot" aria-hidden="true" />
								<span className="lp-step-label">{step.label}</span>
								<span className="lp-step-text">{step.text}</span>
							</li>
						))}
					</ol>
				</div>
				<p className="lp-caption lp-caption-solo">
					A work item on its way to “Ready for you”. Illustration with a made-up repository.
				</p>
			</div>
		</section>
	);
}

/** Two letters where one would repeat another agent's. */
const GLYPHS: Record<string, string> = { "Claude Code": "C", OpenCode: "O", Codex: "Cx" };

function Agents() {
	return (
		<section id="agents" className="lp-section" aria-labelledby="agents-title">
			<div className="lp-wrap">
				<Head
					id="agents"
					number="04"
					kicker="Agents"
					title="Bring the agent"
					dim="you already trust."
					lede="Windlass is the platform’s own agent: a coding agent for the terminal, built alongside the platform. Claude Code runs on a machine of yours, signed in there. More are on the way."
				/>
				<ul className="lp-agents">
					{AGENTS.map(agent => (
						<li key={agent.name} className={`lp-agent lp-agent-${agent.state}`}>
							<span
								className={`lp-agent-glyph${agent.name === "Windlass" ? " lp-agent-glyph-accent" : ""}`}
								aria-hidden="true"
							>
								{agent.name === "Windlass" ? <MarkGlyph size={20} /> : (GLYPHS[agent.name] ?? agent.name.slice(0, 1))}
							</span>
							<h3 className="lp-agent-name">{agent.name}</h3>
							<span className="lp-agent-state">{agent.state === "available" ? "Available" : "Coming"}</span>
							<p className="lp-agent-where">{agent.where}</p>
						</li>
					))}
				</ul>
			</div>
		</section>
	);
}

function Questions() {
	return (
		<section id="questions" className="lp-section" aria-labelledby="questions-title">
			<div className="lp-wrap lp-faq-wrap">
				<div className="lp-faq-side">
					<Head
						id="questions"
						number="05"
						kicker="Questions"
						title="What people"
						dim="ask first."
						lede="Short answers here. The docs go further, and the app says what each choice promises before you make it."
					/>
					<a className="lp-btn lp-btn-line" href="/docs/faq">
						More in the docs
					</a>
				</div>
				<div className="lp-faq">
					{FAQ.map((item, index) => (
						<details key={item.question} className="lp-faq-item" open={index === 0}>
							<summary className="lp-faq-q">
								<span>{item.question}</span>
								<span className="lp-faq-plus" aria-hidden="true" />
							</summary>
							<p className="lp-faq-a">{item.answer}</p>
						</details>
					))}
				</div>
			</div>
		</section>
	);
}

function Closing() {
	return (
		<section className="lp-closing" aria-labelledby="closing-title">
			<div className="lp-wrap">
				<div className="lp-closing-card">
					<div className="lp-grid-bg" aria-hidden="true" />
					<div className="lp-closing-mark" aria-hidden="true">
						<svg
							width="72"
							height="72"
							viewBox="0 0 64 64"
							fill="none"
							stroke="currentColor"
							strokeWidth="2.5"
							strokeLinecap="round"
						>
							<g className="lp-turn-slow">
								<circle cx="32" cy="32" r="24" />
								<path d="M32 8v13M11.2 44l11.4-6.6M52.8 44l-11.4-6.6" />
								<circle cx="32" cy="32" r="4" fill="currentColor" stroke="none" />
							</g>
						</svg>
						<span className="lp-closing-line" />
						<span className="lp-closing-weight" />
					</div>
					<h2 id="closing-title" className="lp-h2 lp-closing-title">
						Hand it the work.
						<span className="lp-dim"> Keep your eyes on it.</span>
					</h2>
					<Calls />
				</div>
			</div>
		</section>
	);
}

function SiteFoot() {
	return (
		<footer className="lp-foot">
			<div className="lp-wrap lp-foot-inner">
				<span className="lp-brand lp-foot-brand">
					<Wordmark />
				</span>
				<nav className="lp-foot-nav" aria-label="Site">
					<a href="/docs">Docs</a>
					<a href="/signin">Sign in</a>
					<a href="/llms.txt">llms.txt</a>
					<a href="/sitemap.xml">Sitemap</a>
				</nav>
				<span className="lp-foot-note">By invitation for now</span>
			</div>
		</footer>
	);
}
