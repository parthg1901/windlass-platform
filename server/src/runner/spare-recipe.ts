import type { HarnessId, SandboxProfileId } from "../contract.js";
import { machineHarness } from "../sandbox/harnesses.js";
import { count, is, object, optional, text, type Of } from "./check.js";

export function spareProfile(profile: SandboxProfileId, harness?: HarnessId) {
	if (profile !== "docker-hardened" && profile !== "docker-windlass-sandbox") return false;
	// Windlass runs in either; another agent only in the profiles of its record.
	return machineHarness(harness)?.profiles.includes(profile) ?? true;
}

// A spare recipe carries only the repository and its setup. Connected repositories also
// have an independently observed GitHub head. URLs with embedded credentials are ineligible.
const spareUrl = is<string>(v => {
	if (typeof v !== "string" || v.length > 2048) return false;
	try {
		const u = new URL(v);
		return (
			["http:", "https:"].includes(u.protocol) &&
			!u.username &&
			!u.password &&
			!u.search &&
			!u.hash &&
			/^\/[a-zA-Z0-9._~/-]+$/.test(u.pathname) &&
			u.href === v
		);
	} catch {
		return false;
	}
});
export const spareRecipe = object({
	url: spareUrl,
	connected: optional(
		object({
			repo: is<string>(v => typeof v === "string" && /^[1-9]\d{0,19}$/.test(v)),
			branch: text(250),
			commit: is<string>(v => typeof v === "string" && /^[0-9a-f]{40}$/.test(v)),
			command: is<string>(v => typeof v === "string" && v.length <= 65536),
			timeoutMs: is<number>(v => count(v) && v <= 24 * 60 * 60_000),
			generation: is<string>(v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)),
		}),
	),
});
export type SpareRecipe = Of<typeof spareRecipe>;

// The command is already part of the verified recipe. Only its actual execution times cross back.
export const spareSetup = object({ startedAt: count, durationMs: count });
export type SpareSetup = Of<typeof spareSetup>;
