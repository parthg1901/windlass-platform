// The setup wizard end to end in its plain-line mode, with a fake Docker and a fake platform:
// node --test scripts/runner-setup-wizard-check.mjs
// It pairs, signs in only OpenCode (Claude Code and Codex pay with the account's plans and keys), starts the runner service itself with the
// flags built from the answers, offers the saved answers on a re-run, re-runs one section, and with no
// terminal takes the defaults. WIZARD_RECORD=<dir> also keeps a transcript of each run there.
import assert from "node:assert/strict";
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fakeMachine, runner } from "./runner-wizard-fake.mjs";

const secret = "wizard-fixture-secret";

async function record(name, text) {
	if (process.env.WIZARD_RECORD) await writeFile(join(process.env.WIZARD_RECORD, name + ".txt"), text);
}

test("the setup wizard in lines pairs, signs in only OpenCode, starts the runner and remembers its answers", async () => {
	const m = await fakeMachine();
	try {
		const first = await m.terminal(
			["setup", "--platform", m.origin, "--no-tui"],
			[
				["Set up this machine?", ""],
				["Machine name [docker-desktop]", "Build box"],
				["Numbers separated by commas", "1,2,3"],
				["OpenCode: sign in now?", ""],
				["OpenCode provider", "openai"],
				["Enter the openai API key", secret],
				["Which Docker profiles", ""],
				["What may the agents", "2"],
				["Public hosts commands may reach [@npm,@pypi,@github]", "@npm,example.com"],
				["Limits:", ""],
				["Start the runner with these settings?", ""],
			],
		);
		await record("lines-first-run", first.output.replaceAll(secret, "[key]"));
		assert.equal(first.code, 0, first.output.replaceAll(secret, "[key]"));
		assert.equal(first.answered, 11);
		assert.ok(!first.output.includes(secret));
		assert.match(first.output, /docker-desktop" is the name of Docker's VM/);
		assert.match(first.output, /2\. Enter {5}WXYZ-1210/);
		assert.match(first.output, /3\. Check {5}the page shows machine key [A-Z0-9]{5}-[A-Z0-9]{5}/);
		assert.match(first.output, /OpenCode: signed in\./);
		assert.doesNotMatch(first.output, /Claude Code: sign in|Codex: sign in|login claude|login codex/);
		assert.match(first.output, /Claude Code, OpenCode \(signed in\), Codex/);
		assert.match(first.output, /OK: Online/);
		const runs = await m.serviceRuns();
		assert.equal(runs.length, 1);
		assert.ok(
			runs[0].startsWith("run -d --name windlass-runner --restart unless-stopped --log-driver json-file"),
			runs[0],
		);
		assert.ok(
			runs[0].endsWith(
				`${runner} run --platform ${m.origin} --harness claude --harness opencode --harness codex --allow-profile docker-hardened --allow-profile docker-windlass-sandbox --egress restricted --egress-domains @npm,example.com`,
			),
			runs[0],
		);
		assert.ok(runs[0].includes("-v windlass-runner:" + m.state), runs[0]);
		assert.deepEqual(JSON.parse(await readFile(join(m.state, "setup.json"), "utf8")), {
			agents: ["claude", "opencode", "codex"],
			windlassSandbox: true,
			network: { mode: "restricted", domains: ["@npm", "example.com"] },
			limits: { snapshotDisk: "10GB", keepFree: "40GB" },
		});
		assert.equal(JSON.parse(await readFile(join(m.state, "name.json"), "utf8")), "Build box");
		assert.deepEqual(m.asked, ["/runner/pair", "/runner/pair/poll"]);

		// Again: the saved answers are the defaults. q cancels and leaves the running runner as it is.
		const again = await m.terminal(
			["setup", "--no-tui"],
			[
				["Go through this machine's settings?", ""],
				["Pairing", ""],
				["Machine name [Build box]", ""],
				["Numbers separated by commas, 0 for none [1,2,3]", ""],
				["OpenCode: signed in on this machine", ""],
				["Which Docker profiles", ""],
				["Only some public hosts - a list such as @npm,@pypi,@github,example.com  [default]", "q"],
			],
		);
		await record("lines-rerun-cancel", again.output);
		assert.equal(again.code, 1, again.output);
		assert.equal(again.answered, 7);
		assert.match(again.output, /Keep this pairing \(m_b{16}\) {2}\[default\]/);
		assert.match(again.output, /Setup cancelled\. Nothing more was changed\. The pairing is kept/);
		assert.equal((await m.serviceRuns()).length, 1);
		assert.deepEqual(m.asked, ["/runner/pair", "/runner/pair/poll"]);

		// One section, then the start step replaces the running container and keeps the rest.
		const network = await m.terminal(
			["setup", "network", "--no-tui"],
			[
				["What may the agents", "3"],
				["Start the runner with these settings?", ""],
				["Replace it with these settings?", ""],
			],
		);
		await record("lines-section-network", network.output);
		assert.equal(network.code, 0, network.output);
		const replaced = (await m.serviceRuns()).at(-1);
		assert.ok(
			replaced.endsWith(
				`run --platform ${m.origin} --harness claude --harness opencode --harness codex --allow-profile docker-hardened --allow-profile docker-windlass-sandbox --egress open`,
			),
			replaced,
		);
		assert.equal(JSON.parse(await readFile(join(m.state, "setup.json"), "utf8")).network.mode, "open");

		// No terminal: the defaults, no sign-in, and only what is missing.
		const quick = await m.piped(["setup", "--quick"]);
		await record("lines-quick-no-terminal", quick.output);
		assert.equal(quick.code, 0, quick.output);
		assert.doesNotMatch(quick.output, /sign in|signing in/i);
		assert.doesNotMatch(quick.output, /Machine name|Which Docker profiles|What may the agents|Limits:/);
		assert.equal((await m.serviceRuns()).length, 3);
		assert.deepEqual(m.asked, ["/runner/pair", "/runner/pair/poll"]);

		// Pairing again and refused: setup says so and ends, without a terminal at once.
		m.refuse();
		await rm(join(m.state, "setup.json"));
		const refused = await m.terminal(
			["setup", "--no-tui"],
			[
				["Go through this machine's settings?", ""],
				["Pairing", "2"],
				["Try again?", "2"],
			],
		);
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /Pairing was refused \(HTTP 403\), so re-run the setup command to get a new code\./);
		assert.match(refused.output, /Setup cancelled/);
		const piped = await m.piped(["setup", "--platform", "http://localhost:9"]);
		assert.equal(piped.code, 1);
		assert.match(
			piped.output,
			/This machine is paired with http:\/\/127\.0\.0\.1:\d+\. Pair it with http:\/\/localhost:9 instead\./,
		);

		const bad = await m.piped(["setup", "everything"]);
		assert.notEqual(bad.code, 0);
		assert.match(bad.output, /Use setup, setup --quick, or setup with one of: name, agents/);
	} finally {
		await m.close();
	}
});
