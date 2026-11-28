import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist/wght-italic.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/ui.css";
import "./styles/shell.css";
import "./styles/signin.css";
import "./styles/home.css";
import "./styles/new-agent.css";
import "./styles/session.css";
import "./styles/github.css";
import "./styles/usage.css";
import "./styles/billing.css";
import "./styles/repository.css";
import "./styles/machines.css";
import "./styles/items.css";
import "./styles/board.css";
import "./styles/workspace.css";
import "./styles/feed.css";
import "./styles/landing.css";
import "./styles/docs.css";
import "./styles/settings.css";
import "./styles/integrations.css";
import { QUESTION_TIMEOUT_MS } from "@contract";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { keepScroll } from "./lib/router";
import type { PlatformClient } from "./api/client";
import { AppProvider } from "./state/app";
import { relayGithubReturn } from "./state/github";

/** The mock backend is chosen at build time (`VITE_WLP_MOCK=1`) or in the address (`?mock=1`). */
function wantsMock(): boolean {
	if (import.meta.env.VITE_WLP_MOCK === "1") return true;
	return new URLSearchParams(location.search).get("mock") === "1";
}

/**
 * How long the mock's questions wait: `?question-timeout=real` for the platform's own ten minutes,
 * `?question-timeout=<seconds>` for any other; the mock's shorter default otherwise.
 */
function mockQuestionTimeout(): number | undefined {
	const asked = new URLSearchParams(location.search).get("question-timeout");
	if (asked === "real") return QUESTION_TIMEOUT_MS;
	const seconds = Number(asked);
	return asked !== null && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

async function createPlatformClient(): Promise<PlatformClient> {
	// Each implementation is its own chunk: the mock never loads RivetKit, the real client never loads the fixtures.
	if (wantsMock()) {
		const { createMockClient, MOCK_BILLING_STATES, MOCK_MACHINE_SESSIONS, MOCK_MACHINE_STATES } = await import(
			"./api/mock"
		);
		const { MOCK_ITEMS_STATES } = await import("./api/mock-items");
		// `?github=off` plays a deployment with no GitHub App, `?sandbox=e2b` one on E2B,
		// `?usage=low|used|full` a day with little sandbox time left, one that is used up, and an account at its cap of sandboxes,
		// `?account=empty` a user who has saved nothing for their account,
		// `?models=unavailable` one whose ChatGPT plan's models could not be read, so that the stand-in list is offered,
		// `?machine=none|claude-signed-out|claude-unchecked|offline|pairing|outdated|docker|clock|key|full|unpublished|stale|failed|loading|off` the user's machines in that state (`MockMachineState`),
		// `?machineSession=answering|not_answering|offline|removed|paused` how the agent on the machine "nas" finds it (`MockMachineSession`; `paused`: its turn paused while the machine is away),
		// `?resume=1` a turn paused by a server restart and one that resumed after it,
		// `?items=few|features|none|full|many|loading|failed|off` the user's work items and API tokens in that state (`MockItemsState`), `off` a deployment without them,
		// `&long=1` with `items=features`, the features' texts as long as planners and agents write them,
		// and `?reviewer=off` a deployment without the second review.
		const params = new URLSearchParams(location.search);
		const usage = params.get("usage");
		const machine = params.get("machine");
		const machineSession = params.get("machineSession");
		const items = params.get("items");
		const client = createMockClient({
			questionTimeoutMs: mockQuestionTimeout(),
			github: params.get("github") !== "off",
			sandbox: params.get("sandbox") === "e2b" ? "e2b" : "docker",
			usage: usage === "low" || usage === "used" || usage === "full" ? usage : undefined,
			// `?billing=exempt|free|free-low|free-used|pro|pro-capped|pro-past-due` a deployment with plans, the account in that state (`MockBillingState`).
			billing: MOCK_BILLING_STATES.find(state => state === params.get("billing")),
			// The user has MCP servers of their own and secrets for them saved, unless the address says `account=empty`.
			account: params.get("account") === "empty" ? "empty" : "seeded",
			models: params.get("models") === "unavailable" ? "unavailable" : "account",
			machine: MOCK_MACHINE_STATES.find(state => state === machine),
			// `?keys=1` a checked Settings key for each model provider.
			keys: params.get("keys") === "1",
			machineSession: MOCK_MACHINE_SESSIONS.find(state => state === machineSession),
			items: MOCK_ITEMS_STATES.find(state => state === items),
			long: params.get("long") === "1",
			blocked: params.get("blocked") === "1",
			resume: params.get("resume") === "1",
			reviewer: params.get("reviewer") !== "off",
		});
		// For looking at states by hand, in the console: `__wlpMock.simulateDrop(4000)` (reconnecting),
		// `__wlpMock.mockNextAnswer("elsewhere" | "error")` (an answer that does not go through),
		// `__wlpMock.mockNextGithub("list" | "connect" | "denied" | "protected" | "gone")` (GitHub refuses),
		// `__wlpMock.mockNextServers("list" | "approve" | "forget" | "slow")` (the panel's MCP servers),
		// `__wlpMock.mockUsage("plenty" | "low" | "used" | "full")` (the day's sandbox time and the cap on sandboxes).
		// `__wlpMock.mockIntegrations("connected" | "gitlab-reconnect")` (every Settings integration connected and mapped).
		(window as unknown as { __wlpMock: unknown }).__wlpMock = client;
		return client;
	}
	const { createRivetClient } = await import("./api/rivet");
	return createRivetClient();
}

const container = document.getElementById("root") as HTMLElement;
/** The docs are public and need no server: they load on their own, without the platform's client. */
const docs = location.pathname === "/docs" || location.pathname.startsWith("/docs/");
/** Empty a prerendered page's root: its static markup is not the app's, which starts from nothing. */
const clearStatic = () => {
	if (!container.hasAttribute("data-public")) return;
	container.replaceChildren();
	container.removeAttribute("data-public");
};
// On the landing for someone signed in (public/site.js loaded the app there), the static page is hidden
// until now. A docs page stays readable, and its search usable, until the docs' own chunk has arrived.
if (!docs) clearStatic();
const root = createRoot(container);

if (!docs && relayGithubReturn()) {
	// The popup that connected GitHub, back from it: the page that opened it finishes, and this closes.
	root.render(
		<main className="state state-page" role="status">
			<h1 className="display display-small">Back from GitHub</h1>
			<p>The page you connected from has it now. You can close this window.</p>
		</main>,
	);
} else if (docs) {
	void import("./docs/Docs").then(({ DocsApp, takeStaticSearch }) => {
		// What was typed into the static page's search carries over, and the swap happens in one task, so no
		// frame shows an empty page and no keystroke falls between the two.
		const initialSearch = takeStaticSearch(container) ?? undefined;
		clearStatic();
		flushSync(() =>
			root.render(
				<StrictMode>
					<DocsApp initialSearch={initialSearch} />
				</StrictMode>,
			),
		);
	});
} else
	createPlatformClient().then(
		client => {
			// Back and Forward bring back each page's scroll (lib/router.ts).
			keepScroll();
			root.render(
				<StrictMode>
					<AppProvider client={client}>
						<App />
					</AppProvider>
				</StrictMode>,
			);
		},
		(error: unknown) => {
			root.render(
				<main className="state state-page state-error" role="alert">
					<h1 className="display display-small">Windlass could not start</h1>
					<p>{error instanceof Error ? error.message : "The application failed to load."}</p>
					<button type="button" className="button button-outline" onClick={() => location.reload()}>
						Reload
					</button>
				</main>,
			);
		},
	);
