/** Run from server with npx tsx ../scripts/slack-check.ts. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { localListeners } from "./check-listeners.js";
import { sleep } from "./check-wait.js";
import { GithubStandin } from "./github-standin.js";
import { pollUntil } from "./issue-intake-fixture.js";
import { loginHttp } from "./login-http.js";
import { SlackStandin } from "./slack-standin.js";

const until = pollUntil(60_000);
const origin = "http://127.0.0.1:5173";
async function run() {
	const {
			engine,
			http: [port],
		} = await localListeners(),
		api = `http://127.0.0.1:${port}`;
	const slack = new SlackStandin(api + "/slack/callback");
	const github = new GithubStandin({
		callbackUrl: api + "/github/callback",
		slug: "windlass-fk4w",
		strictBranches: false,
	});
	await slack.start();
	await github.start();
	const storage = mkdtempSync(join(tmpdir(), "wlp-slack-"));
	Object.assign(process.env, github.env(), {
		WLP_SECRET: randomBytes(32).toString("hex"),
		WLP_SANDBOX: "fake",
		WLP_DEMO: "1",
		WLP_ITEMS: "1",
		WLP_WEB_ORIGINS: origin,
		WLP_HTTP_PORT: String(port),
		WLP_PUBLIC_URL: api,
		WLP_FAKE_DELAY_MS: "10",
		WLP_MAX_KEPT_SANDBOXES: "unlimited",
		RIVETKIT_STORAGE_PATH: storage,
		RIVET_RUN_ENGINE_PORT: String(engine),
		RIVET_LOG_LEVEL: "silent",
		WLP_SLACK_URL: slack.url,
		WLP_SLACK_CLIENT_ID: "test",
		WLP_SLACK_CLIENT_SECRET: slack.secret,
		WLP_SLACK_SIGNING_SECRET: slack.signing,
		WLP_SLACK_SIGN_IN: "1",
	});
	for (const key of ["RIVET_ADMIN_TOKEN", "RIVET_ENDPOINT", "RIVET_ENGINE", "PORT", "WLP_FACTORY_ORCHESTRATE"])
		delete process.env[key];
	const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--node"], {
		cwd: fileURLToPath(new URL("../server", import.meta.url)),
		stdio: "ignore",
	});
	const stopped = new Promise(resolve => child.once("exit", resolve));
	try {
		await until(
			"platform HTTP",
			async () => {
				assert.equal(child.exitCode, null, "server exited");
				return (await fetch(api + "/platform/info").catch(() => null))?.ok;
			},
			90_000,
		);
		const { createClient } = await import("../server/src/client.js");
		const client = createClient<import("../server/src/registry.js").Registry>({
			endpoint: `http://127.0.0.1:${engine}`,
		});
		const account = async (login: string) => {
			const auth = await loginHttp(api).demo();
			const user = client.user.getOrCreate([auth.profile.uid], { params: { token: auth.token } });
			github.addUser(login);
			const connect = await user.githubConnect({ origin });
			const back = await fetch(github.authorize(login, connect.url), { redirect: "manual" });
			await user.githubComplete(back.headers.get("location")!.split("#github=")[1]);
			return user;
		};
		Object.assign(github.appPermissions, { checks: "write", statuses: "read", actions: "read" });
		const installation = github.addInstallation("acme", "Organization");
		// Push CI on feature branches and a saved check let a plan be approved.
		const workflow =
			"on:\n  pull_request:\n  push:\n    branches: [main, 'windlass/**']\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps: [{run: 'true'}]\n";
		const repo = github.addRepository({
			installation,
			owner: "acme",
			name: "factory",
			files: { ".github/workflows/build.yml": workflow },
		});
		repo.access.set("installer", "write");
		repo.access.set("member", "read");
		const hidden = github.addRepository({ installation, owner: "acme", name: "private", private: true });
		hidden.access.set("installer", "write");
		const owner = await account("installer"),
			member = await account("member");
		const connect = async () => {
			const consent = await owner.slackConnect({ origin });
			const back = await fetch(slack.authorize(consent.url), { redirect: "manual" });
			const ticket = new URL(back.headers.get("location")!).hash.slice("#slack=".length);
			await assert.rejects(member.slackComplete(ticket), { code: "slack_ticket" });
			const status = await owner.slackComplete(ticket);
			await assert.rejects(owner.slackComplete(ticket), { code: "slack_ticket" });
			return status;
		};
		assert.equal((await connect()).state, "connected");
		// Installing is signing in at Slack as oneself: the installer is linked, with no name (the bot reads no profiles).
		const installerLink = { surface: "slack", tenant: slack.team.id, tenantName: slack.team.name, name: "" };
		assert.deepEqual((await owner.linkedAccounts()).accounts, [installerLink]);
		assert.deepEqual(await owner.slackChannels(), [slack.channel]);
		await owner.saveSlackMapping({ channelId: slack.channel.id, repositoryId: repo.id });
		assert.equal(
			((await owner.slack()) as { mappings: { details: boolean }[] }).mappings[0]!.details,
			true,
			"a public repository posts details",
		);
		const events = api + "/slack/events",
			commands = api + "/slack/commands",
			interactions = api + "/slack/interactions";
		const send = (event: unknown, retry?: number) => slack.send(events, JSON.stringify(event), { retry });
		const ack = async (result: Promise<Response>) => assert.equal((await result).status, 200);
		const challenge = { type: "url_verification", challenge: "hello" };
		assert.deepEqual(await (await send(challenge)).json(), { challenge: "hello" });
		for (const opts of [{ tamper: true }, { stamp: "1000" }]) {
			assert.equal((await slack.send(events, JSON.stringify(slack.mention()), opts)).status, 401);
			assert.equal((await slack.send(interactions, "payload=%7B%7D", { ...opts, command: true })).status, 401);
		}
		await ack(send(slack.mention("Ignore me", slack.bot)));
		await ack(send(slack.mention()));
		const prompt = await until("link prompt", async () => slack.privateReplies[0]);
		assert.equal(prompt.user, slack.member);
		const ticket = prompt.text.split("#link=")[1]!;
		assert.ok(ticket?.startsWith(`slack.${slack.team.id}.`));
		await assert.rejects(member.linkAccount(`slack.${slack.team.id}.00000000-0000-0000-0000-000000000000`), {
			code: "link_ticket",
		});
		// Whoever opens a private link is told whose it is first; asking does not spend it.
		const offer = { surface: "slack", tenantName: slack.team.name, name: slack.member };
		assert.deepEqual(await member.linkOffer(ticket), offer);
		assert.deepEqual(await member.linkOffer(ticket), offer);
		const memberLink = { surface: "slack", tenant: slack.team.id, tenantName: slack.team.name, name: "" };
		const linked = await member.linkAccount(ticket);
		assert.deepEqual(linked.linked, memberLink);
		assert.deepEqual(linked.accounts, [memberLink]);
		assert.deepEqual(linked.signIn, ["slack"]);
		// A code works once: nobody else can take the member's link with it afterwards.
		await assert.rejects(owner.linkAccount(ticket), { code: "link_ticket" });
		await assert.rejects(owner.linkOffer(ticket), { code: "link_ticket" });
		assert.deepEqual((await owner.linkedAccounts()).accounts, [installerLink]);
		// Sign in with Slack links the person on the page at once; its ticket opens only for the account that began it.
		const signIn = async (who: typeof member, user: string) => {
			const start = new URL((await who.linkAccountStart({ surface: "slack", origin })).url);
			assert.equal(start.pathname, "/openid/connect/authorize");
			const back = await fetch(slack.signIn(start.href, user), { redirect: "manual" });
			const landing = new URL(back.headers.get("location")!);
			assert.equal(landing.origin + landing.pathname, origin + "/settings");
			assert.match(landing.hash, /^#link-return=slack-signin\..+$/);
			return landing.hash.slice("#link-return=".length);
		};
		const signedIn = await signIn(member, slack.member);
		const tokensBefore = slack.tokens.size;
		await assert.rejects(owner.linkAccount(signedIn), { code: "link_ticket" });
		const named = { ...memberLink, name: "Mia Member" };
		assert.deepEqual((await member.linkAccount(signedIn)).linked, named);
		assert.equal(slack.tokens.size, tokensBefore, "the sign-in's token is revoked");
		await assert.rejects(member.linkAccount(signedIn), { code: "link_ticket" });
		assert.deepEqual((await member.unlinkAccount({ surface: "slack", tenant: slack.team.id })).accounts, []);
		assert.deepEqual((await member.linkAccount(await signIn(member, slack.member))).accounts, [named]);
		await ack(send(slack.mention()));
		await until("member write check", async () => slack.privateReplies.some(r => r.text.includes("write access")));
		assert.equal((await member.listItems()).length, 0);
		assert.equal(slack.privateReplies.length, 2);
		repo.access.set("member", "write");
		await member.saveRepositoryChecks({ repositoryId: repo.id, checks: [{ name: "build", command: "true" }] });
		const request = slack.mention("Slow filing");
		const start = performance.now();
		await ack(send(request, 1)); // A retry can be the first copy we see.
		assert.ok(performance.now() - start < 3000, "admission waited for filing");
		await Promise.all([ack(send(request)), ack(send(request, 2))]);
		const items = () => member.listItems({ source: "slack" });
		const receipt = (id: string, label: string) =>
			until(label, async () => slack.messages.find(m => m.text === `${label}: ${origin}/items/${id}`));
		const plan = await until("mention item", async () => (await items())[0]);
		assert.equal(plan.mode, "orchestrate");
		assert.equal(plan.repository.id, repo.id);
		assert.equal((await receipt(plan.id, "Work item filed")).thread, request.event.thread_ts);
		const proposal = await receipt(plan.id, "Plan ready for approval");
		assert.equal(proposal.thread, request.event.thread_ts);
		const shown = JSON.stringify(proposal.blocks);
		const firstPlan = (await member.item(plan.id)).plan!;
		assert.ok(
			shown.includes("Goal: ") && shown.includes(firstPlan.spec.goal.slice(0, 40)) && shown.includes("Full plan"),
			"rich plan post",
		);
		assert.deepEqual(
			slack.buttons(proposal).map(b => b.action_id),
			["approve", "revise", "open"],
		);
		const privately = (user: string, text: string) =>
			until(`private "${text}"`, async () => slack.privateReplies.find(r => r.user === user && r.text.includes(text)));

		// A mention in the item's thread files nothing. Its owner gets the choices; anyone else gets the item link.
		await ack(send(slack.mention("Looks fine to me", slack.member, request.event.thread_ts)));
		assert.equal(
			(await privately(slack.member, "Reply with one of: Approve the plan, Revise the plan")).thread,
			request.event.thread_ts,
		);
		const stranger = "U99999999";
		await ack(send(slack.mention("Also do X", stranger, request.event.thread_ts)));
		await privately(stranger, "Replies in this thread don't file new work");
		assert.equal((await items()).length, 1);

		const firstQuestion = (await member.item(plan.id)).question!;
		await ack(slack.press(interactions, proposal, "approve", stranger));
		await privately(stranger, `Only <@${slack.member}> can approve this.`);
		await ack(slack.press(interactions, proposal, "revise", stranger));
		await privately(stranger, `Only <@${slack.member}> can answer this.`);
		assert.equal(slack.views.length, 0);
		assert.equal((await member.item(plan.id)).question?.id, firstQuestion.id);

		// Request changes opens a modal; its text is the web's revision note.
		await ack(slack.press(interactions, proposal, "revise"));
		const modal = await until("revision modal", async () => slack.views[0]);
		await ack(slack.submit(interactions, modal.view, "Split the parser into its own part"));
		const revised = await until("revised plan", async () =>
			slack.messages.find(
				m => m.text === `Plan ready for approval: ${origin}/items/${plan.id}` && m.ts !== proposal.ts,
			),
		);
		const reviseLabel = firstQuestion.choices.find(choice => choice.id === "revise")!.label;
		assert.equal(proposal.text, `Answered by <@${slack.member}> in Slack: ${reviseLabel}`);
		assert.deepEqual(slack.buttons(proposal), []);
		assert.ok((await member.item(plan.id)).plan!.version > firstPlan.version);

		await ack(slack.press(interactions, { ...proposal, blocks: JSON.parse(shown) }, "approve"));
		await privately(slack.member, "This question is no longer open.");
		await ack(slack.press(interactions, revised, "approve"));
		await until("Slack approval", async () => revised.text === `Approved by <@${slack.member}> in Slack`);
		assert.equal((await member.item(plan.id)).plan!.status, "approved");
		assert.equal((await items()).length, 1);
		await member.actOnItem({ id: plan.id, action: { kind: "cancel" } });
		await receipt(plan.id, "Work item cancelled");

		// A planner's case for one implementer is posted as a plan: its questions, and no approval until they are answered.
		const singleAsk = slack.mention(
			"Add a note on running the checks (suggest-single) (plan-question) (recommend-newline)",
		);
		await ack(send(singleAsk));
		const single = await until("one-implementer item", async () => (await items()).find(i => i.id !== plan.id));
		const planIn = (thread: string, id: string, not?: string) =>
			slack.messages.find(
				m => m.thread === thread && m.text === `Plan ready for approval: ${origin}/items/${id}` && m.ts !== not,
			);
		const suggestion = await until("one-implementer plan", async () => planIn(singleAsk.event.thread_ts, single.id));
		const suggested = await member.item(single.id);
		assert.equal(suggested.question?.kind, "single_suggested");
		const suggestionText = JSON.stringify(suggestion.blocks);
		for (const words of [
			"One implementer suggested",
			"Should each file end with a trailing newline? (recommended: Yes)",
			"Answer the open questions in Windlass before approving.",
			"Full plan",
		])
			assert.ok(suggestionText.includes(words), words);
		assert.deepEqual(
			slack.buttons(suggestion).map(b => b.action_id),
			["choice:orchestrate_anyway", "open"],
		);
		// A button for one implementer made before the questions were added is refused too.
		const value = { i: single.id, q: suggested.question!.id, v: suggested.plan!.version, c: "run_single" };
		const early = { type: "button", action_id: "choice:run_single", value: JSON.stringify(value) };
		await ack(
			slack.press(
				interactions,
				{ ...suggestion, blocks: [{ type: "actions", elements: [early] }] },
				"choice:run_single",
			),
		);
		await privately(slack.member, "Answer the plan’s open questions in Windlass before approving.");
		assert.equal((await member.item(single.id)).mode, "orchestrate");
		// Answered on the web, the plan is asked again with both of the web's choices.
		const [ask] = suggested.plan!.questions;
		await member.actOnItem({
			id: single.id,
			action: {
				kind: "edit_plan",
				version: suggested.plan!.version,
				plan: { ...suggested.plan!, questions: [{ ...ask!, answer: "Yes" }] },
			},
		});
		const answeredPlan = await until("one-implementer plan after answers", async () =>
			planIn(singleAsk.event.thread_ts, single.id, suggestion.ts),
		);
		await until(
			"first one-implementer message closed",
			async () => suggestion.text === "This question is no longer open.",
		);
		assert.deepEqual(
			slack.buttons(answeredPlan).map(b => [b.action_id, (b.text as { text: string }).text]),
			[
				["choice:run_single", "Approve as one implementer"],
				["choice:orchestrate_anyway", "Split into parts"],
				["open", "Open in Windlass"],
			],
		);
		assert.ok(!JSON.stringify(answeredPlan.blocks).includes("Answer the open questions"));
		await ack(slack.press(interactions, answeredPlan, "choice:run_single"));
		await until(
			"approved as one implementer",
			async () => answeredPlan.text === `Approved as one implementer by <@${slack.member}> in Slack`,
		);
		assert.equal((await member.item(single.id)).mode, "single");
		await member.actOnItem({ id: single.id, action: { kind: "cancel" } });
		await receipt(single.id, "Work item cancelled");
		// The quick item below finishes without CI.
		await member.saveRepositoryChecks({ repositoryId: repo.id, checks: [] });
		github.commit(repo, "main", { ".github/workflows/build.yml": null }, "Drop CI");
		const form = new URLSearchParams({
			team_id: slack.team.id,
			channel_id: slack.channel.id,
			user_id: slack.member,
			command: "/windlass",
			trigger_id: randomUUID(),
			text: "quick Fix café",
		});
		const listsBeforeCommands = slack.channelListCalls;
		for (const state of [
			{ isMember: false, archived: false },
			{ isMember: true, archived: true },
		]) {
			Object.assign(slack, state);
			const rejected = new URLSearchParams(form);
			rejected.set("trigger_id", randomUUID());
			rejected.set("text", "quick This should not file");
			const prior = slack.channelInfoCalls;
			await ack(slack.send(commands, rejected.toString(), { command: true }));
			await until("command channel lookup", async () => slack.channelInfoCalls > prior);
		}
		slack.archived = false;
		await ack(slack.send(commands, form.toString(), { command: true }));
		await ack(slack.send(commands, form.toString(), { command: true, retry: 1 }));
		const quick = await until("command item", async () =>
			(await items()).find(item => item.id !== plan.id && item.id !== single.id),
		);
		assert.equal(quick.mode, "single");
		assert.equal(quick.title, "Fix café");
		assert.equal(slack.channelInfoCalls, 3);
		assert.equal(slack.channelListCalls, listsBeforeCommands);
		const root = await receipt(quick.id, "Work item filed");
		assert.equal(root.thread, null);
		assert.equal((await receipt(quick.id, "Pull request opened")).thread, root.ts);
		// The cancelled plan item may have opened its feature PR first: merge the quick item's own PR.
		const number = (await member.item(quick.id)).pullRequest!.number;
		const pull = github.pulls.find(pr => pr.repository === repo.id && pr.number === number)!;
		pull.state = "closed";
		pull.merged = true;
		assert.equal((await receipt(quick.id, "Work item finished")).thread, root.ts);
		await member.saveRepositoryDefaults({ repositoryId: repo.id, profile: "docker-hardened" });
		// Link-only mode: no question text in the channel, but the choice buttons stay.
		assert.equal(
			(
				(await owner.setSlackDetails({ channelId: slack.channel.id, details: false })) as {
					mappings: { details: boolean }[];
				}
			).mappings[0]!.details,
			false,
		);
		// Each gate is answered once: one by a press in Slack, one on the web, after which its button is stale.
		const gated = async (text: string) => {
			const mention = slack.mention(text);
			await ack(send(mention));
			const item = await until(`gate for ${text}`, async () =>
				(await items()).find(i => i.title === text.replace(/^quick /, "")),
			);
			const message = await receipt(item.id, "Question ready");
			assert.equal(message.thread, mention.event.thread_ts);
			const question = (await member.item(item.id)).question!;
			assert.equal(question.kind, "turn_refused");
			return { mention, item, message, question };
		};
		const pressed = await gated("quick Check a change");
		const { question: gate, message: asking } = pressed;
		assert.ok(!JSON.stringify(asking.blocks).includes(gate.text.slice(0, 30)), "link-only mode posts no question text");
		assert.deepEqual(
			slack.buttons(asking).map(b => b.action_id),
			[...gate.choices.map(choice => "choice:" + choice.id), "open"],
		);
		assert.equal(slack.buttons(asking).find(b => b.action_id === "choice:" + gate.recommended)!.style, "primary");
		const giveUp = gate.choices.find(choice => choice.id === "give_up")!.label;
		await ack(slack.press(interactions, asking, "choice:give_up"));
		await until("Slack answer", async () => asking.text === `Answered by <@${slack.member}> in Slack: ${giveUp}`);
		assert.deepEqual(slack.buttons(asking), []);
		assert.equal((await receipt(pressed.item.id, "Work item failed")).thread, pressed.mention.event.thread_ts);

		const answered = await gated("quick Check another change");
		const staleButtons = structuredClone(answered.message.blocks);
		await member.actOnItem({
			id: answered.item.id,
			action: { kind: "answer", question: answered.question.id, choice: "give_up" },
		});
		await until("web answer shown in Slack", async () => answered.message.text === `Answered on the web: ${giveUp}`);
		assert.deepEqual(slack.buttons(answered.message), []);
		await ack(slack.press(interactions, { ...answered.message, blocks: staleButtons }, "choice:give_up"));
		await until(
			"stale press refused",
			async () => slack.privateReplies.filter(r => r.text.includes("This question is no longer open.")).length === 2,
		);
		assert.equal((await receipt(answered.item.id, "Work item failed")).thread, answered.mention.event.thread_ts);
		const posted = slack.payloads.join("\n");
		for (const hidden of [gate, answered.question].flatMap(q => [
			q.asked?.text,
			...(q.asked?.options ?? []),
			q.check?.excerpt,
			q.secret?.why,
		]))
			if (hidden) assert.ok(!posted.includes(hidden.slice(0, 40)), "builder text posted to Slack");
		assert.equal((await items()).length, 5);
		assert.equal((await owner.listItems()).length, 0);
		assert.equal(slack.messages.filter(m => m.text.startsWith("Work item filed")).length, 5);
		// Revoking the link makes the member unlinked again: a request files nothing and asks them to link.
		assert.deepEqual((await member.unlinkAccount({ surface: "slack", tenant: slack.team.id })).accounts, []);
		const asked = slack.privateReplies.length;
		await ack(send(slack.mention("After unlinking")));
		const again = await until("link prompt after unlinking", async () => slack.privateReplies[asked]);
		assert.ok(again.user === slack.member && again.text.includes("#link=slack."));
		assert.equal((await items()).length, 5);
		await member.linkAccount(again.text.split("#link=")[1]!);
		const remapped = (await owner.saveSlackMapping({ channelId: slack.channel.id, repositoryId: hidden.id })) as {
			mappings: { details: boolean }[];
		};
		assert.equal(remapped.mappings[0]!.details, false, "a private repository posts links only");
		assert.equal((await owner.disconnectSlack()).state, "disconnected");
		assert.equal(slack.tokens.size, 0);
		assert.deepEqual(await member.slack(), { state: "disconnected" });
		assert.deepEqual(
			(await member.linkedAccounts()).accounts,
			[],
			"disconnecting the workspace removes its member links",
		);
		await ack(send(slack.mention()));
		assert.deepEqual(await connect(), {
			state: "connected",
			teamId: slack.team.id,
			workspaceName: slack.team.name,
			mappings: [],
		});
		assert.deepEqual(
			(await owner.linkedAccounts()).accounts,
			[installerLink],
			"reinstalling links the installer again",
		);
		console.log(
			"PASS signed requests, named channel discovery, installer link, private links named before use, Sign in with Slack, member links and revocation, member access, asynchronous filing, retries, thread replies, plan approval and answers from Slack, a one-implementer plan held for its questions, and disconnect",
		);
	} finally {
		child.kill("SIGTERM");
		const guard = setTimeout(() => child.kill("SIGKILL"), 15_000);
		await stopped;
		clearTimeout(guard);
		try {
			const { pid } = JSON.parse(readFileSync(join(storage, ".rivetkit/var/engine/runtime.json"), "utf8"));
			process.kill(pid, "SIGTERM");
		} catch {
			/* engine already stopped */
		}
		await slack.stop();
		await github.stop();
		rmSync(storage, { recursive: true, force: true });
	}
}

if (process.argv.includes("--node")) {
	const { user } = await import("../server/src/actors/user.js");
	const file = user.config.actions!.internalSlackIntake;
	user.config.actions!.internalSlackIntake = async (c, input) => {
		if (input.delivery.text === "Slow filing") await sleep(3500);
		return file(c, input);
	};
	const { CI_POLLING } = await import("../server/src/github/ci.js");
	Object.assign(CI_POLLING, {
		everyMs: 250,
		crowdedEveryMs: 250,
		prEveryMs: 250,
		webhookEveryMs: 250,
		webhookCrowdedEveryMs: 250,
		webhookPrEveryMs: 250,
		noneAfterMs: 0,
	});
	await import("../server/src/index.js");
} else
	await run().then(
		() => process.exit(0),
		error => {
			// Assertion diffs and actor errors can contain one-time tickets.
			const line = error?.stack?.match(/slack-check\.ts:(\d+:\d+)/)?.[1];
			console.error("FAIL Slack check at " + line);
			process.exit(1);
		},
	);
