import { SandboxWindlass, type TurnOptions } from "./turn.js";
import type { EgressMode, HostedSizeOption, SandboxProfile, SandboxProfileId } from "../contract.js";
import {
	SandboxUserError,
	type SandboxLayer,
	type ConnectOptions,
	type CreateSandboxInput,
	type ListedSandbox,
	type Sandboxes,
	type SandboxObservation,
	type SandboxPrice,
} from "./api.js";
import type { TurnSandbox } from "./provider.js";

type SnapshotOperations = Required<
	Pick<Sandboxes, "hasSnapshot" | "saveSnapshot" | "dropSnapshots" | "sweepSnapshots">
>;

/** One configured deployment. Only acquire may wake a retained workspace. Inspect and inventory
 * must reject on ambiguous state or incomplete reads so actors keep their existing claims. */
export interface HostedSandboxProvider {
	readonly supportsAllowList: boolean;
	readonly idleStopMs: number;
	readonly network: { mode: EgressMode; hosts: readonly string[] };
	readonly artifacts?: SnapshotOperations;
	sizes(): HostedSizeOption[];
	price(): SandboxPrice;
	profiles(): SandboxProfile[];
	readonly openProfileId: SandboxProfileId;
	provision(input: CreateSandboxInput): Promise<string>;
	acquire(id: string, options?: ConnectOptions): Promise<TurnSandbox | undefined>;
	inspect(id: string): Promise<SandboxObservation>;
	inventory(uid: string): Promise<ListedSandbox[]>;
	owners(): Promise<string[]>;
	suspend(id: string): Promise<void>;
	destroy(id: string): Promise<void>;
	applyEgress(id: string, hosts: readonly string[]): Promise<boolean>;
}

const ALLOW_LIST_UNAVAILABLE = "This provider cannot enforce a network allow-list.";

export class HostedSandboxes implements Sandboxes {
	readonly sessionsLiveInSandbox = true;
	readonly hasSnapshot?: Sandboxes["hasSnapshot"];
	readonly saveSnapshot?: Sandboxes["saveSnapshot"];
	readonly dropSnapshots?: Sandboxes["dropSnapshots"];
	readonly sweepSnapshots?: Sandboxes["sweepSnapshots"];

	constructor(readonly provider: HostedSandboxProvider) {
		if (!provider.supportsAllowList && provider.network.mode !== "open")
			throw new SandboxUserError("This provider cannot enforce the deployment's network allow-list.");
		const snapshots = provider.artifacts;
		this.hasSnapshot = snapshots?.hasSnapshot.bind(snapshots);
		this.saveSnapshot = snapshots?.saveSnapshot.bind(snapshots);
		this.dropSnapshots = snapshots?.dropSnapshots.bind(snapshots);
		this.sweepSnapshots = snapshots?.sweepSnapshots.bind(snapshots);
	}

	get idleStopMs() {
		return this.provider.idleStopMs;
	}
	price() {
		return this.provider.price();
	}
	sizes() {
		return this.provider.sizes();
	}
	egress() {
		return this.provider.network.mode;
	}
	allowedHosts() {
		return this.provider.network.hosts;
	}
	setNetwork(id: string, hosts: readonly string[]) {
		return this.provider.applyEgress(id, hosts);
	}
	owners() {
		return this.provider.owners();
	}

	profiles(): SandboxProfile[] {
		if (this.provider.supportsAllowList) return this.provider.profiles();
		return this.provider
			.profiles()
			.map(profile =>
				profile.available && profile.id !== this.provider.openProfileId
					? { ...profile, available: false, unavailableReason: ALLOW_LIST_UNAVAILABLE }
					: profile,
			);
	}

	profile(id: SandboxProfileId) {
		const profile = this.profiles().find(item => item.id === id);
		if (!profile) throw new Error(`unknown sandbox profile: ${String(id)}`);
		return profile;
	}

	async create(input: CreateSandboxInput) {
		if (!this.provider.supportsAllowList && input.profile !== this.provider.openProfileId)
			throw new SandboxUserError(ALLOW_LIST_UNAVAILABLE);
		return this.provider.provision(input);
	}

	list(uid: string) {
		return this.provider.inventory(uid);
	}
	observe(id: string) {
		return this.provider.inspect(id);
	}
	async state(id: string) {
		return (await this.observe(id)).state;
	}
	connect(id: string, options?: ConnectOptions) {
		return this.provider.acquire(id, options);
	}
	suspend(id: string) {
		return this.provider.suspend(id);
	}
	destroy(id: string) {
		return this.provider.destroy(id);
	}
}

export function hostedLayer(
	{ logins, tokens, backups }: Pick<SandboxLayer, "logins" | "tokens" | "backups">,
	provider: HostedSandboxProvider & { forgetTokenFiles(uid: string): Promise<void> },
	version: () => Promise<string | null>,
	turn?: TurnOptions,
) {
	return {
		sandboxes: new HostedSandboxes(provider),
		windlass: new SandboxWindlass({ version, problem: async () => null }, turn),
		tokens,
		backups: backups ?? null,
		logins: {
			status: uid => logins.status(uid),
			ensureUserVolume: uid => logins.ensureUserVolume(uid),
			async logout(uid) {
				await logins.logout(uid);
				await provider
					.forgetTokenFiles(uid)
					.catch(() =>
						console.warn(`[wlp] hosted.token_files_left uid=${uid}: could not clear all running workspaces`),
					);
			},
		} satisfies SandboxLayer["logins"],
	};
}
