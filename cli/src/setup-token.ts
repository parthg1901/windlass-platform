/**
 * Runs `claude setup-token` for its user and reads the token it prints. It runs under a pseudo-terminal
 * (`script`), so Claude Code draws its usual screens and takes the user's input, while its output is copied to
 * this terminal (without the token: `TokenGate`) and kept in memory to read the token from. Nothing is written to disk.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { extractToken, TokenGate } from "./token.ts";

/** Output kept to read the token from: the newest part of it. */
const KEEP_BYTES = 2 * 1024 * 1024;

export function onPath(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.PATH ?? "").split(delimiter).some(dir => {
		if (!dir) return false;
		try {
			accessSync(join(dir, name), constants.X_OK);
			return true;
		} catch {
			return false;
		}
	});
}

/** `claude setup-token`, or through npx when Claude Code is not installed. Fixed words only: no quoting needed. */
export function setupTokenCommand(env: NodeJS.ProcessEnv = process.env): string[] {
	return onPath("claude", env) ? ["claude", "setup-token"] : ["npx", "-y", "@anthropic-ai/claude-code", "setup-token"];
}

/** The `script` invocation that runs `argv` under a pseudo-terminal, or null where there is none to use. */
export function underPty(
	argv: string[],
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): [string, string[]] | null {
	if (!onPath("script", env)) return null;
	if (platform === "linux") return ["script", ["-q", "-e", "-c", argv.join(" "), "/dev/null"]];
	if (platform === "darwin") return ["script", ["-q", "/dev/null", ...argv]];
	return null;
}

export interface SetupTokenRun {
	/** The token read off the output; null when none was found or the output could not be read. */
	token: string | null;
	/** Whether the output was read at all (a pseudo-terminal was available). */
	captured: boolean;
	exitCode: number | null;
}

export function runSetupToken(): Promise<SetupTokenRun> {
	const argv = setupTokenCommand();
	const pty = underPty(argv);
	return new Promise(resolve => {
		if (!pty) {
			// No pseudo-terminal: the user sees Claude Code as usual and pastes the token afterwards.
			const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
			child.once("error", () => resolve({ token: null, captured: false, exitCode: null }));
			child.once("close", code => resolve({ token: null, captured: false, exitCode: code }));
			return;
		}
		const child = spawn(pty[0], pty[1], { stdio: ["inherit", "pipe", "inherit"] });
		let kept: Buffer[] = [];
		let size = 0;
		const decoder = new StringDecoder("utf8");
		const gate = new TokenGate();
		child.stdout!.on("data", (chunk: Buffer) => {
			process.stdout.write(gate.write(decoder.write(chunk)));
			kept.push(chunk);
			size += chunk.length;
			while (size > KEEP_BYTES && kept.length > 1) size -= kept.shift()!.length;
		});
		child.once("error", () => resolve({ token: null, captured: false, exitCode: null }));
		child.once("close", code => {
			const output = Buffer.concat(kept).toString("utf8");
			kept = [];
			const token = extractToken(output);
			process.stdout.write(gate.end(token) + decoder.end());
			resolve({ token, captured: true, exitCode: code });
		});
	});
}
