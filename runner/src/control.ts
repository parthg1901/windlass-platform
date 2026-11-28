// Pair a machine and maintain its control socket. Session sockets survive ordinary reconnects.
import { snapshotMaintenance } from "./snapshot-retention.js";
import {
	authFailure,
	authorizeEndpoint,
	endpointChanged,
	fingerprint,
	FrameAuthError,
	runnerHandshake,
	verifyRemoval,
	type FrameAuth,
	type Trust,
} from "../../server/src/runner/frame-auth.js";
import { reportPublisher } from "../../server/src/runner/catalog.js";
import { generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import {
	MAX_CONTROL_FRAME_BYTES,
	CONTROL_DEAD_MS,
	CONTROL_HEARTBEAT_MS,
	PAIRING_POLL_MS,
	PAIRING_TTL_MS,
	REFUSED_RETRY_MS,
	REPORT_MS,
	RUNNER_CONNECTION_PATH,
	RUNNER_PAIR_PATH,
	RUNNER_PAIR_POLL_PATH,
	connectionProof,
	controlProof,
	sessionProof,
	machineKeyFingerprint,
	parseConnection,
	parseConnectionRefusal,
	parsePairStarted,
	parsePairStatus,
	parseServerFrame,
	refuse,
	reportFor,
	type Capability,
	type ConnectionRequest,
	type PairRequest,
	type PairPoll,
	type Refusal,
	type RunnerFrame,
	type ServerFrame,
} from "../../server/src/runner/control.js";
import type { MachineProfile } from "../../server/src/runner/protocol.js";
import { audit, safeSentence } from "./audit.js";
import { Executor } from "./docker-executor.js";
import { Session } from "./session.js";
import { RunnerError, VERSION, origin, storePair } from "./state.js";

const epoch = randomUUID();
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 15_000;

function proof(key: KeyObject, statement: string) {
	return sign(null, Buffer.from(statement), key).toString("base64url");
}

// Error messages from fetch and the gateway can include a credential-bearing URL.
export function category(error: unknown): string {
	if (error instanceof FrameAuthError) return error.category === "endpoint" ? endpointChanged : error.message;
	if (error instanceof RunnerError) return error.message;
	for (let e = error; e instanceof Error; e = e.cause) {
		const code = (e as NodeJS.ErrnoException).code ?? "";
		if (["EAI_AGAIN", "ENOTFOUND"].includes(code)) return "DNS name resolution failed.";
		if (/CERT|TLS|SSL/.test(code)) return "TLS certificate or handshake failed.";
		if (
			["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "ENOENT", "EACCES", "ENOSPC"].includes(
				code,
			)
		)
			return code;
		if (e.name === "TimeoutError") return "The connection timed out.";
	}
	return "Connection or local I/O failed. Check the endpoint, Docker socket and state volume.";
}
async function post(
	platform: string,
	path: string,
	body: PairRequest | PairPoll | ConnectionRequest,
	signal: AbortSignal,
	timeoutMs = 15_000,
) {
	const response = await fetch(platform + path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
	});
	// The platform is untrusted. Even an HTTP error body must not grow without a bound.
	let bytes = 0;
	const parts: Uint8Array[] = [];
	for await (const chunk of response.body ?? []) {
		bytes += chunk.length;
		if (bytes > 16_384) throw new RunnerError("The platform sent an oversized HTTP answer.");
		parts.push(chunk);
	}
	let value: unknown;
	try {
		value = JSON.parse(Buffer.concat(parts).toString("utf8"));
	} catch {
		/* Status still tells us whether to retry. */
	}
	return { status: response.status, value };
}
export async function pair(
	platform: string,
	signal: AbortSignal,
	say: (message: string) => void,
	name: string,
	profiles?: MachineProfile[],
	setup = false,
) {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const deadline = AbortSignal.any([signal, AbortSignal.timeout(PAIRING_TTL_MS)]);
	const request: PairRequest = {
		protocol: 2,
		publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
		name,
		os: process.platform,
		arch: process.arch,
		runnerVersion: VERSION,
	};
	const again = setup
		? "re-run the setup command to get a new code."
		: "restart the container or run `windlass-runner pair` to get a new code.";
	let response;
	for (let attempt = 1; ; attempt++) {
		try {
			response = await post(platform, RUNNER_PAIR_PATH, request, deadline);
			if (response.status < 500 || attempt === 3) break;
		} catch (error) {
			if (deadline.aborted || attempt === 3)
				return { idle: `Pairing could not start (${category(error)}), so ${again}` };
		}
		say("Pairing could not start yet. Trying again.");
		await wait(PAIRING_POLL_MS, undefined, { signal: deadline }).catch(() => {});
	}
	if (response.status === 409 && (response.value as { code?: unknown } | null)?.code === "signing_disabled")
		return {
			idle: "This runner needs signed runner connections enabled on the platform. Ask the operator to enable them, then pair again.",
		};
	const started = parsePairStarted(response.value);
	if (response.status < 200 || response.status >= 300 || !started)
		return { idle: `Pairing was refused (HTTP ${response.status}), so ${again}` };
	const poll = { pairing: started.pairing, pollSecret: started.pollSecret };
	say(`Open ${platform}/machines/add and enter ${started.code}`);
	say(
		`Machine key: ${machineKeyFingerprint(request.publicKey)}. Check that the page shows the same before you connect. If someone gave you a code to enter, stop.`,
	);
	while (!deadline.aborted) {
		await wait(PAIRING_POLL_MS, undefined, { signal: deadline }).catch(() => {});
		if (deadline.aborted) break;
		try {
			response = await post(platform, RUNNER_PAIR_POLL_PATH, poll, deadline);
		} catch (error) {
			if (!deadline.aborted) say("Pairing: " + category(error));
			continue;
		}
		if (response.status >= 500 || response.status === 429) {
			say(`Pairing: HTTP ${response.status}; trying again.`);
			continue;
		}
		const status = parsePairStatus(response.value);
		if (response.status < 200 || response.status >= 300 || !status)
			return { idle: `Pairing was refused (HTTP ${response.status}), so ${again}` };
		if (status.state === "gone") break;
		if (status.state === "approved") {
			if (!status.platformRoot || !status.endpoint)
				return {
					idle: "This runner needs signed runner messages enabled on the platform. Pair again after the operator enables them.",
				};
			const endpoint = origin(status.endpoint);
			if (platform.startsWith("https:") && !endpoint.startsWith("https:"))
				throw new RunnerError("The gateway needs HTTPS.");
			say("Platform key fingerprint: " + fingerprint(status.platformRoot));
			const paired = storePair({ machineId: status.machineId, uid: status.uid }, privateKey, platform, profiles, {
				endpoint,
				platformRoot: status.platformRoot,
				maxSerial: 0,
			});
			say(
				`Paired with ${safeSentence(status.githubLogin ?? "an account without a GitHub login")}. If that is not you, run \`windlass-runner pair\` again.`,
			);
			return { paired };
		}
	}
	return { idle: `The pairing code expired or was denied, so ${again}` };
}

async function openSocket(opening: Promise<WebSocket>, signal: AbortSignal) {
	const limit = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
	return new Promise<WebSocket>((resolve, reject) => {
		let socket: WebSocket | undefined;
		const done = () => {
			limit.removeEventListener("abort", abort);
			socket?.removeEventListener("open", opened);
			socket?.removeEventListener("close", closed);
		};
		const opened = () => {
			done();
			resolve(socket!);
		};
		const closed = (e: CloseEvent) => {
			done();
			reject(new RunnerError(`Socket closed during open (code ${e.code}).`));
		};
		const abort = () => {
			done();
			socket?.close();
			reject(new RunnerError("The gateway socket did not open in time."));
		};
		limit.addEventListener("abort", abort);
		opening.then(
			ws => {
				socket = ws;
				if (limit.aborted) return abort();
				if (ws.readyState === 1) return opened();
				if (ws.readyState > 1) {
					done();
					reject(new RunnerError("The gateway closed before opening the socket."));
					return;
				}
				ws.addEventListener("close", closed);
				ws.addEventListener("open", opened);
			},
			error => {
				done();
				reject(error);
			},
		);
	});
}

// A welcome without named capabilities is valid for released peers.
function applyCapabilities(owner: Executor, named: readonly string[] | undefined, signed: boolean) {
	const has = (capability: Capability) => named?.includes(capability) === true;
	owner.sessionVolumes = has("session-volumes");
	owner.harnessKeyRelays = has("harness-key-relay");
	owner.blockedNetwork = has("blocked-network");
	owner.memoryEvents = has("memory-events");
	owner.warmSpares = signed && has("warm-spares");
	owner.spareReseed = owner.warmSpares && has("spare-reseed");
	owner.spareSetupTimes = has("spare-setup-times");
	owner.startTimes = has("start-times");
	owner.environmentImage = has("environment-image");
	owner.sessionBackups = has("session-backups");
}

export async function control(
	owner: Executor,
	key: KeyObject,
	platform: string,
	signal: AbortSignal,
	saveStatus: (connection: string, idleSuspendMs?: number) => void,
	initialIdle: number | undefined,
	name: string,
	trust: Trust | null,
) {
	// Gateway diagnostics can contain the access URL. Only our categorised errors go to the owner.
	process.env.RIVET_LOG_LEVEL = "silent";
	const { createClient } = await import("rivetkit/client");
	const { uid, machineId } = owner.identity;
	const sessions = new Map<string, Session>();
	const maintainSnapshots = snapshotMaintenance(owner.identity, key, platform, trust, () => owner.storeLimits());
	let idle = initialIdle;
	let state = "";
	let offset = 0;
	let backoff = 1000;
	let lastSent = 0;
	function status(connection: string) {
		if (connection !== state) saveStatus(connection, idle);
		state = connection;
		console.log(connection);
		audit(null, null, "control", connection);
	}
	// A refused copy of the key must never idle-stop a sandbox used by the accepted runner.
	let removed = false;
	let mayMaintain = false;
	let spareServiceOnline = false;
	let maintaining = false;
	let lastRefresh = 0;
	const maintain = async () => {
		if (maintaining || !mayMaintain) return;
		maintaining = true;
		try {
			await owner.serial(async () => {
				if (!mayMaintain) return;
				if (Date.now() - lastRefresh >= REPORT_MS) {
					await owner.refresh();
					lastRefresh = Date.now();
				}
				if (mayMaintain && idle !== undefined)
					await owner.idle(idle, id => sessions.get(id)?.channel.connected === true);
			});
			if (mayMaintain && spareServiceOnline) await owner.maintainSpares(() => spareServiceOnline);
			if (Date.now() - lastSent >= REPORT_MS) owner.publishReport?.();
			if (mayMaintain) await maintainSnapshots(Date.now() + offset);
		} catch (error) {
			audit(null, null, "maintenance", category(error));
		} finally {
			maintaining = false;
		}
	};
	const timer = setInterval(() => void maintain(), 1000);
	async function stopSessions() {
		const current = [...sessions.values()];
		for (const s of current) s.channel.close();
		await Promise.all(current.map(s => s.orphaned));
		sessions.clear();
	}
	try {
		if (trust) console.log("Platform key fingerprint: " + fingerprint(trust.pin.platformRoot));
		status("Connecting");
		while (!signal.aborted) {
			let refusal: Refusal | undefined;
			let discarding: Promise<void> | undefined;
			let slow = false;
			let reason = "Disconnected";
			const attempt = new AbortController();
			const active = AbortSignal.any([signal, attempt.signal]);
			try {
				async function connectGateway(
					purpose: "connect" | "renew",
					correctClock = true,
				): Promise<{ endpoint: string; refreshAt: number; client: ReturnType<typeof createClient> }> {
					// The lease ages even while a laptop is asleep. Apply server clock
					// correction only to the signed timestamp, not to its relative lifetime.
					const started = Date.now();
					const time = started + offset;
					const nonce = trust ? randomBytes(32).toString("base64url") : undefined;
					const response = await post(
						platform,
						RUNNER_CONNECTION_PATH,
						{ uid, machineId, time, nonce, signature: proof(key, connectionProof(uid, machineId, time, nonce)) },
						active,
						CONNECT_TIMEOUT_MS,
					);
					if (response.status !== 200) {
						const r = parseConnectionRefusal(response.value);
						if (response.status === 403 && r?.reason === "clock" && correctClock) {
							offset = r.serverTime - Date.now();
							audit(null, null, "control", "HTTP 403; signing with corrected time");
							if (purpose === "connect") return connectGateway(purpose, false);
						}
						if (response.status === 410 && r?.reason === "removed") {
							if (trust) {
								if (!nonce || !("sig" in r)) throw new FrameAuthError("signature");
								verifyRemoval(uid, machineId, nonce, r, trust);
							}
							refusal = refuse("removed", r);
						} else if (!trust && response.status === 403 && r?.reason === "unknown") refusal = refuse("unknown");
						if (purpose === "connect" && response.status >= 400 && response.status < 500) slow = true;
						throw new RunnerError(`HTTP ${response.status}`);
					}
					const info = parseConnection(response.value);
					if (!info) throw new RunnerError("Invalid HTTP connection answer.");
					const endpoint = origin(info.endpoint ?? platform);
					if (platform.startsWith("https:") && !endpoint.startsWith("https:"))
						throw new RunnerError("The gateway needs HTTPS.");
					if (trust) {
						authorizeEndpoint(trust.pin, endpoint, info.endpointChange);
						if (purpose === "renew" && endpoint !== trust.pin.endpoint) {
							reason = "Reconnecting to confirm the signed gateway change.";
							attempt.abort();
							throw new RunnerError(reason);
						}
					}
					return {
						endpoint,
						refreshAt: info.token ? started + info.token.validForMs * 0.8 : Infinity,
						client: createClient({
							endpoint,
							namespace: info.namespace,
							token: info.token?.token,
							disableMetadataLookup: true,
						}),
					};
				}
				let gateway = await connectGateway("connect");
				let refreshing: Promise<void> | undefined;
				async function currentClient() {
					if (Date.now() >= gateway.refreshAt) {
						refreshing ??= connectGateway("renew")
							.then(next => {
								gateway = next;
							})
							.finally(() => {
								refreshing = undefined;
							});
						await refreshing;
					}
					return gateway.client;
				}
				const ws = await openSocket(gateway.client.machine.get([uid, machineId]).webSocket("control"), active);
				let auth: FrameAuth | undefined;
				let exchange: ReturnType<typeof runnerHandshake> | undefined;
				const send = (f: RunnerFrame) => ws.send(auth ? auth.seal(f) : JSON.stringify(f));
				let phase: "challenge" | "welcome" | "online" = "challenge";
				let heard = Date.now();
				let reportReady = false;
				let policyReady: Promise<void>;
				lastSent = Date.now();
				const publish = reportPublisher(send);
				// What this socket's server said it reads (its welcome). An older server names nothing.
				let named: readonly string[] | undefined;
				owner.publishReport = () => {
					if (!reportReady || phase !== "online" || ws.readyState !== 1) return;
					publish({ ...reportFor(owner.report(), named), name });
					lastSent = Date.now();
				};
				const attaching = new Map<string, string>();
				let closing = false;
				const disconnect = () => {
					closing = true;
					ws.close();
				};
				const closed = new Promise<void>(resolve =>
					ws.addEventListener("close", e => {
						if (e.code === 1008 || (e.code >= 4000 && e.code < 5000)) slow = true;
						reason += ` (socket close ${e.code})`;
						resolve();
					}),
				);
				const heartbeat = setInterval(() => {
					if (Date.now() - heard >= CONTROL_DEAD_MS) disconnect();
					else if (phase === "online" && ws.readyState === 1) send({ kind: "heartbeat" });
				}, CONTROL_HEARTBEAT_MS);
				active.addEventListener("abort", disconnect);
				function rejectConnection(frame: Refusal) {
					refusal = frame;
					mayMaintain = false;
					discarding = stopSessions();
					disconnect();
				}
				const message = async (f: ServerFrame) => {
					heard = Date.now();
					if (f.kind === "refused") return rejectConnection(f);
					if (phase === "challenge" && f.kind === "challenge") {
						phase = "welcome";
						const base = {
							kind: "hello" as const,
							maxTurns: owner.maxTurns,
							slots: owner.slots,
							runnerVersion: VERSION,
							epoch,
							time: Date.now(),
						};
						if (trust) {
							const started = runnerHandshake({ uid, machineId, challenge: f.nonce }, base, key);
							exchange = started;
							send(started.hello);
						} else send({ ...base, signature: proof(key, controlProof(uid, machineId, f.nonce)) });
					} else if (phase === "welcome" && f.kind === "welcome") {
						if (trust && "refusal" in f && f.refusal) return rejectConnection(f.refusal);
						phase = "online";
						idle = f.idleSuspendMs;
						backoff = 1000;
						named = f.capabilities;
						applyCapabilities(owner, named, !!trust);
						owner.platformGitHost(f.gitHost);
						owner.platformStoreCaps(f.storeLimits);
						mayMaintain = true;
						status("Online");
						lastRefresh = Date.now();
						policyReady = owner.checkAuthenticatedNetwork();
						await policyReady;
						if (active.aborted || ws.readyState !== 1 || refusal) return;
						await owner.welcome(active);
						reportReady = !active.aborted;
						spareServiceOnline = reportReady && owner.warmSpares;
						if (!active.aborted) owner.publishReport?.();
					} else if (phase !== "online") {
						reason = "Unexpected control handshake";
						disconnect();
					} else if (f.kind === "attach") {
						await policyReady;
						if (active.aborted || sessions.get(f.sessionId)?.refused) return;
						attaching.set(f.sessionId, f.ticket);
						try {
							const client = await currentClient();
							if (active.aborted || attaching.get(f.sessionId) !== f.ticket) return;
							const socket = await openSocket(client.agentSession.get([uid, f.sessionId]).webSocket("runner"), active);
							if (active.aborted || refusal || ws.readyState !== 1 || attaching.get(f.sessionId) !== f.ticket) {
								socket.close();
								return;
							}
							socket.addEventListener("close", e => audit(f.sessionId, null, "session", `socket close ${e.code}`));
							let session = sessions.get(f.sessionId);
							if (session?.refused) {
								socket.close();
								return;
							}
							if (!session) {
								session = new Session(f.sessionId, owner, () => {
									if (sessions.get(f.sessionId) === session) sessions.delete(f.sessionId);
								});
								sessions.set(f.sessionId, session);
							}
							session.attach(
								socket,
								{
									machineId,
									runnerVersion: VERSION,
									ticket: f.ticket,
									signature: trust ? "" : proof(key, sessionProof(uid, f.sessionId, machineId, f.ticket)),
								},
								trust ? { uid, sessionId: f.sessionId, machine: key, trust, endpoint: gateway.endpoint } : undefined,
							);
						} catch (error) {
							audit(f.sessionId, null, "attach", category(error));
							if (refusal) {
								reason = category(error);
								disconnect();
							}
						} finally {
							if (attaching.get(f.sessionId) === f.ticket) attaching.delete(f.sessionId);
						}
					} else if (f.kind === "remove") {
						const sandbox = /^mm_[0-9a-f]{16}-[0-9a-f]{12}$/.test(f.sandbox) ? f.sandbox : null;
						try {
							await owner.serial(() => owner.requestedRemoval(f.sandbox));
						} catch (error) {
							audit(null, sandbox, "remove", category(error));
							return;
						}
						audit(null, sandbox, "remove", "done");
						if (ws.readyState === 1) send({ kind: "removed", sandbox: f.sandbox });
					} else if (f.kind === "forget-backup") {
						// Only a server that named `session-backups` sends it, and only it reads the answer.
						if (!owner.sessionBackups) return;
						try {
							await owner.backups.remove(f.sessionId);
						} catch (error) {
							audit(f.sessionId, null, "forget-backup", category(error));
							return;
						}
						audit(f.sessionId, null, "forget-backup", "done");
						if (ws.readyState === 1) send({ kind: "backup-forgotten", sessionId: f.sessionId });
					} else if (f.kind === "forget-claude-login") {
						let ok = true;
						try {
							await owner.forgetClaudeLogin();
						} catch (error) {
							ok = false;
							audit(null, null, "forget-claude-login", category(error));
						}
						if (ok) audit(null, null, "forget-claude-login", "done");
						if (ws.readyState === 1) send({ kind: "claude-login-forgotten", ok });
					} else if (f.kind !== "heartbeat") {
						reason = "Unexpected control frame";
						disconnect();
					}
				};
				const failed = (error: unknown) => {
					reason = category(error);
					if (error instanceof FrameAuthError) audit(null, null, "control", authFailure(error));
					disconnect();
				};
				ws.addEventListener("message", ({ data }) => {
					if (closing || active.aborted || refusal || ws.readyState !== 1) return;
					try {
						const f = parseServerFrame(auth ? auth.open(data, MAX_CONTROL_FRAME_BYTES) : data, !!trust);
						if (!f) {
							if (trust) throw new FrameAuthError("schema");
							disconnect();
							return;
						}
						if (trust && !auth) {
							if (f.kind === "refused" && f.reason === "signing-disabled")
								throw new RunnerError(
									"This runner requires signed connections. Check the platform setting with its operator.",
								);
							if (f.kind !== phase) throw new FrameAuthError("handshake");
						}
						if (trust && auth && (f.kind === "welcome" || f.kind === "challenge")) throw new FrameAuthError("schema");
						if (trust && f.kind === "welcome") {
							if (phase !== "welcome" || !exchange || !("platformEph" in f)) throw new FrameAuthError("handshake");
							auth = exchange.finish(f, trust, gateway.endpoint);
						}
						void message(f).catch(failed);
					} catch (error) {
						failed(error);
					}
				});
				try {
					if (active.aborted) disconnect();
					await closed;
				} finally {
					clearInterval(heartbeat);
					active.removeEventListener("abort", disconnect);
				}
			} catch (error) {
				reason = category(error);
			} finally {
				attempt.abort();
				owner.publishReport = undefined;
				spareServiceOnline = false;
				// Session sockets can outlive control. Keep their negotiated connect fields.
				if (owner.warmSpares) owner.stopSpares();
			}
			if (signal.aborted) break;
			if (refusal || slow) {
				mayMaintain = false;
				idle = undefined;
				if (refusal || !trust) await (discarding ?? stopSessions());
				if (refusal?.reason === "removed") {
					removed = true;
					audit(null, null, "control", reason);
					const action = refusal.removeSandboxes ? "prune" : "suspend";
					let warning = "";
					try {
						await owner.serial(() => (action === "prune" ? owner.prune() : owner.suspendAll()));
					} catch (error) {
						audit(null, null, action, category(error));
						warning = ` Docker could not ${action} all of its sandboxes. Check the runner log.`;
					}
					return (
						"This machine was removed from its account, so run `windlass-runner pair` to pair it again with a new key." +
						warning
					);
				}
				if (refusal) reason = `${refusal.reason}: ${safeSentence(refusal.message)} (${reason})`;
				const retryAt = new Date(Date.now() + REFUSED_RETRY_MS).toUTCString();
				status(`${reason}. The runner will try again in ten minutes (${retryAt}).`);
			} else {
				// A restarted runner can lose the network before its first welcome. The last
				// accepted idle time is still the dead-man switch for its existing containers.
				mayMaintain = idle !== undefined;
				status("Offline: " + reason);
			}
			// Jitter the capped interval too, so runners behind one outage stay spread out.
			await wait(refusal || slow ? REFUSED_RETRY_MS : backoff * (0.75 + Math.random() * 0.25), undefined, {
				signal,
			}).catch(() => {});
			backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
		}
	} finally {
		mayMaintain = false;
		clearInterval(timer);
		await stopSessions();
		if (!removed) status("Stopped");
	}
}
