/** A control-only runner for the actor checks. Its private key and epoch live for one process. */
import { createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { connect, createServer, type Socket } from "node:net";
import type { PlatformConnection } from "../server/src/contract.js";
import { createClient, type Registry } from "../server/src/client.js";
import {
	MIN_RUNNER_VERSION,
	RUNNER_CONNECTION_PATH,
	RUNNER_PAIR_PATH,
	RUNNER_PAIR_POLL_PATH,
	connectionProof,
	controlProof,
	parsePairStarted,
	parsePairStatus,
	parseServerFrame,
	type PairPoll,
	type PairRequest,
	type Report,
	type RunnerFrame,
	type ServerFrame,
} from "../server/src/runner/control.js";

type Identity = { uid: string; machineId: string };
export const post = (origin: string, path: string, body: unknown) =>
	fetch(origin + path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(15_000),
	});

export class FakeRunner {
	readonly key = generateKeyPairSync("ed25519").privateKey;
	readonly epoch = randomUUID();
	maxTurns?: number;
	readonly report: Report = {
		kind: "report",
		docker: { ok: true },
		commandSandbox: { ok: true },
		freeDiskBytes: 1234567,
		sandboxes: [],
	};
	readonly details: PairRequest = {
		name: "Test machine",
		os: "Linux",
		arch: "arm64",
		runnerVersion: MIN_RUNNER_VERSION,
		publicKey: createPublicKey(this.key).export({ type: "spki", format: "pem" }).toString(),
	};
	sign(text: string) {
		return sign(null, Buffer.from(text), this.key).toString("base64url");
	}
	async pair(origin: string) {
		const res = await post(origin, RUNNER_PAIR_PATH, this.details);
		const pair = parsePairStarted(await res.json());
		if (res.status !== 201 || !pair) throw new Error(`Could not start pairing (HTTP ${res.status}).`);
		return pair;
	}
	async poll(origin: string, { pairing, pollSecret }: PairPoll) {
		return parsePairStatus(await (await post(origin, RUNNER_PAIR_POLL_PATH, { pairing, pollSecret })).json());
	}
	connection(origin: string, { uid, machineId }: Identity, time = Date.now()) {
		return post(origin, RUNNER_CONNECTION_PATH, {
			uid,
			machineId,
			time,
			signature: this.sign(connectionProof(uid, machineId, time)),
		});
	}
	async connect(
		connection: PlatformConnection,
		id: Identity,
		options: {
			epoch?: string;
			signature?: string;
			version?: string;
			offset?: number;
			beforeHello?: Promise<void>;
		} = {},
	) {
		const client = createClient<Registry>({
			endpoint: connection.endpoint!,
			namespace: connection.namespace,
			token: connection.token?.token ?? "default",
			disableMetadataLookup: true,
		});
		const ws: WebSocket = await client.machine.get([id.uid, id.machineId]).webSocket("control");
		const frames: ServerFrame[] = [];
		const send = (frame: RunnerFrame) => ws.send(JSON.stringify(frame));
		let signature = "";
		ws.addEventListener("message", async ({ data }) => {
			const frame = parseServerFrame(data);
			if (!frame) {
				ws.close(1002);
				return;
			}
			frames.push(frame);
			switch (frame.kind) {
				case "challenge":
					signature = this.sign(controlProof(id.uid, id.machineId, frame.nonce));
					await options.beforeHello;
					send({
						kind: "hello",
						maxTurns: this.maxTurns,
						slots: this.report.slots,
						signature: options.signature ?? signature,
						runnerVersion: options.version ?? MIN_RUNNER_VERSION,
						epoch: options.epoch ?? this.epoch,
						time: Date.now() + (options.offset ?? 0),
					});
					break;
				case "welcome":
					send(this.report);
					break;
				case "heartbeat":
					send({ kind: "heartbeat" });
					break;
				case "remove":
					send({ kind: "removed", sandbox: frame.sandbox });
					break;
				case "forget-backup":
					send({ kind: "backup-forgotten", sessionId: frame.sessionId });
					break;
			}
		});
		return { ws, frames, proof: () => signature, send };
	}
}

/** Cut traffic in both directions while leaving both TCP ends open, as on a silent link loss. */
export async function controlProxy(port: number) {
	const pipes = new Map<Socket, Socket>();
	const server = createServer(incoming => {
		const upstream = connect(port, "127.0.0.1");
		pipes.set(incoming, upstream);
		incoming.pipe(upstream).pipe(incoming);
		const close = () => {
			incoming.destroy();
			upstream.destroy();
			pipes.delete(incoming);
		};
		for (const socket of [incoming, upstream]) {
			socket.on("error", close);
			socket.on("close", close);
		}
	});
	await new Promise<void>((done, fail) => server.once("error", fail).listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("The control proxy needs a TCP port.");
	console.log(`Control proxy port: ${address.port}`);
	return {
		endpoint: `http://127.0.0.1:${address.port}`,
		drop() {
			if (!pipes.size) throw new Error("The control socket did not reach the proxy.");
			for (const [incoming, upstream] of pipes) {
				incoming.unpipe(upstream);
				upstream.unpipe(incoming);
				incoming.resume();
				upstream.resume();
			}
		},
		close() {
			for (const [incoming, upstream] of pipes) {
				incoming.destroy();
				upstream.destroy();
			}
			server.close();
		},
	};
}
