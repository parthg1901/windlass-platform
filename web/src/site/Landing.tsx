/**
 * The public landing page, at `/` for people who are not signed in. It is rendered twice from this one
 * component: to static HTML at build time (web/site-build.ts), which is what a visitor, a crawler or an
 * answer engine gets with no JavaScript at all, and by the app itself when a signed-out person lands on
 * `/` inside it. So it holds no state and reads nothing from the browser: everything that moves is CSS
 * (landing.css), and the theme button is wired by whoever renders it (`onToggleTheme` in the app,
 * public/site.js on the static page).
 *
 * The pictures are illustrations drawn from the app's own parts, not screenshots, and their captions say
 * so. The hero's windlass and the steering card move; under prefers-reduced-motion each holds still.
 * The words are in content.ts, so the page, its JSON-LD and llms.txt say the same thing.
 */
import type { ReactNode } from "react";
import { ClaudeLogo, CodexLogo, GitHubLogo, GoogleLogo, OpenCodeLogo, ProviderLogo } from "../components/AgentLogos";
import {
	ArrowUpIcon,
	CheckIcon,
	CloudIcon,
	LockIcon,
	MachineIcon,
	Mark,
	MoonIcon,
	PullRequestIcon,
	ResumeIcon,
	ShieldIcon,
	SteerIcon,
	StopIcon,
	SunIcon,
	ThoughtIcon,
} from "../components/Icons";
import { ProviderIcon } from "../components/ProviderIcon";
import { Wordmark } from "../components/Wordmark";
import { ACCESS_URL } from "./config";
import {
	AGENT_GRID,
	type AgentId,
	FACTORY_STEPS,
	FAQ,
	PLANS,
	PROOF,
	type Proof,
	REPO_URL,
	SAFETY,
	type SafetyCard,
} from "./content";
import { IsoWindlass } from "./IsoWindlass";

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
				<FactorySection />
				<ProofSection />
				<SafetySection />
				<AgentsSection />
				<SetupSection />
				<SteerSection />
				<PricingSection />
				<Questions />
				<Closing />
			</main>
			<SiteFoot />
		</div>
	);
}

/* ---- marks -------------------------------------------------------------------------------------- */

/** An agent's mark by id: the vendor's own, or the Windlass tile. */
function AgentMark({ id, size = 16 }: { id: AgentId; size?: number }) {
	if (id === "claude") return <ClaudeLogo size={size} />;
	if (id === "codex") return <CodexLogo size={size} />;
	if (id === "opencode") return <OpenCodeLogo size={size} />;
	return <Mark size={size} className="lp-mark-accent" />;
}

const SOURCES = [
	{ id: "github", name: "GitHub" },
	{ id: "gitlab", name: "GitLab" },
	{ id: "linear", name: "Linear" },
	{ id: "jira", name: "Jira" },
	{ id: "slack", name: "Slack" },
] as const;

function GitHubStar({ className = "" }: { className?: string }) {
	return (
		<a className={`lp-btn lp-btn-line ${className}`} href={REPO_URL} rel="noopener">
			<GitHubLogo /> Star on GitHub
		</a>
	);
}

/* ---- the bar ------------------------------------------------------------------------------------ */

function SiteBar({ onToggleTheme }: { onToggleTheme?: () => void }) {
	return (
		<header className="lp-bar">
			<div className="lp-wrap lp-bar-inner">
				<a className="lp-brand" href="/" aria-label="Windlass, home">
					<Wordmark />
				</a>
				<nav className="lp-nav" aria-label="On this page">
					<a href="#factory">Factory</a>
					<a href="#proof">Proof</a>
					<a href="#security">Security</a>
					<a href="#agents">Agents</a>
					<a href="#pricing">Pricing</a>
					<a href="#questions">FAQ</a>
					<a href="/docs">Docs</a>
				</nav>
				<div className="lp-bar-end">
					<a
						className="icon-button lp-bar-gh"
						href={REPO_URL}
						rel="noopener"
						aria-label="Windlass on GitHub"
						title="Star on GitHub"
					>
						<GitHubLogo />
					</a>
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
					<a className="lp-btn lp-btn-line lp-bar-signin" href="#sign-in">
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

/* ---- the hero ----------------------------------------------------------------------------------- */

function Hero({ signIn }: { signIn?: ReactNode }) {
	return (
		<section className="lp-hero" aria-labelledby="hero-title">
			<div className="lp-grid-bg" aria-hidden="true" />
			<div className="lp-wrap">
				<div className="lp-hero-top">
					<div className="lp-hero-copy">
						<p className="lp-eyebrow">
							<Mark size={16} turning />
							<b>Open-source</b>
							<span>software factory</span>
						</p>
						<h1 id="hero-title" className="lp-h1">
							Hand off the issue.
							<span className="lp-dim"> Get back a PR you can trust.</span>
						</h1>
						<p className="lp-lede">
							File a GitHub or Linear issue. A coding agent builds it in a sandbox, and it only reaches you after your
							CI passes and a second agent reviews it.
						</p>
						<div id="sign-in" className="lp-signin" tabIndex={-1}>
							{signIn ?? <StaticSignIn />}
						</div>
						<ul className="lp-hero-facts">
							<li>Bring your own API keys</li>
							<li>
								<a href={`${REPO_URL}#self-hosting`} rel="noopener">
									Self-host it
								</a>{" "}
								if you'd rather
							</li>
							<li>
								<a href={REPO_URL} rel="noopener">
									Apache-2.0
								</a>
							</li>
						</ul>
					</div>
					<figure className="lp-iso-stage">
						<IsoWindlass />
					</figure>
				</div>
				<WorksWith />
				<ul className="lp-proof">
					{PROOF.map(item => (
						<ProofItem key={item.key} item={item} />
					))}
				</ul>
			</div>
		</section>
	);
}

const PROOF_ICONS: Record<Proof["key"], ReactNode> = {
	ci: <CheckIcon size={15} />,
	keys: <LockIcon size={15} />,
	open: <GitHubLogo />,
};

function ProofItem({ item }: { item: Proof }) {
	return (
		<li className="lp-proof-item">
			<span className="lp-proof-icon" aria-hidden="true">
				{PROOF_ICONS[item.key]}
			</span>
			<p>
				<b>{item.title}</b> {item.text}
			</p>
		</li>
	);
}

/** Where work comes from, and which agents take it: the marks, each beside its name. */
function WorksWith() {
	return (
		<div className="lp-works" aria-label="Works with">
			<div className="lp-works-group">
				<span className="lp-works-label">Takes work from</span>
				<ul>
					{SOURCES.map(source => (
						<li key={source.id}>
							<ProviderIcon id={source.id} tone="brand" size={16} />
							{source.name}
						</li>
					))}
				</ul>
			</div>
			<div className="lp-works-group">
				<span className="lp-works-label">Runs</span>
				<ul>
					{AGENT_GRID.map(agent => (
						<li key={agent.id}>
							<AgentMark id={agent.id} />
							{agent.id === "windlass" ? "Windlass" : agent.name}
						</li>
					))}
				</ul>
			</div>
		</div>
	);
}

/** The sign-in panel's frame, shared by the static page and the app's live panel (screens/SignIn.tsx). */
export function SignInShell({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
	return (
		<div className="lp-signin-card">
			<div className="lp-signin-head">
				<h2 className="lp-signin-title">Sign in</h2>
				<span className="lp-signin-badge">by invitation for now</span>
			</div>
			<div className="lp-signin-actions">{children}</div>
			{foot ? <p className="lp-signin-foot">{foot}</p> : null}
		</div>
	);
}

/** Without the app: each button opens "/signin?with=…", where the app starts that sign-in at once. */
function StaticSignIn() {
	return (
		<SignInShell
			foot={
				ACCESS_URL ? (
					<>
						Not invited yet? <a href={ACCESS_URL}>Request access</a>
					</>
				) : null
			}
		>
			<a className="lp-btn lp-btn-accent lp-btn-lg lp-signin-btn" href="/signin?with=github">
				<GitHubLogo /> Continue with GitHub
			</a>
			<a className="lp-btn lp-btn-line lp-btn-lg lp-signin-btn" href="/signin?with=google">
				<GoogleLogo /> Continue with Google
			</a>
		</SignInShell>
	);
}

/* ---- sections ----------------------------------------------------------------------------------- */

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
	dim?: string;
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
				{dim ? <span className="lp-dim"> {dim}</span> : null}
			</h2>
			<p className="lp-section-lede">{lede}</p>
		</header>
	);
}

function FactorySection() {
	return (
		<section id="factory" className="lp-section" aria-labelledby="factory-title">
			<div className="lp-wrap">
				<Head
					id="factory"
					number="01"
					kicker="The factory"
					title="File the work."
					dim="Review the result."
					lede={
						<>
							Label an issue <code>windlass</code>, mention <code>@windlass</code>, or file it from Linear, Jira, Slack
							or the Factory page. Windlass picks it up (you'll see the 👀), plans it, builds it, and checks it the way
							you would. You get a pull request with the evidence attached.
						</>
					}
				/>
				<ol className="lp-pipe">
					{FACTORY_STEPS.map((step, index) => (
						<li key={step.label} className={`lp-pipe-step${index >= 6 ? " lp-pipe-end" : ""}`}>
							<span className="lp-pipe-n">{String(index + 1).padStart(2, "0")}</span>
							<h3>{step.label}</h3>
							<p>{step.text}</p>
							{index === 0 ? (
								<span className="lp-pipe-marks" aria-hidden="true">
									{SOURCES.map(source => (
										<ProviderIcon key={source.id} id={source.id} tone="brand" size={14} />
									))}
								</span>
							) : null}
							{index === 6 ? (
								<span className="lp-pipe-check" aria-hidden="true">
									<CheckIcon size={12} /> windlass/verified
								</span>
							) : null}
						</li>
					))}
				</ol>
				<p className="lp-caption lp-caption-solo">
					GitLab issues come in as quick items; the windlass/verified check and auto-merge are GitHub's.
				</p>
			</div>
		</section>
	);
}

function ProofSection() {
	return (
		<section id="proof" className="lp-section" aria-labelledby="proof-title">
			<div className="lp-wrap lp-split">
				<Head
					id="proof"
					number="02"
					kicker="Proof, not promises"
					title="Agents say they're done."
					dim="Windlass checks."
					lede={
						<>
							An agent saying “all tests pass” isn't evidence. Windlass builds its verdict from your checks and your CI
							on the exact commit it pushed, plus an independent review. On GitHub that verdict is the{" "}
							<code>windlass/verified</code> check, so you can make it required with branch protection, the same way you
							treat CI.
							<span className="lp-lede-more">
								Every item shows what it cost in dollars: model, sandbox and retries. Usage tracks the median cost per
								finished item by size of work.
							</span>
						</>
					}
				/>
				<figure className="lp-checks-fig">
					<div className="lp-card lp-checks" aria-hidden="true">
						<div className="lp-card-bar">
							<span className="lp-checks-pr">
								<PullRequestIcon size={14} /> Rate-limit the public API <span className="lp-dim">#214</span>
							</span>
							<span className="lp-card-meta">
								<code>3f9c2a1</code>
							</span>
						</div>
						<ul className="lp-checks-rows">
							<li className="lp-checks-main">
								<span className="lp-checks-ok">
									<CheckIcon size={13} />
								</span>
								<b>windlass/verified</b>
								<span className="lp-checks-sum">Verified on 3f9c2a1</span>
								<span className="lp-checks-req">Required</span>
							</li>
							<li>
								<span className="lp-checks-ok">
									<CheckIcon size={13} />
								</span>
								<b>CI / test</b>
								<span className="lp-checks-sum">Passed in 2m 14s</span>
							</li>
							<li>
								<span className="lp-checks-ok">
									<CheckIcon size={13} />
								</span>
								<b>CI / lint</b>
								<span className="lp-checks-sum">Passed in 41s</span>
							</li>
							<li>
								<span className="lp-checks-ok">
									<CheckIcon size={13} />
								</span>
								<b>windlass/guides</b>
								<span className="lp-checks-sum">Guides match the code</span>
							</li>
						</ul>
						<div className="lp-checks-summary">
							<p className="lp-checks-title">What was observed</p>
							<ul>
								<li>
									<CheckIcon size={12} /> Repository checks passed in the sandbox: <code>pnpm test</code>,{" "}
									<code>pnpm lint</code>
								</li>
								<li>
									<CheckIcon size={12} /> CI green on the exact head, <code>3f9c2a1</code>
								</li>
								<li>
									<CheckIcon size={12} /> Approved by a second agent that reviewed that commit in its own sandbox
								</li>
							</ul>
						</div>
					</div>
					<figcaption className="lp-caption">GitHub's checks on a Windlass pull request. Illustration.</figcaption>
				</figure>
			</div>
		</section>
	);
}

const SAFETY_ICONS: Record<SafetyCard["key"], ReactNode> = {
	keys: <LockIcon size={16} />,
	network: <ShieldIcon size={16} />,
	resume: <ResumeIcon size={16} />,
};

function SafetySection() {
	return (
		<section id="security" className="lp-section" aria-labelledby="security-title">
			<div className="lp-wrap">
				<Head
					id="security"
					number="03"
					kicker="Safe by default"
					title="Give agents work,"
					dim="not your keys."
					lede="Each agent works in a sandbox of its own. What it needs from you is lent per turn and kept outside."
				/>
				<ul className="lp-cards3">
					{SAFETY.map(card => (
						<li key={card.key} className="lp-card lp-card3">
							<span className="lp-card3-icon" aria-hidden="true">
								{SAFETY_ICONS[card.key]}
							</span>
							<h3>{card.title}</h3>
							<p>{card.text}</p>
						</li>
					))}
				</ul>
				<p className="lp-small">
					Repository secrets you choose to share are passed in as environment variables.{" "}
					<a href="/docs/security">How it's isolated</a>
				</p>
			</div>
		</section>
	);
}

function AgentsSection() {
	return (
		<section id="agents" className="lp-section" aria-labelledby="agents-title">
			<div className="lp-wrap">
				<Head
					id="agents"
					number="04"
					kicker="Any agent, anywhere"
					title="Bring the agent"
					dim="you already trust."
					lede="Run Claude Code, Codex, OpenCode or the Windlass agent with your own API keys. Use hosted sandboxes, or pair your own Mac, Linux or Windows machine. It connects out to Windlass, so nothing on your network has to open up."
				/>
				<div className="lp-card lp-grid-card">
					<table className="lp-grid">
						<thead>
							<tr>
								<th scope="col">
									<span className="visually-hidden">Agent</span>
								</th>
								<th scope="col">
									<CloudIcon size={14} /> Hosted
								</th>
								<th scope="col">
									<MachineIcon size={14} /> Your machine
								</th>
							</tr>
						</thead>
						<tbody>
							{AGENT_GRID.map(agent => (
								<tr key={agent.id}>
									<th scope="row">
										<span className="lp-grid-agent">
											<AgentMark id={agent.id} size={18} />
											{agent.name}
										</span>
									</th>
									<td>
										<CheckIcon size={13} className="lp-grid-ok" /> {agent.hosted}
									</td>
									<td>
										<CheckIcon size={13} className="lp-grid-ok" /> {agent.machine}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					<div className="lp-keys">
						<span className="lp-works-label">With your own keys for</span>
						<span className="lp-keys-marks">
							<span>
								<ProviderLogo provider="anthropic" /> Anthropic
							</span>
							<span>
								<ProviderLogo provider="openai" /> OpenAI
							</span>
							<span>
								<ProviderLogo provider="google" /> Gemini
							</span>
							<span>
								<ProviderLogo provider="openrouter" /> OpenRouter
							</span>
						</span>
					</div>
				</div>
				<p className="lp-small">
					Planning and review run on the Windlass agent. On your own machine, agents can use your own local sign-ins;
					Windlass never sees those logins.
				</p>
			</div>
		</section>
	);
}

const SETUP_ROWS: { title: string; ok: boolean }[] = [
	{ title: "Setup command works on a fresh checkout", ok: true },
	{ title: "Saved checks pass in five minutes", ok: true },
	{ title: "Root guide has working commands", ok: false },
	{ title: "Large folders have their own guide", ok: false },
	{ title: "Issue and pull request templates", ok: true },
	{ title: "Source files within 1,500 lines", ok: true },
	{ title: "A workflow checks pull requests", ok: true },
	{ title: "Secrets ignored and scanned", ok: true },
];

function SetupSection() {
	return (
		<section id="setup" className="lp-section" aria-labelledby="setup-title">
			<div className="lp-wrap lp-split">
				<div>
					<Head
						id="setup"
						number="05"
						kicker="Repo setup"
						title="Agents do better in repos"
						dim="that explain themselves."
						lede="Connect a repository and get a setup score in seconds, free, with no agent time. One click drafts the contributor guides and skills your agents need, reviewed and delivered as a single pull request. After that, the windlass/guides check flags guides that go out of date as your code changes."
					/>
					<ul className="lp-bullets">
						<li>
							<b>Score.</b> Eight checks, instant, free.
						</li>
						<li>
							<b>Finish setup.</b> Guides and skills, in one reviewed pull request.
						</li>
						<li>
							<b>Stays true.</b> A pull request check catches broken references.
						</li>
					</ul>
				</div>
				<figure className="lp-setup-fig">
					<div className="lp-card lp-setup" aria-hidden="true">
						<div className="lp-card-bar">
							<b>Setup checks</b>
							<span className="lp-setup-score">6 of 8</span>
						</div>
						<ul>
							{SETUP_ROWS.map(row => (
								<li key={row.title} className={row.ok ? "lp-setup-ok" : "lp-setup-todo"}>
									<span className="lp-setup-dot">{row.ok ? <CheckIcon size={12} /> : null}</span>
									{row.title}
								</li>
							))}
						</ul>
						<div className="lp-setup-foot">
							<span className="lp-btn lp-btn-accent">Finish setup</span>
							<span className="lp-dim">drafts the two missing guides as one pull request</span>
						</div>
					</div>
					<figcaption className="lp-caption">A repository's setup checks. Illustration.</figcaption>
				</figure>
			</div>
		</section>
	);
}

/** A row of the timeline as the app draws it: a glyph on the rope, a verb in mono, its subject, quiet facts. */
function Row({
	verb,
	subject,
	facts,
	glyph,
	className = "",
}: {
	verb: string;
	subject: ReactNode;
	facts?: ReactNode;
	glyph?: ReactNode;
	className?: string;
}) {
	return (
		<li className={`lp-row ${className}`}>
			<span className="lp-row-glyph">{glyph ?? <CheckIcon size={13} />}</span>
			<span className="lp-row-verb">{verb}</span>
			<span className="lp-row-subject">{subject}</span>
			{facts ? <span className="lp-row-facts">{facts}</span> : null}
		</li>
	);
}

function SteerSection() {
	return (
		<section id="steer" className="lp-section" aria-labelledby="steer-title">
			<div className="lp-wrap lp-split">
				<Head
					id="steer"
					number="06"
					kicker="Watch and steer"
					title="Step in"
					dim="when it matters."
					lede="Every file read, command run and change made shows up as it happens. Send a message mid-turn and the agent reads it at its next step. In Strict, a command that wants the network or a write outside its workspace asks first."
				/>
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
								verb="thought"
								glyph={<ThoughtIcon size={13} />}
								className="lp-row-thought lp-s2"
								subject="Switching the formatter to Intl.NumberFormat with unit “meter” and “foot”."
							/>
							<Row
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
						A message sent mid-turn, read at the agent's next step. Illustration.
					</figcaption>
				</figure>
			</div>
		</section>
	);
}

function PricingSection() {
	return (
		<section id="pricing" className="lp-section" aria-labelledby="pricing-title">
			<div className="lp-wrap">
				<Head
					id="pricing"
					number="07"
					kicker="Pricing"
					title="Simple pricing."
					dim="Bring your own keys."
					lede="Model usage is billed by your provider, on your own key. Your plan covers hosted sandbox time."
				/>
				<ul className="lp-plans">
					{PLANS.map(plan => (
						<li key={plan.name} className={`lp-card lp-plan${plan.accent ? " lp-plan-accent" : ""}`}>
							<h3>{plan.name}</h3>
							<p className="lp-plan-price">
								<b>{plan.price}</b>
								{plan.per ? <span>{plan.per}</span> : null}
							</p>
							<ul>
								{plan.points.map(point => (
									<li key={point}>
										<CheckIcon size={13} /> {point}
									</li>
								))}
							</ul>
							{plan.name === "Self-host" ? (
								<a className="lp-btn lp-btn-line" href={`${REPO_URL}#self-hosting`} rel="noopener">
									Self-hosting guide
								</a>
							) : (
								<a className={`lp-btn ${plan.accent ? "lp-btn-accent" : "lp-btn-line"}`} href="#sign-in">
									Sign in
								</a>
							)}
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
						number="08"
						kicker="Questions"
						title="What people"
						dim="ask first."
						lede="Short answers here. The docs go further."
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
						<Mark size={56} turning />
					</div>
					<h2 id="closing-title" className="lp-h2 lp-closing-title">
						Stop babysitting agents.
						<span className="lp-dim"> Start reviewing results.</span>
					</h2>
					<div className="lp-calls">
						<a className="lp-btn lp-btn-accent lp-btn-lg" href={ACCESS_URL ?? "#sign-in"}>
							{ACCESS_URL ? "Request access" : "Sign in"}
						</a>
						<a className="lp-btn lp-btn-line lp-btn-lg" href="/docs">
							Read the docs
						</a>
						<GitHubStar className="lp-btn-lg" />
					</div>
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
				<span className="lp-foot-note">An open-source software factory</span>
				<nav className="lp-foot-nav" aria-label="Site">
					<a href="/docs">Docs</a>
					<a href={REPO_URL} rel="noopener">
						GitHub
					</a>
					<a href="/signin">Sign in</a>
					<a href="/llms.txt">llms.txt</a>
					<a href="/sitemap.xml">Sitemap</a>
				</nav>
			</div>
		</footer>
	);
}
