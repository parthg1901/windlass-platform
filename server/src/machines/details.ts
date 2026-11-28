import { machineLabel, type MachineDetails, type MachineSummary } from "../contract.js";

export function machineDetails(input: MachineDetails): MachineDetails {
	if (typeof input?.whenToUse !== "string" || input.whenToUse.length > 500)
		throw new Error("Use at most 500 characters for when to use this machine.");
	if (
		!Array.isArray(input.tags) ||
		input.tags.length > 12 ||
		!input.tags.every(
			t => typeof t === "string" && /^[a-z0-9][a-z0-9_-]{0,23}$/i.test(t) && !/^(os|arch|screenshots)$/i.test(t),
		)
	)
		throw new Error(
			"Use up to twelve owner tags of at most 24 characters each. OS, arch, screenshots and harness tags come from the runner.",
		);
	const orchestrator = input.orchestrator === undefined ? "yes" : input.orchestrator;
	if (!["yes", "named", "never"].includes(orchestrator))
		throw new Error("Choose yes, named or never for orchestrator placement.");
	return { whenToUse: input.whenToUse.trim(), tags: [...new Set(input.tags)], orchestrator };
}

/** `screenshots` false: the deployment turned screenshots off, so no machine offers them to a plan. */
export function plannerMachines(machines: MachineSummary[], screenshots = true) {
	return machines.map(m => ({
		machineId: m.machineId,
		orchestrator: m.orchestrator ?? "yes",
		repositorySecrets: m.sendSecrets,
		warnings: m.warnings,
		availableProfiles: m.profiles?.filter(p => p.available).map(p => p.id) ?? [],
		personalRunning: m.personalRunning ?? 0,
		slots: m.slots,
		name: machineLabel(m),
		os: m.os,
		arch: m.arch,
		online: m.status === "online",
		tags: m.tags ?? [],
		whenToUse: m.whenToUse ?? "",
		turns: m.turns,
		host: m.host,
		freeDiskBytes: m.freeDiskBytes,
		allowedProfiles: m.allowedProfiles,
		commandSandbox: m.commandSandbox,
		egress: m.egress,
		screenshots: screenshots && m.screenshots,
		harnesses: m.harnesses?.map(
			({ id, signIn, paysWith, method, keyRelay, machineProviders, platformKeys, optionsDigest }) => ({
				id,
				signIn,
				paysWith,
				method,
				keyRelay,
				machineProviders,
				platformKeys,
				optionsDigest,
			}),
		),
		sandboxes: {
			running: m.sandboxes.filter(s => s.state === "running").length,
			kept: m.sandboxes.length,
			maxRunning: m.maxRunning,
			maxSandboxes: m.maxSandboxes,
		},
	}));
}
