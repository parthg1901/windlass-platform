import type { SandboxProfile } from "@contract";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { e2bOpenProfile, e2bProfile, profilesFor } from "../../../server/src/sandbox/profiles";
import { commandNetworkFact, isolationOutcomes, ProfileFacts } from "./Layers";
import { missingVariable } from "./RepositorySetup";
import { SetupField } from "./SetupCommand";

it("uses the machine's command network sentence in the session panel", () => {
	const profile: SandboxProfile = {
		id: "docker-hardened",
		name: "Machine",
		summary: "",
		layers: [],
		approval: "full",
		available: true,
		commandsCanReadAccessToken: true,
		commandNetwork: true,
		commandNetworkText: "commands can reach public sites and hosts allowed by the owner through the web proxy",
	};
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile }))).toContain(profile.commandNetworkText);
});

it("describes the remaining Claude model route on a machine with general networking disabled", () => {
	const profile: SandboxProfile = {
		id: "docker-hardened",
		name: "Machine",
		summary: "",
		layers: [],
		approval: "full",
		available: true,
		commandsCanReadAccessToken: true,
		commandNetwork: false,
		claudeRelay: true,
	};
	const html = renderToStaticMarkup(
		createElement(ProfileFacts, { profile, claude: { mode: { id: "default", name: "Default", description: null } } }),
	);
	expect(html).toContain("only this session’s Claude model relay");
	expect(html).toContain("relay holds the setup token");
});

it("says what a hosted sandbox's commands reach under the deployment's network mode", () => {
	const restricted = e2bOpenProfile({ offered: true, network: "restricted" });
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: restricted }))).toContain(
		"commands can reach only the model API, GitHub and the hosts this deployment allows",
	);
	expect(commandNetworkFact(e2bOpenProfile({ offered: true, network: "none" }), null)).toBe(
		"commands can reach only the model API",
	);
	expect(commandNetworkFact(e2bProfile({ windlassSandbox: true, network: "restricted" }), null)).toBe(
		"commands have no network",
	);
	expect(profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: "open" })).toEqual(
		profilesFor("e2b", { windlassSandbox: false, openProfile: true }),
	);
	expect(commandNetworkFact(e2bProfile({ windlassSandbox: false }), null)).toBe("commands can reach the network");
});

it("says what a hosted workspace's setup command reaches", () => {
	const setup = {
		draft: { repositoryId: null, text: "npm ci", saved: "npm ci", touched: false, limitMs: null, error: null },
		setText: () => {},
		toSave: undefined,
	};
	const html = (egress?: "restricted" | "none") =>
		renderToStaticMarkup(
			createElement(SetupField, { setup, repository: "acme/quay", disabled: false, egress, hosted: true }),
		);
	expect(html("restricted")).toContain(
		"The workspace can reach only the model API, GitHub and the hosts this deployment allows.",
	);
	expect(html("none")).toContain("The workspace can reach only the model API.");
	expect(html()).toContain("Network access follows the workspace’s network policy.");
});

it("says a relayed sandbox's commands read only a placeholder, from both flags", () => {
	const [sandboxed, hardened] = profilesFor("docker", undefined, true).filter(p => p.id.startsWith("docker-"));
	expect(hardened!.modelRelay).toBe(true);
	expect(hardened!.commandsCanReadAccessToken).toBe(true);
	expect(hardened!.details).toContain(
		"Commands can read only a placeholder for this turn. With it they can make model requests on your ChatGPT plan through the relay while the turn runs (8 at once, 32 waiting). The access token never enters the container.",
	);
	expect(hardened!.details).not.toMatch(/can read the session's access token/);
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: hardened! }))).toContain(
		"Commands can read only a placeholder for this turn",
	);
	expect(sandboxed!.details).toContain("cannot read the session's token file");
	expect(renderToStaticMarkup(createElement(ProfileFacts, { profile: sandboxed! }))).toContain(
		"processes left from setup can read only a placeholder",
	);
	const plain = profilesFor("docker").find(p => p.id === "docker-hardened")!;
	expect(plain.modelRelay).toBeUndefined();
	expect(plain.details).toContain("can read the session's access token and its replacements");
	const e2b = profilesFor("e2b", { windlassSandbox: false, openProfile: true, network: "restricted" }, true);
	expect(e2b.filter(p => p.modelRelay).map(p => p.id)).toEqual(["e2b", "e2b-open"]);
	expect(e2b.find(p => p.id === "e2b-open")!.details).toContain("The access token never enters the microVM.");
});

it("says a sandbox in three plain outcome lines, open facts as plain facts", () => {
	const [sandboxed, hardened] = profilesFor("docker").filter(p => p.id.startsWith("docker-"));
	expect(isolationOutcomes(sandboxed!, null)).toEqual([
		{ text: "Commands run in a locked-down sandbox", kept: true },
		{ text: "No internet from commands", kept: true },
		{ text: "Your sign-in stays outside the sandbox", kept: true },
	]);
	expect(isolationOutcomes(hardened!, null, "open").map(line => line.text)).toEqual([
		"Commands run freely, without asking",
		"Commands can reach the internet and your network",
		"Commands can use this turn's sign-in",
	]);
	expect(isolationOutcomes(hardened!, null).every(line => !/[A-Z][a-z]+ \+|Docker|token|relay/.test(line.text))).toBe(
		true,
	);
});

it("says what keeps a hosted agent's credential on the platform: the plan or the key that paid", () => {
	const [sandboxed] = profilesFor("docker").filter(p => p.id.startsWith("docker-"));
	const signIn = (paidBy?: "plan" | "key") =>
		isolationOutcomes(sandboxed!, {
			hosted: true,
			mode: { id: "auto", name: "Auto", description: null },
			...(paidBy && { paidBy }),
		})[2]!.text;
	expect(signIn("plan")).toBe("Your plan's token stays on the platform");
	expect(signIn("key")).toBe("Your API key stays on the platform");
	expect(signIn()).toBe("Your plan or key stays on the platform");
});

it("reads the variable a server could not start without", () => {
	expect(missingVariable("the environment variable WIKI_TOKEN named in its headers is not set")).toBe("WIKI_TOKEN");
	expect(missingVariable("it exited with code 1")).toBeNull();
	expect(missingVariable(null)).toBeNull();
});
