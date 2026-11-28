/**
 * A sandbox profile's layers, drawn the way they nest: the outermost layer is the outer box, each
 * next one sits inside it, and the agent's commands are at the centre.
 */
import type { EgressMode, SandboxProfile, SessionMode } from "@contract";
import { CheckIcon } from "./Icons";

/** "Docker container (non-root, no capabilities)" → name and detail. */
function splitLayer(layer: string): { name: string; detail: string | null } {
	const match = /^(.*?)\s*\((.*)\)\s*$/.exec(layer);
	return match?.[1] && match[2] ? { name: match[1], detail: match[2] } : { name: layer, detail: null };
}

function Nested({ layers, depth, compact }: { layers: string[]; depth: number; compact: boolean }) {
	const [first, ...rest] = layers;
	if (first === undefined) {
		return (
			<div className="layer-core">
				<span className="layer-core-dot" aria-hidden="true" />
				the agent's commands
			</div>
		);
	}
	const { name, detail } = splitLayer(first);
	return (
		<div className="layer" data-depth={depth}>
			<div className="layer-label">
				<span className="layer-index" aria-hidden="true">
					{depth + 1}
				</span>
				<span className="layer-name">{name}</span>
				{detail && !compact ? <span className="layer-detail">{detail}</span> : null}
			</div>
			<Nested layers={rest} depth={depth + 1} compact={compact} />
		</div>
	);
}

export function Layers({
	profile,
	compact = false,
}: {
	profile: Pick<SandboxProfile, "layers" | "name">;
	compact?: boolean;
}) {
	const sentence =
		profile.layers.length === 0
			? "No isolation layers are listed."
			: `Isolation, outermost first: ${profile.layers.join("; then ")}.`;
	return (
		<div className={`layers${compact ? " layers-compact" : ""}`} role="img" aria-label={sentence}>
			<Nested layers={profile.layers} depth={0} compact={compact} />
		</div>
	);
}

/**
 * Claude Code in a sandbox: the mode it runs in stands for the profile's approval, and its sign-in is
 * the machine owner's Claude login.
 */
export interface ClaudeFacts {
	hosted?: boolean;
	/** What paid for its latest turn that says: a connected plan or a Settings key; absent before one. */
	paidBy?: "plan" | "key";
	mode: SessionMode;
	opencode?: boolean;
	codex?: boolean;
}

export function commandNetworkFact(profile: SandboxProfile, claude: ClaudeFacts | null) {
	if (claude?.codex && !profile.commandNetwork && profile.available)
		return "commands can reach this session’s Codex model relay";
	if (claude?.opencode && !profile.commandNetwork && profile.available)
		return "commands can reach this session’s OpenCode model relay";
	if (claude && profile.claudeRelay && !profile.commandNetwork && profile.available)
		return "commands can reach only this session’s Claude model relay";
	return (
		profile.commandNetworkText ??
		(profile.commandNetwork ? "commands can reach the network" : "commands have no network")
	);
}

/** The relay's caps per turn, as the server's summaries say them (server/src/sandbox/profiles.ts `relayPlaceholderSentences`). */
const RELAY_CAPS = "8 at once, 32 waiting";

export function accessTokenFact(profile: SandboxProfile): string {
	// With Windlass's model relay the token file holds only a placeholder for the turn; the token stays outside.
	if (profile.modelRelay) {
		const where = profile.id === "daytona" ? "VM" : profile.id.startsWith("e2b") ? "microVM" : "container";
		const reader = profile.commandsCanReadAccessToken
			? "Commands"
			: "The agent's commands cannot read the turn's token file. Approved local MCP servers and processes left from setup";
		return `${reader} can read only a placeholder for this turn. With it they can make model requests on your ChatGPT plan through the relay while the turn runs (${RELAY_CAPS}). The access token never enters the ${where}.`;
	}
	const commands = !profile.commandsCanReadAccessToken
		? "The agent's commands cannot read the session's access token."
		: profile.id === "e2b"
			? "A command you allow outside the Windlass sandbox can read the session's access token and its replacements."
			: "Unsandboxed commands can read the session's access token and its replacements during the turn.";
	return (
		commands +
		" Setup finishes before handoff. Approved local MCP servers can read each token. Each token lasts about an hour from issue."
	);
}

export function claudeLoginFact(profile: SandboxProfile) {
	return profile.claudeRelay
		? "The machine’s relay holds the setup token."
		: "Runners without a credential relay also expose the setup token.";
}

/** One line of what a sandbox means for the user: `kept` when it is something held back from the agent's commands. */
export interface Outcome {
	text: string;
	kept: boolean;
}

/**
 * The three things a user asks of where an agent runs, as plain outcomes, from the profile's facts: whether
 * its commands are sandboxed, whether they reach the internet, and whether they can use the sign-in. An open
 * fact is said in plain words, not as a warning: it is the user's own choice. `egress` is a machine's
 * network mode, which says whether commands reach the local network too. The technical detail is
 * `ProfileFacts`, behind "How it's isolated".
 */
export function isolationOutcomes(profile: SandboxProfile, claude: ClaudeFacts | null, egress?: EgressMode): Outcome[] {
	const commands: Outcome = claude
		? { text: "Commands stay inside this agent's sandbox", kept: true }
		: profile.approval === "auto"
			? { text: "Commands run in a locked-down sandbox", kept: true }
			: { text: "Commands run freely, without asking", kept: false };
	const network: Outcome = profile.commandNetworkText
		? {
				text: profile.commandNetwork ? "Commands reach only allowed hosts" : "Commands reach only the model",
				kept: true,
			}
		: profile.commandNetwork
			? {
					text:
						egress === "open" ? "Commands can reach the internet and your network" : "Commands can reach the internet",
					kept: false,
				}
			: { text: "No internet from commands", kept: true };
	const signIn: Outcome = claude
		? claude.hosted
			? {
					text:
						claude.paidBy === "plan"
							? "Your plan's token stays on the platform"
							: claude.paidBy === "key"
								? "Your API key stays on the platform"
								: "Your plan or key stays on the platform",
					kept: true,
				}
			: claude.codex
				? { text: "Your OpenAI sign-in stays on the machine", kept: true }
				: claude.opencode
					? { text: "Your provider sign-in stays on the machine", kept: true }
					: { text: "Commands can use this machine's Claude login", kept: false }
		: profile.commandsCanReadAccessToken
			? { text: "Commands can use this turn's sign-in", kept: false }
			: { text: "Your sign-in stays outside the sandbox", kept: true };
	return [commands, network, signIn];
}

export function IsolationOutcomes({ outcomes }: { outcomes: Outcome[] }) {
	return (
		<ul className="outcomes" aria-label="What this means">
			{outcomes.map(outcome => (
				<li key={outcome.text} className={outcome.kept ? "outcome-kept" : "outcome-open"}>
					{outcome.kept ? (
						<CheckIcon size={13} className="outcome-mark" />
					) : (
						<span className="outcome-mark outcome-dot" aria-hidden="true" />
					)}
					{outcome.text}
				</li>
			))}
		</ul>
	);
}

/**
 * The three plain facts of a profile. The ChatGPT sign-in is in no sandbox; what a profile decides is
 * whether the agent's commands can read the short-lived access token a turn is handed. For Claude Code
 * (`claude`) the approval is its mode, and its commands can use the Claude login it runs with.
 */
export function ProfileFacts({ profile, claude = null }: { profile: SandboxProfile; claude?: ClaudeFacts | null }) {
	return (
		<ul className="facts">
			<li>
				<span className="fact-key">approval</span>
				{claude ? (
					<span className="fact-value">
						<strong>{claude.mode.name}</strong>
						{claude.mode.description ? <span className="fact-gloss">{claude.mode.description}</span> : null}
					</span>
				) : (
					<span className="fact-value">
						<strong>{profile.approval}</strong>
						<span className="fact-gloss">
							{profile.approval === "auto"
								? "runs what the sandbox contains, refuses the rest"
								: "runs every call without asking"}
						</span>
					</span>
				)}
			</li>
			<li>
				<span className="fact-key">network</span>
				<span className="fact-value">{commandNetworkFact(profile, claude)}</span>
			</li>
			<li>
				<span className="fact-key">sign-in</span>
				{claude ? (
					<span className="fact-value">
						{claude.hosted ? (
							"Commands can use the turn’s relay placeholder. Your Settings key stays on the platform."
						) : claude.codex ? (
							"Commands can use the Codex model relay. OpenAI credentials stay on the machine."
						) : claude.opencode ? (
							"Commands can use the OpenCode model relay. Provider credentials stay on the machine."
						) : (
							<>commands in this container can use your Claude login. {claudeLoginFact(profile)}</>
						)}
					</span>
				) : (
					<span className="fact-value">
						your ChatGPT sign-in is never in the sandbox
						<span className="fact-gloss">{accessTokenFact(profile)}</span>
					</span>
				)}
			</li>
		</ul>
	);
}
