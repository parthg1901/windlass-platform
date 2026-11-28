// Carry ACP stdio over the real runner's session channel. Only the WebSocket transport is in memory.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Session } from '../../runner/src/session.ts';
import { ServerChannel } from '../../server/src/runner/channel.ts';
import { RunnerLink, machineLayer } from '../../server/src/sandbox/runner-layer.ts';
import { AcpHarness } from '../../server/src/sandbox/acp-harness.ts';
import { turnCredential } from '../../server/src/actors/agent-session.ts';
import { OPENCODE, CODEX } from '../../server/src/sandbox/harnesses.ts';
import { turnRefusal } from '../../server/src/provider-refusal.ts';

export async function channelTurn(owner, session, id, model, expectedFailure, codex, { providers = [], source = null } = {}) {
	if (providers.length) {
		const { config } = await import('../../server/src/config.ts');
		config.modelRelay.on = true;
		config.modelRelay.url = { origin: 'https://relay.fixture.test', host: 'relay.fixture.test' };
		owner.harnessKeyRelays = true;
	}
	const runner = new Session(session, owner, () => {});
	const messages = [new EventEmitter(),new EventEmitter()];
	const endpoint = side => ({
		send: data => { codex?.observe(data); queueMicrotask(() => messages[1-side].emit('message',data)); },
		onMessage: fn => messages[side].on('message',fn),
		close() {}, onClose() {},
	});
	const connected = Promise.withResolvers();
	const server = new ServerChannel({accept: hello => hello.machineId === owner.identity.machineId, onConnect: connected.resolve});
	server.attach(endpoint(0));
	runner.channel.attach(endpoint(1), {machineId:owner.identity.machineId,ticket:'test',signature:'fixture',runnerVersion:'0.1.0'});
	await connected.promise;
	const request = server.request.bind(server);
	const link = {
		who: { ...owner.identity, sessionId: session }, channel: server,
		again: request, request, start: RunnerLink.prototype.start,
		ready: async () => {}, busy: work => work(),
	};
	try {
		const layer = machineLayer(link, {});
		const box = await layer.sandboxes.connect(id);
		assert.ok(box);
		if (!codex) await box.writeTextFile('/workspace/opencode.json', JSON.stringify({enabled_providers: [], default_agent: 'nonexistent'}));
		const harness = new AcpHarness(codex ? CODEX : OPENCODE, 'fixture');
		// This fixture runs the executor without its service's periodic inventory refresh.
		await owner.refresh();
		const offered = owner.report().harnesses.find(entry => entry.id === harness.id);
		assert.ok(offered, `runner did not report ${harness.id}`);
		let previous;
		for (const mode of (codex ? ['agent-full-access'] : session === 'third' ? ['build', 'plan'] : ['plan'])) {
			let reply = '', selected;
			const ctx = {vars:{runner:link}, client:() => ({user:{get:() => ({
				internalModelKeys:async () => providers.map(provider => ({provider, generation:'fixture'})),
				// Pay with for a plan agent (Codex): `source: "key"` answers that the first Settings key pays.
				internalTurnPayer:async () => source === 'key' && providers.length
					? {decision:{pay:'key'}, ref:{provider:providers[0], generation:'fixture'}, plan:null, rule:{payWith:'key', whenLimited:'wait'}, capped:false}
					: null,
			})}})};
			const credential = await turnCredential(ctx, {uid:owner.identity.uid, harness:harness.id, place:{kind:'machine', machineId:owner.identity.machineId}},
				{...offered, keyRelay:owner.harnessKeyRelays}, model);
			const turn = await harness.runTurn(box, {
				prompt: 'Say relay proof.', mode, model:credential.model,
				...(credential.key && { modelKey: { sessionId: session, key:credential.key } }), windlassSessionId: previous,
				signal: AbortSignal.timeout(expectedFailure ? 150000 : 90000),
				onAcpModes(current, choices) {
					assert.deepEqual(choices.map(c => c.id), codex ? ['agent-full-access'] : ['build','plan']);
					selected = current;
				},
				onAcpUpdate(update) {
					codex?.observe(JSON.stringify(update));
					codex?.onUpdate?.(update);
					if (update.sessionUpdate === 'agent_message_chunk') reply += update.content.text;
				},
			});
			if (codex?.signedOut) { assert.equal(turn.failure?.reason,'harness_signed_out',JSON.stringify(turn.failure)); return; }
			if (expectedFailure) {
				assert.deepEqual(turn.failure, expectedFailure);
				assert.deepEqual(turnRefusal('error', turn, null), {kind:expectedFailure.reason, message:expectedFailure.message});
				return;
			}
			assert.equal(turn.failure, null, JSON.stringify(turn.failure));
			assert.equal(turn.aborted, false);
			assert.equal(turn.acp.stopReason, 'end_turn');
			assert.ok(turn.acp.models.models.length);
			assert.equal(selected, mode);
			assert.equal(reply, codex ? 'Fixture turn complete.' : 'relay proof');
			if (previous) { assert.equal(turn.resumed, true); assert.equal(turn.windlassSessionId, previous); }
			previous = turn.windlassSessionId;
		}
	} finally {
		runner.channel.close();
		server.close();
	}
}
