import { RETENTION_PATH, retentionRequest, signRetention, signRemoval } from "./runner/frame-auth.js";
import { randomBytes } from "node:crypto";
import { createClient } from "rivetkit/client";
import { createGrant, isActorGone } from "./actors/internal.js";
import { assertOrigin, serviceParams } from "./auth.js";
import { config, ownEngineEndpoint, signedRunnerEndpoint } from "./config.js";
import { platformConnection } from "./platform-info.js";
import type { Registry } from "./registry.js";
import { codeDigest, digest, machineError, newPairCode, publicSpki } from "./runner-keys.js";
import { AddressBudget, clientAddress, rateLimited, readJsonBody } from "./http-limits.js";
import { OLD_RUNNER } from "./runner/protocol.js";
import {
	CLOCK_TOLERANCE_MS,
	PAIRING_TTL_MS,
	RUNNER_CONNECTION_PATH,
	RUNNER_PAIR_PATH,
	RUNNER_PAIR_POLL_PATH,
	connectionProof,
	parseConnectionRequest,
	parsePairPoll,
	parsePairRequest,
} from "./runner/control.js";

const polls = new AddressBudget(config.httpLimits.runnerPoll);
const connections = new AddressBudget(config.httpLimits.runnerConnection);

const json = (status: number, body: unknown) =>
	Response.json(body, { status, headers: { "cache-control": "no-store" } });

const readBody = (request: Request) => readJsonBody(request, 4096);

export async function runnerResponse(request: Request): Promise<Response> {
	if (!config.machines) return json(404, { code: "not_found" });
	try {
		assertOrigin({ request });
	} catch {
		return json(403, { code: "origin_not_allowed" });
	}
	if (request.method !== "POST") return json(405, { code: "method_not_allowed" });
	const { pathname } = new URL(request.url);
	const address = clientAddress(request);
	if (pathname !== RUNNER_PAIR_PATH) {
		const budget = pathname === RUNNER_PAIR_POLL_PATH ? polls : connections;
		const admission = budget.take(address);
		if (admission) return rateLimited(admission, "This address has reached its runner request limit. Try again later.");
	}
	function refusedConnection(response: Response): Response {
		const retry = address === null && pathname === RUNNER_CONNECTION_PATH ? connections.refusal(address) : 0;
		return retry ? rateLimited(retry, "Too many refused runner connections. Try again later.") : response;
	}
	try {
		const body = await readBody(request);
		if (body instanceof Response) return refusedConnection(body);
		const client = createClient<Registry>({ endpoint: ownEngineEndpoint() });
		const params = serviceParams();
		if (pathname === RUNNER_PAIR_PATH) {
			const input = parsePairRequest(body.value);
			const publicKey = input && publicSpki(input.publicKey);
			if (!input || !publicKey) return json(400, { code: "bad_input" });
			if (config.machines.identity && input.protocol !== 2)
				return json(426, { code: "runner_outdated", message: OLD_RUNNER });
			if (input.protocol === 2 && !config.machines.identity) return json(409, { code: "signing_disabled" });
			const code = newPairCode();
			const pairing = randomBytes(32).toString("base64url");
			const pollSecret = randomBytes(32).toString("base64url");
			const expires = await client.pairingDirectory
				.getOrCreate(["starts"], { params })
				.internalStart(codeDigest(code)!, pairing, publicKey);
			if (!expires)
				return rateLimited(
					PAIRING_TTL_MS / 1000,
					"Too many pairings have started. Try again after the pairing codes expire.",
					"too_many_pairings",
				);
			const { name, os, arch, runnerVersion } = input;
			await client.machinePairing.create([pairing], {
				params,
				input: {
					grant: createGrant("machinePairing", [pairing]),
					publicKey,
					details: { name, os, arch, runnerVersion },
					pollHash: digest(pollSecret),
					expires,
				},
			});
			return json(201, { code, pairing, pollSecret });
		}
		if (pathname === RUNNER_PAIR_POLL_PATH) {
			const input = parsePairPoll(body.value);
			if (!input) return json(400, { code: "bad_input" });
			try {
				const status = await client.machinePairing
					.get([input.pairing], { params })
					.internalPoll(digest(input.pollSecret));
				return json(200, status);
			} catch (error) {
				if (isActorGone(error)) return json(200, { state: "gone" });
				throw error;
			}
		}
		const input = parseConnectionRequest(body.value);
		if (!input) return refusedConnection(json(400, { code: "bad_input" }));
		const now = Date.now();
		if (Math.abs(now - input.time) > CLOCK_TOLERANCE_MS) return json(403, { reason: "clock", serverTime: now });
		const { uid, machineId, signature, time } = input;
		const retention = pathname === RETENTION_PATH;
		if (retention && (!input.nonce || !config.machines.identity)) return json(403, { code: "signed_runner_required" });
		const statement = retention
			? retentionRequest(uid, machineId, time, input.nonce!)
			: connectionProof(uid, machineId, time, input.nonce);
		const result = await client.machine
			.get([uid, machineId], { params })
			.internalConnection(statement, signature, address === null)
			.catch(error => {
				if (isActorGone(error)) return "unknown" as const;
				throw error;
			});
		if (result === "unknown") return refusedConnection(json(403, { reason: "unknown" }));
		if (typeof result === "object" && "retryAfter" in result)
			return rateLimited(result.retryAfter, "This machine has reached its connection limit. Try again later.");
		if (result !== "active") {
			const identity = config.machines.identity;
			return json(
				410,
				identity && input.nonce
					? signRemoval(uid, machineId, input.nonce, result.removeSandboxes, identity)
					: { reason: "removed", removeSandboxes: result.removeSandboxes },
			);
		}
		if (retention) {
			const generations = config.snapshots
				? await client.user
						.get([uid], { params })
						.internalSnapshotGenerations()
						.catch(error => {
							if (isActorGone(error)) return [];
							throw error;
						})
				: [];
			return json(200, signRetention(statement, generations, config.machines.identity!));
		}
		const connection = await platformConnection();
		const endpoint = config.machines.identity
			? signedRunnerEndpoint(config.machines.publicUrl)
			: (connection.endpoint ?? (config.engine.remote ? null : ownEngineEndpoint()));
		return json(200, { ...connection, endpoint, endpointChange: config.machines.identity?.endpointChange });
	} catch (error) {
		machineError("runner HTTP request", error);
		return json(503, { code: "connection_unavailable" });
	}
}
