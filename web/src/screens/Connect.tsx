import { MACHINE_CONNECT_COMMAND, type MachineClaim, PLAN_NAMES, type PlanProvider } from "@contract";
import { useEffect, useState } from "react";
import { AnthropicLogo, OpenAILogo } from "../components/AgentLogos";
import { CheckIcon, CrossIcon, MachineIcon, WarnIcon } from "../components/Icons";
import { Waiting } from "../components/ui/StatusTag";
import { CONNECT_COMMANDS } from "../components/PlanConnect";
import { ThemeToggle, Wordmark } from "../components/TopBar";
import { machineLabel } from "../lib/machines";
import { linkProps } from "../lib/router";
import type { Theme } from "../lib/theme";
import { useApp, useAuth } from "../state/app";

const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$/;

type Outcome = "approved" | "denied";

/** What the terminal does once its code is approved, by the plan it connects. */
const NEXT: Record<PlanProvider, React.ReactNode> = {
	anthropic: (
		<>
			it runs <code>claude setup-token</code> and finishes there.
		</>
	),
	openai: <>it signs in to ChatGPT in your browser and finishes there.</>,
};

/** What happens after approval, as a fact beside the code. */
const THEN: Record<PlanProvider, React.ReactNode> = {
	anthropic: (
		<>
			Your terminal runs <code>claude setup-token</code>
		</>
	),
	openai: "You sign in to ChatGPT in your browser",
};

/**
 * Where `npx @windlassai/cli connect claude|codex` sends its user: the code the terminal shows, for the plan it
 * names, to compare and approve. Only after approval does that terminal hand the plan's sign-in to this account.
 * With `kind: "machine"`, `connect --machine` sends its user here to approve a machine's pairing code instead.
 */
export function Connect({
	code: raw,
	plan,
	kind,
	theme,
	onToggleTheme,
}: {
	code?: string;
	plan?: PlanProvider;
	kind?: "machine";
	theme: Theme;
	onToggleTheme(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [busy, setBusy] = useState<Outcome | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);
	const code = raw?.trim().toUpperCase() ?? "";
	const wellFormed = CODE_SHAPE.test(code);

	if (kind === "machine")
		return <ConnectMachine code={wellFormed ? code : null} theme={theme} onToggleTheme={onToggleTheme} />;

	async function decide(choice: Outcome) {
		if (!plan) return;
		setBusy(choice);
		setError(null);
		try {
			const user = client.user(auth);
			await (choice === "approved" ? user.approvePlanConnect(code, plan) : user.denyPlanConnect(code));
			setOutcome(choice);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	}

	return (
		<ConnectPage
			eyebrow={
				plan ? (
					<>
						{plan === "anthropic" ? <AnthropicLogo /> : <OpenAILogo />}
						{PLAN_NAMES[plan]}
					</>
				) : (
					"Plan"
				)
			}
			title={plan ? `Connect your ${PLAN_NAMES[plan]}?` : "Connect a plan?"}
			theme={theme}
			onToggleTheme={onToggleTheme}
		>
			{!wellFormed || !plan ? (
				<p className="signin-text">
					This link has no connect code. Run <code>{CONNECT_COMMANDS.anthropic}</code> or{" "}
					<code>{CONNECT_COMMANDS.openai}</code> in a terminal and follow the link it opens.
				</p>
			) : outcome === "approved" ? (
				<Decided approved>
					<p role="status">Approved. Go back to your terminal: {NEXT[plan]}</p>
				</Decided>
			) : outcome === "denied" ? (
				<Decided>
					<p role="status">Denied. Nothing was connected; the terminal stops.</p>
				</Decided>
			) : (
				<>
					<ShownCode code={code} label="Connect code" />
					<dl className="connect-facts">
						<div>
							<dt>Connects to</dt>
							<dd>{auth.profile.email ?? "this account"}</dd>
						</div>
						<div>
							<dt>Then</dt>
							<dd>{THEN[plan]}</dd>
						</div>
					</dl>
					<Decide busy={busy} onDecide={choice => void decide(choice)} />
					<p className="connect-warn">Approve only if you just ran the command yourself and the codes match.</p>
				</>
			)}
			<Failed error={error} />
			{outcome || !wellFormed || !plan ? (
				<a
					className="link connect-next"
					{...linkProps({ name: "connections", section: plan ? `plan-${plan}` : undefined })}
				>
					Go to Connections
				</a>
			) : null}
		</ConnectPage>
	);
}

/** The terminal's code, large, to compare at a glance: its two halves apart. */
function ShownCode({ code, label }: { code: string; label: string }) {
	const [head, tail] = shownCode(code).split("-");
	return (
		<div className="connect-code-box">
			<p className="connect-code-label">The code in your terminal</p>
			<p className="connect-code" aria-label={label}>
				<span>{head}</span>
				<span className="connect-code-dash">-</span>
				<span>{tail}</span>
			</p>
		</div>
	);
}

/** Approve and Deny, side by side. */
function Decide({ busy, onDecide }: { busy: Outcome | null; onDecide(choice: Outcome): void }) {
	return (
		<div className="connect-actions">
			<button
				type="button"
				className="button button-primary"
				disabled={busy !== null}
				onClick={() => onDecide("approved")}
			>
				{busy === "approved" ? "Approving…" : "Approve"}
			</button>
			<button
				type="button"
				className="button button-outline"
				disabled={busy !== null}
				onClick={() => onDecide("denied")}
			>
				{busy === "denied" ? "Denying…" : "Deny"}
			</button>
		</div>
	);
}

/** What was decided, with a check for an approval. */
function Decided({ approved = false, children }: { approved?: boolean; children: React.ReactNode }) {
	return (
		<div className={`connect-outcome${approved ? " connect-outcome-ok" : ""}`}>
			{approved ? <CheckIcon size={16} /> : <CrossIcon size={16} />}
			{children}
		</div>
	);
}

/** The page around a connect card: the bar with the wordmark and theme toggle, and the card with its title. */
function ConnectPage({
	eyebrow,
	title,
	theme,
	onToggleTheme,
	children,
}: {
	eyebrow: React.ReactNode;
	title: string;
	theme: Theme;
	onToggleTheme(): void;
	children: React.ReactNode;
}) {
	return (
		<div className="connect-page">
			<div className="signin-bar">
				<Wordmark />
				<div className="signin-bar-end">
					<ThemeToggle theme={theme} onToggle={onToggleTheme} />
				</div>
			</div>
			<main className="connect-main">
				<section className="signin-card connect-card" aria-labelledby="connect-title">
					<p className="connect-eyebrow">{eyebrow}</p>
					<h1 id="connect-title" className="signin-title">
						{title}
					</h1>
					{children}
				</section>
			</main>
		</div>
	);
}

const shownCode = (code: string) => (code.includes("-") ? code : `${code.slice(0, 4)}-${code.slice(4)}`);

function Failed({ error }: { error: string | null }) {
	return error ? (
		<p className="callout callout-bad" role="alert">
			<WarnIcon />
			<span>{error}</span>
		</p>
	) : null;
}

/**
 * Where `npx @windlassai/cli connect --machine` sends its user: the machine's pairing code and machine key, as its
 * terminal shows them, to compare and approve. Approving pairs the machine with this account; denying ends the
 * pairing, and the terminal stops.
 */
function ConnectMachine({
	code,
	theme,
	onToggleTheme,
}: {
	/** The code from the link; null for a link without a well-formed one. */
	code: string | null;
	theme: Theme;
	onToggleTheme(): void;
}) {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [claim, setClaim] = useState<MachineClaim | null>(null);
	const [busy, setBusy] = useState<Outcome | null>(null);
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (code === null) return;
		let live = true;
		client
			.user(auth)
			.claimMachine({ code })
			.then(
				found => live && setClaim(found),
				(failure: unknown) => live && setError(explain(failure)),
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain, code]);

	async function decide(choice: Outcome) {
		if (code === null) return;
		setBusy(choice);
		setError(null);
		try {
			const user = client.user(auth);
			if (choice === "approved") await user.confirmMachine({ code, keyConfirmed: true });
			else await user.denyMachine({ code });
			setOutcome(choice);
		} catch (failure) {
			setError(explain(failure));
		} finally {
			setBusy(null);
		}
	}

	const looking = code !== null && claim === null && error === null;
	return (
		<ConnectPage
			eyebrow={
				<>
					<MachineIcon size={14} />
					Machine
				</>
			}
			title="Connect this machine to your account?"
			theme={theme}
			onToggleTheme={onToggleTheme}
		>
			{code === null ? (
				<p className="signin-text">
					This link has no pairing code. To connect a machine, run <code>{MACHINE_CONNECT_COMMAND}</code> in a terminal
					on it; to connect a plan, run <code>{CONNECT_COMMANDS.anthropic}</code> or{" "}
					<code>{CONNECT_COMMANDS.openai}</code>. Then follow the link the terminal opens.
				</p>
			) : outcome === "approved" ? (
				<Decided approved>
					<p role="status">
						Approved. Go back to your terminal: the runner starts there and the machine appears on Machines.
					</p>
				</Decided>
			) : outcome === "denied" ? (
				<Decided>
					<p role="status">Denied. Nothing was connected; the terminal stops.</p>
				</Decided>
			) : looking ? (
				<Waiting>Looking up the machine…</Waiting>
			) : claim ? (
				<>
					<ShownCode code={code} label="Pairing code" />
					<dl className="connect-facts">
						<div>
							<dt>Machine key</dt>
							<dd className="connect-machine-key">
								{claim.keyFingerprint ?? <span className="tone-faint">not known</span>}
							</dd>
						</div>
						<div>
							<dt>Name</dt>
							<dd>{machineLabel(claim)}</dd>
						</div>
						<div>
							<dt>System</dt>
							<dd>
								{claim.os} · {claim.arch}
							</dd>
						</div>
						<div>
							<dt>Connects to</dt>
							<dd>{auth.profile.email ?? "this account"}</dd>
						</div>
					</dl>
					<Decide busy={busy} onDecide={choice => void decide(choice)} />
					<p className="connect-warn">
						{claim.keyPrinted
							? "Approve only if you just ran the command yourself and the code and key match. If someone gave you this link, deny it."
							: `Runner ${claim.runnerVersion} does not print its machine key, so it cannot be compared. Approve only if you started it yourself in the last few minutes.`}{" "}
						Its agents get your repositories' files and saved secrets.
					</p>
				</>
			) : null}
			<Failed error={error} />
			{outcome || code === null || (error && claim === null) ? (
				<a className="link connect-next" {...linkProps({ name: "machines" })}>
					Go to Machines
				</a>
			) : null}
		</ConnectPage>
	);
}
