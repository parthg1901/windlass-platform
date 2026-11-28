/**
 * The whole `connect claude` flow as a user runs it: the CLI against a stand-in platform, with a stand-in
 * `claude` on PATH that prints a setup token the way Claude Code's screen does (colours, a box, wrapped).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cli as run, platform, REQUEST } from "./stand-ins.ts";

const TOKEN = "sk-ant-oat01-" + "Zq8_k-3".repeat(13) + "WWAA";

const bin = mkdtempSync(join(tmpdir(), "windlassai-cli-"));
after(() => rmSync(bin, { recursive: true, force: true }));
const ran = join(bin, "claude-ran");
// Box lines 40 wide, as Claude Code draws them; the token wraps over three of them.
const pieces = TOKEN.match(/.{1,40}/g)!.map(
	piece => `printf '\\033[2m│\\033[0m %-40s \\033[2m│\\033[0m\\r\\n' '${piece}'`,
);
writeFileSync(
	join(bin, "claude"),
	`#!/bin/sh
[ "$1" = "setup-token" ] || exit 64
touch '${ran}'
[ -n "$FAKE_CLAUDE_SILENT" ] && { printf 'Authentication cancelled.\\r\\n'; exit 1; }
printf '\\033[?25l\\033[32m✓ Long-lived authentication token created\\033[39m\\r\\n'
${pieces.join("\n")}
printf '\\r\\nStore this token securely.\\033[?25h\\r\\n'
`,
);
chmodSync(join(bin, "claude"), 0o755);

function cli(args: string[], env: Record<string, string>, stdin = "") {
	rmSync(ran, { force: true });
	return run(bin, args, env, stdin);
}

test("approve in the browser, then claude setup-token's token connects the plan", async () => {
	const site = await platform({ decision: "approved", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /code KQ2M-8XF4/);
	assert.match(run.stdout, /http:\/\/127\.0\.0\.1:1\/connect\?code=KQ2M-8XF4/);
	assert.match(run.stdout, /Connected: a@b\.com · Max/);
	assert.ok(existsSync(ran), "claude setup-token ran");
	assert.deepEqual(
		site.seen.map(one => one.path),
		["/platform/connect/start", "/platform/connect/poll", "/platform/connect/poll", "/platform/connect"],
	);
	assert.deepEqual(site.seen.at(-1)!.body, { request: REQUEST, token: TOKEN });
	assert.ok(!run.stderr.includes("sk-ant"));
	// Nothing on screen shows the token: not the CLI's lines, and not Claude Code's screen copied through.
	for (const piece of TOKEN.match(/.{1,40}/g)!) assert.ok(!run.stdout.includes(piece), "a token piece on screen");
	assert.ok(!run.stdout.includes("WWAA") && run.stdout.includes("(hidden)"));
});

test("a denied request runs nothing and connects nothing", async () => {
	const site = await platform({ decision: "denied", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], { WINDLASS_PLATFORM: site.url });
	assert.equal(run.code, 1);
	assert.match(run.stderr, /denied in the browser/);
	assert.ok(!existsSync(ran));
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
});

test("--token-stdin skips claude setup-token; refusals read as the platform means them", async () => {
	const site = await platform({ decision: "approved", connect: 400, body: { code: "plan_refused", message: TOKEN } });
	const run = await cli(
		["connect", "claude", "--no-browser", "--token-stdin"],
		{ WINDLASS_PLATFORM: site.url },
		`${TOKEN}\n`,
	);
	assert.equal(run.code, 1);
	assert.match(run.stderr, /Anthropic did not accept that token/);
	assert.ok(!run.stderr.includes(TOKEN) && !run.stdout.includes(TOKEN));
	assert.ok(!existsSync(ran));
	assert.equal(site.seen.at(-1)!.body.token, TOKEN);

	const typo = await cli(["connect", "claude", "--token-stdin"], { WINDLASS_PLATFORM: site.url }, "sk-ant-oat01-x");
	assert.equal(typo.code, 1);
	assert.match(typo.stderr, /does not hold a setup token/);
});

test("a plan Anthropic could not be checked for is handed over again, with the same request", async () => {
	const unavailable = { code: "plan_check_unavailable", message: "Anthropic could not be reached." };
	const site = await platform({ decision: "approved", connect: [503, 200], body: unavailable });
	const run = await cli(["connect", "claude", "--token-stdin"], { WINDLASS_PLATFORM: site.url }, `${TOKEN}\n`);
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /Connected:/);
	const handovers = site.seen.filter(one => one.path === "/platform/connect");
	assert.deepEqual(
		handovers.map(one => one.body),
		[
			{ request: REQUEST, token: TOKEN },
			{ request: REQUEST, token: TOKEN },
		],
	);

	const down = await platform({ decision: "approved", connect: 503, body: unavailable });
	const failed = await cli(["connect", "claude", "--token-stdin"], { WINDLASS_PLATFORM: down.url }, `${TOKEN}\n`);
	assert.equal(failed.code, 1);
	assert.match(failed.stderr, /Anthropic could not be reached to check the plan/);
	assert.equal(down.seen.filter(one => one.path === "/platform/connect").length, 4, "tried, then three more times");
});

test("no token in the output and no terminal to paste into: it says how to finish", async () => {
	const site = await platform({ decision: "approved", connect: 200 });
	const run = await cli(["connect", "claude", "--no-browser"], {
		WINDLASS_PLATFORM: site.url,
		FAKE_CLAUDE_SILENT: "1",
	});
	assert.equal(run.code, 1);
	assert.match(run.stderr, /No setup token was found.*--token-stdin/);
	assert.ok(!site.seen.some(one => one.path === "/platform/connect"));
});

test("usage, a machine with a plan, and platform addresses", async () => {
	const codex = await cli(["connect", "codex", "--token-stdin"], { WINDLASS_PLATFORM: "https://windlass.example.com" });
	assert.equal(codex.code, 2);
	assert.match(codex.stderr, /--token-stdin is for connect claude/);
	// `--machine` is a flow of its own (connect-machine.test.ts): with a plan named too, it is a usage error.
	const both = await cli(["connect", "codex", "--machine"], { WINDLASS_PLATFORM: "https://windlass.example.com" });
	assert.equal(both.code, 2);
	assert.match(both.stderr, /^Usage:/);
	const plain = await cli(["connect", "claude"], { WINDLASS_PLATFORM: "http://example.com" });
	assert.match(plain.stderr, /must start with https:\/\//);
});
