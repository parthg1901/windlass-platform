/**
 * Text the platform hands an item's agent without vouching for it, and how Windlass is told.
 *
 * Someone else's issue (GitHub, Linear or Jira), CI logs, GitHub feedback from people other than the item's person, a second
 * reviewer's findings, the builder's report the reviewer reads, and the reports of other subtasks are
 * all written by someone (or something) other than the item's person. The platform labels them in the
 * prompt for the model ("quoted data", "untrusted text"), and also names where they came from on the
 * turn: each `TurnPlan` and `deliver` effect carries `untrusted`, the sources in the person's words.
 *
 * The session sends the sources with the prompt, as Windlass 0.6.0 takes them
 * (`session/prompt` `_meta["windlass/untrusted"]: { source }`, its docs/acp.md): the session is tainted
 * before the turn's first step, so a command that would use the network or run outside Windlass's
 * sandbox, and a tool that could send data out, asks again; in an item's unattended turn that is refused
 * and recorded. Taint stays for the rest of the session.
 *
 * Trusted, and never marked: the platform's own sentences, the item's body when the person wrote it (on
 * the page, through the API, or as the issue's own author), the person's notes and answers (an
 * `ask_person` answer among them), and the person's own feedback on GitHub. The repository's files are
 * the workspace, which Windlass trusts by decision.
 *
 * A cross-repo feature's other repository (factory/cross-repo.ts) is the same: its tree, which the
 * planner reads at `.windlass-inputs/<alias>`, is a repository the person bound at filing with write
 * access, the bar the primary meets, so it is trusted as the primary's files are, whoever owns it. No
 * issue or third party chose it. The combined run's result is the run's own text, like CI logs, and is
 * marked as such (`untrustedWords.integration`).
 */

import type { HarnessId, SandboxProfileId } from "../contract.js";
import { harnessName, machineHarness, takesUntrustedMarker } from "../sandbox/harnesses.js";
import { sourceCaps } from "../sources/registry.js";
import { SOURCE_IDS, type SourceId } from "../sources/types.js";

/** The longest source Windlass takes (its docs/acp.md, `_meta["windlass/untrusted"]`). */
export const UNTRUSTED_SOURCE_MAX = 200;

/** A commit as the person reads it; a head that is no commit id (a branch git named instead) as it is. */
const short = (head: string) => (/^[0-9a-f]{40}$/.test(head) ? head.slice(0, 7) : head.slice(0, 60));

/** Each source as the person reads it on the timeline and in Windlass's approval wording. */
export const untrustedWords = {
	/**
	 * Someone else's filing in a work source, by its record: `display` is the filing as the source shows it ("#12",
	 * "ENG-12"), `author` as the source names them. A matching sender name does not make the text trusted.
	 */
	source: (id: SourceId, display = "", author = "") => sourceCaps(id).untrusted.words(display, author),
	gitlabNote: (id: string) => `GitLab note ${id}`,
	ci: (head: string) => `CI logs of ${short(head)}`,
	push: (head: string, pusher: string) => `commit ${short(head)} pushed by @${pusher}`,
	feedback: (writers: string) => `GitHub feedback from ${writers}`,
	review: (head: string) => `the second reviewer's findings on ${short(head)}`,
	builder: (pr: number) => `the builder's report on pull request #${pr}`,
	reports: "reports of the feature's subtasks",
	earlier: "reports of earlier subtasks",
	conversation: "earlier agent messages from the session timeline",
	/** A cross-repo feature's combined run on GitHub Actions: what it said, as GitHub reported it. */
	integration: "the combined run's result",
};

/**
 * The sources written by someone other than the item's person: an issue of someone else's, and GitHub
 * feedback with any other writer, also as a subtask or a feature inherited them (the same words). The
 * rest (CI logs, the second reviewer's findings, the builder's report, subtask reports) is text the
 * platform's own run made: no person outside put it there, though what it quotes is not vouched for.
 */
export function thirdParty(list: readonly string[] | undefined | null): string[] {
	return sources(list).filter(source => THIRD_PARTY.some(form => form.test(source)));
}

/** Source prefixes produced by `untrustedWords` for third-party text: each work source's filings, then the rest. */
const THIRD_PARTY = [
	...SOURCE_IDS.map(id => sourceCaps(id).untrusted.pattern),
	/^GitLab note \d+$/,
	/^GitHub feedback from /,
	/^commit [a-f0-9]+ pushed by @/,
];

/** The sources of several pieces of text, each once, in order. */
export function sources(...lists: Array<readonly string[] | undefined | null>): string[] {
	return [
		...new Set(
			lists
				.flatMap(list => list ?? [])
				.map(source => source.trim())
				.filter(Boolean),
		),
	];
}

/** One source for Windlass: the sources joined, cut to its limit (never refused for length). Null for none. */
export function untrustedSource(list: readonly string[] | undefined): string | null {
	const joined = sources(list).join("; ");
	if (!joined) return null;
	return joined.length <= UNTRUSTED_SOURCE_MAX ? joined : joined.slice(0, UNTRUSTED_SOURCE_MAX - 1).trimEnd() + "…";
}

/**
 * What a turn does with its outside text: the one rule for every agent (`untrustedTurn`).
 *
 *   "none"      no outside text.
 *   "marked"    Windlass is told the sources with the prompt (`untrustedSource`); an engine before 0.6.0
 *               cannot be, and the timeline says so once (`unmarkedNote`).
 *   "labelled"  the text goes in the labelled prompt only, and the timeline says so once (`note`).
 *   "stop"      the turn does not start: the item asks, with `reason`, and the person may run it anyway
 *               (`FactoryItem.unsandboxed`), after which the same turn goes "labelled".
 */
export type UntrustedHandling =
	| { kind: "none" }
	| { kind: "marked"; sources: string[] }
	| { kind: "labelled"; sources: string[]; note: string }
	| { kind: "stop"; sources: string[]; reason: string };

/** What `untrustedTurn` decides by. */
export interface UntrustedTurn {
	/** The agent (`HarnessId`): its record says whether it takes the marker (`untrustedMarker`), and its name goes in the refusal and the notes (`harnessName`). */
	agent: HarnessId;
	/** The sandbox profile the turn runs in. */
	profile: SandboxProfileId;
	/** The turn's sources (`TurnPlan.untrusted`), the run's own and someone else's. */
	untrusted: readonly string[] | undefined;
	/** A reconstructed session prompt also quotes earlier turns. Only this turn's own sources can stop it. */
	currentSources?: readonly string[];
	/** The person chose to run this turn's text from someone else anyway (`FactoryItem.unsandboxed`). */
	unsandboxed: boolean | undefined;
}

/**
 * The one decision, for every agent, of how a turn takes its outside text.
 *
 * On "Docker, hardened" no agent can contain a command the text talks it into. Windlass runs with approval
 * "full" there, and once told it puts commands back into its bubblewrap sandbox, which Docker's default
 * seccomp profile does not let start: every command would ask, and an item's turn refuses what asks. The
 * other agents cannot be told at all, and run every command without asking. So there nothing is marked:
 * the run's own text (CI logs, findings, reports) goes labelled only, and someone else's (`thirdParty`)
 * stops the turn until the person chooses to run it anyway, then goes labelled only too.
 *
 * ACP agents on the open E2B profile also run commands directly, so the same third-party check applies.
 * On other profiles an agent that takes the marker is told, and the rest receive the labelled prompt.
 */
export function untrustedTurn(turn: UntrustedTurn): UntrustedHandling {
	const list = sources(turn.untrusted);
	if (!list.length) return { kind: "none" };
	const marker = takesUntrustedMarker(turn.agent);
	const openVm = turn.profile === "e2b-open" || turn.profile === "daytona";
	if (turn.profile === "docker-hardened" || (openVm && !marker)) {
		const outside = turn.unsandboxed ? [] : thirdParty(turn.currentSources ?? list);
		if (outside.length)
			return {
				kind: "stop",
				sources: outside,
				reason: openVm
					? `This turn includes text from someone else (${outside.join(", ")}). ${harnessName(turn.agent)} runs commands directly in the sandbox. Run it anyway or give up.`
					: hardenedRefusal(turn.agent, outside),
			};
		return {
			kind: "labelled",
			sources: list,
			note: marker
				? hardenedUnmarkedNote(list)
				: agentUnmarkedNote(
						harnessName(turn.agent),
						list,
						machineHarness(turn.agent)?.sandboxedOn.includes(turn.profile) ?? false,
					),
		};
	}
	if (marker) return { kind: "marked", sources: list };
	return {
		kind: "labelled",
		sources: list,
		note: agentUnmarkedNote(
			harnessName(turn.agent),
			list,
			machineHarness(turn.agent)?.sandboxedOn.includes(turn.profile) ?? false,
		),
	};
}

/** Why a turn with someone else's text does not start on "Docker, hardened" (`untrustedTurn`), in the words of its agent. */
export const hardenedRefusal = (agent: HarnessId, list: readonly string[]) => {
	const name = harnessName(agent);
	const marker = takesUntrustedMarker(agent);
	const what = marker
		? `On “Open” ${name} cannot sandbox commands once it is told of such text, so the text would go to the agent labelled only, and its commands would run outside Windlass's sandbox, with the container's network and the session's access token.`
		: `On “Open” ${name} cannot be told which text is not yours, so the text would go to it labelled only, and its commands would run without asking, with the container's network and the session's access.`;
	// Codex runs its commands in its own sandbox there (`sandboxedOn`): it is filed again as itself. Any other agent is filed with Windlass.
	const own = machineHarness(agent)?.sandboxedOn.includes("docker-windlass-sandbox") ?? false;
	const elsewhere =
		marker || own
			? `file the work again on “Strict”${own ? `, where ${name} runs its commands in its own sandbox` : ""}`
			: `file the work again with Windlass on “Strict”`;
	return `This turn carries text from someone else (${sources(list).join("; ")}). ${what} Run it anyway, ${elsewhere}, or give up.`;
};

/** What the item says once the person chose to run someone else's text anyway, in the words of its agent. */
export const runAnywayWords = (agent: HarnessId, list: readonly string[]) =>
	takesUntrustedMarker(agent)
		? `You chose to run text from someone else (${sources(list).join("; ")}) without ${harnessName(agent)}'s sandbox.`
		: `You chose to run text from someone else (${sources(list).join("; ")}) with ${harnessName(agent)}, which runs its commands without asking.`;

/** Once per session, on "Docker, hardened", where Windlass is told of no source (`untrustedTurn`). */
export const hardenedUnmarkedNote = (list: readonly string[]) =>
	`On “Open” Windlass is not told that this text is not yours (${sources(list).join("; ")}), since it could not sandbox commands once told. The text went to the agent as labelled text only, and commands run as on any turn.`;

/** Once per session, when the sandbox's Windlass does not take the marker (before 0.6.0). */
export const unmarkedNote = (list: readonly string[]) =>
	`This sandbox's Windlass cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only. Windlass 0.6.0 or later marks it.`;

/**
 * Once per session, for an agent that has no marker at all (Claude Code, OpenCode, Codex). `sandboxed`: its
 * commands run in its own sandbox without network, and a request to leave it ends the step (Codex on
 * "Docker + Windlass sandbox", harnesses.ts `sandboxedOn`). Whether such a turn runs at all on "Docker,
 * hardened" is decided by `untrustedTurn`, the same for every agent.
 */
export const agentUnmarkedNote = (agent: string, list: readonly string[], sandboxed = false) =>
	`${agent} cannot be told which text came from someone else (${sources(list).join("; ")}); it went to the agent as labelled text only, ` +
	(sandboxed
		? "and its commands run in its own sandbox without network."
		: "and the agent runs its commands without asking.");
