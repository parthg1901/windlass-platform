/** A stand-in platform for the connect command's three routes, and the CLI run the way a user runs it. */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
export const REQUEST = "r".repeat(43);

/** `connect`: the handover's status, or successive handovers' (the last one repeats), each answered with `body`. */
export type Plan = { decision: "approved" | "denied"; connect: number | number[]; body?: unknown };

/** The platform's three routes: approval arrives on the second poll; the connect answer is the case's. */
export async function platform(plan: Plan) {
	const seen: { path: string; body: Record<string, unknown> }[] = [];
	let polls = 0;
	let handovers = 0;
	const read = async (req: IncomingMessage) => {
		let text = "";
		for await (const chunk of req) text += chunk;
		return JSON.parse(text) as Record<string, unknown>;
	};
	const server = createServer(async (req, res) => {
		const body = await read(req);
		seen.push({ path: req.url!, body });
		const send = (status: number, answer: unknown) =>
			res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
		if (req.url === "/platform/connect/start")
			return send(201, {
				userCode: "KQ2M-8XF4",
				approveUrl: `http://127.0.0.1:1/connect?code=KQ2M-8XF4&plan=${String(body.provider)}`,
				request: REQUEST,
				expiresAt: Date.now() + 600_000,
				interval: 1_000,
			});
		if (req.url === "/platform/connect/poll") return send(200, { state: ++polls < 2 ? "pending" : plan.decision });
		if (req.url === "/platform/connect") {
			const statuses = [plan.connect].flat();
			const status = statuses[Math.min(handovers++, statuses.length - 1)]!;
			return send(status, plan.body ?? { account: "a@b.com · Max" });
		}
		send(404, {});
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	after(() => server.close());
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

/** Runs `windlassai <args>` with `bin` first on PATH and no display, so no browser opens. */
export function cli(bin: string, args: string[], env: Record<string, string>, stdin = "") {
	const child = spawn(process.execPath, [MAIN, ...args], {
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DISPLAY: "", WAYLAND_DISPLAY: "", ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(stdin);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", chunk => (stdout += chunk));
	child.stderr.on("data", chunk => (stderr += chunk));
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve =>
		child.on("close", code => resolve({ code, stdout, stderr })),
	);
}
