/** The CLI's own terminal: what it shows, the browser it opens and what it reads from its user. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Server text is shown as plain text: no escapes or control characters reach the terminal. */
export const printable = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

export const say = (line = "") => process.stdout.write(line + "\n");

/** Opens `url` in the default browser. False when there is no way to (no display, no opener). */
export function openBrowser(url: string): Promise<boolean> {
	const [file, args] =
		process.platform === "darwin"
			? ["open", [url]]
			: process.platform === "win32"
				? ["rundll32", ["url.dll,FileProtocolHandler", url]]
				: ["xdg-open", [url]];
	if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
		return Promise.resolve(false);
	return new Promise(resolve => {
		try {
			const child = spawn(file, args, { stdio: "ignore", detached: true });
			child.once("error", () => resolve(false));
			child.once("spawn", () => {
				child.unref();
				resolve(true);
			});
		} catch {
			resolve(false);
		}
	});
}

/** Reads a line without echoing it. Ctrl-C quits. Only on a terminal. */
export function readHidden(question: string): Promise<string> {
	const input = process.stdin;
	if (!input.isTTY) return Promise.reject(new Error("Not a terminal"));
	process.stdout.write(question);
	return new Promise(resolve => {
		let line = "";
		input.setRawMode(true);
		input.resume();
		input.setEncoding("utf8");
		const done = () => {
			input.setRawMode(false);
			input.pause();
			input.off("data", onData);
			process.stdout.write("\n");
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === "\u0003") {
					done();
					process.exit(130);
				}
				if (ch === "\r" || ch === "\n") {
					done();
					resolve(line.trim());
					return;
				}
				if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
				else if (ch >= " ") line += ch;
			}
		};
		input.on("data", onData);
	});
}

/** Whether a person is at this terminal to answer a question. */
export const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** Reads one answered line. Only on a terminal. */
export function ask(question: string): Promise<string> {
	const lines = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise(resolve => {
		lines.question(question, answer => {
			resolve(answer.trim());
			lines.close();
		});
		lines.once("close", () => resolve(""));
	});
}

/** All of standard input, for `--token-stdin`. */
export async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8").trim();
}
