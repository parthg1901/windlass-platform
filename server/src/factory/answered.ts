import type { ChoiceId } from "../contract.js";
import { harnessName } from "../sandbox/harnesses.js";

export const CHOICES: Record<ChoiceId, string> = {
	use_machine_payer: "Use the offered machine and payer",
	use_hosted: "Run on Hosted",
	use_windlass: harnessName("windlass"),
	use_claude: harnessName("claude"),
	use_opencode: harnessName("opencode"),
	send_back: "Hand it back",
	dismiss: "Dismiss",
	send: "Send it to the agent",
	leave: "Leave it",
	run_single: "Approve the current Windlass session as one implementer",
	orchestrate_anyway: "Ask for subtasks",
	approve: "Approve the plan",
	revise: "Revise the plan",
	raise: "Go on",
	retry: "Start over (discards the sandbox's work)",
	again: "Try again",
	wait: "Keep waiting",
	hand_over: "Hand it over as it is",
	run_checks: "Run the checks again",
	ci_alone: "Integrate on CI alone",
	update_feature: "Update the feature",
	update_from_base: "Update from the base branch and run CI again",
	give_up: "Give up",
	add_secret: "Add it and continue",
	without_secret: "Continue without it",
	fix: "Have the agent change it",
	reply: "Answer the agent",
	run_anyway: "Run it anyway",
	fresh_sandbox: "Start on a fresh sandbox",
	larger_sandbox: "Go on in a larger sandbox",
};
export const choice = (id: ChoiceId) => ({ id, label: CHOICES[id] });
/** The same choices in at most 30 characters, for buttons with little room (Slack cuts a button at 75). */
export const SHORT_CHOICES: Partial<Record<ChoiceId, string>> = {
	use_machine_payer: "Use offered machine and payer",
	run_single: "Approve as one implementer",
	orchestrate_anyway: "Split into parts",
	approve: "Approve",
	revise: "Request changes",
	retry: "Start over, discarding work",
	update_from_base: "Update from base, rerun CI",
};
/** A choice's short label. A question's own wording of a choice is kept, except one implementer, which means one thing. */
export function shortLabel(picked: { id: ChoiceId; label: string }): string {
	const short = SHORT_CHOICES[picked.id];
	return short && (picked.label === CHOICES[picked.id] || picked.id === "run_single") ? short : picked.label;
}

// A reply logs the owner's answer directly, without its button label.
export function answeredWords(picked: { id: ChoiceId; label: string }, note: string | null): string {
	const end = (text: string) => (/[.!?…]["”’)]?$/.test(text) ? "" : ".");
	if (picked.id === "reply" && note !== null) return `Answered: ${note}${end(note)}`;
	return note === null ? `Answered “${picked.label}”.` : `Answered “${picked.label}”: ${note}${end(note)}`;
}
