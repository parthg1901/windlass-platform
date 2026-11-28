/**
 * The setup wizard for `npx @windlassai/cli connect --machine` (`setup --connect`): nobody answers, so every
 * question takes its default, and what the setup says goes out as one JSON line each (`SetupEvent`), which the
 * CLI shows on the person's terminal. Notes, such as the summary, are left out: the CLI says what matters.
 */
import type { SetupEvent } from "../../server/src/contract/machine-setup.js";
import { CANCEL, type Answer, type Choice, type Prompter } from "./setup-prompt.js";

export class EventPrompter implements Prompter {
	readonly interactive = false;

	constructor(private readonly out: NodeJS.WritableStream = process.stdout) {}

	private send(event: SetupEvent) {
		this.out.write(JSON.stringify(event) + "\n");
	}

	intro() {}
	note() {}
	outro(text: string) {
		this.send({ event: "done", text });
	}
	log(kind: "info" | "success" | "warn" | "error" | "step", text: string) {
		this.send({ event: "log", level: kind === "step" ? "info" : kind, text });
	}
	pairing(code: string, key: string) {
		this.send({ event: "pairing", code, key });
	}

	async select<T>(q: { options: Choice<T>[]; initial?: T }): Promise<Answer<T>> {
		return q.options.find(o => o.value === q.initial)?.value ?? q.options[0]!.value;
	}
	async multiselect<T>(q: { initial: T[] }): Promise<Answer<T[]>> {
		return q.initial;
	}
	/** The default, or Cancel when even that is refused: nobody can type another. */
	async text(q: { message: string; initial: string; validate?: (value: string) => string | undefined }) {
		const problem = q.validate?.(q.initial);
		if (!problem) return q.initial;
		this.log("error", `${q.message}: ${problem}`);
		return CANCEL;
	}
	async wait<T>(
		text: string,
		work: (signal: AbortSignal, update: (message: string) => void) => Promise<T>,
	): Promise<Answer<T>> {
		this.send({ event: "step", text });
		return work(new AbortController().signal, update => this.send({ event: "progress", text: update }));
	}
}
