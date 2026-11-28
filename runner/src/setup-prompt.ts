/**
 * What the setup wizard asks through: the full-screen prompts (setup-tui.ts) or plain lines
 * (setup-lines.ts). Every question can answer BACK (the step before) or CANCEL (Escape).
 */
export const BACK: unique symbol = Symbol("back");
export const CANCEL: unique symbol = Symbol("cancel");
export type Answer<T> = T | typeof BACK | typeof CANCEL;

export interface Choice<T> {
	value: T;
	label: string;
	hint?: string;
}

export interface Prompter {
	/** True when a person can answer: questions are asked and a failed pairing can be tried again. */
	readonly interactive: boolean;
	/** The keys, as the welcome shows them; none without a terminal. */
	readonly keys?: string;
	intro(title: string): void;
	outro(message: string): void;
	/** A framed block of lines, such as the pairing code or the summary. `strong`: parts to set in bold. */
	note(title: string, lines: string[], strong?: string[]): void;
	log(kind: "info" | "success" | "warn" | "error" | "step", message: string): void;
	/** The pairing code and machine key to approve, where the prompter shows them its own way; else the wizard shows a note. */
	pairing?(code: string, key: string): void;
	select<T>(question: { message: string; options: Choice<T>[]; initial?: T }): Promise<Answer<T>>;
	multiselect<T>(question: { message: string; options: Choice<T>[]; initial: T[] }): Promise<Answer<T[]>>;
	/** `validate` returns the reason a value is refused, or undefined. */
	text(question: {
		message: string;
		initial: string;
		hint?: string;
		validate?: (value: string) => string | undefined;
	}): Promise<Answer<string>>;
	/** Runs `work` with a spinner; Escape aborts its signal and the answer is CANCEL. */
	wait<T>(
		message: string,
		work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>,
	): Promise<Answer<T>>;
}
