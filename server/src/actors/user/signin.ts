// All sessions for one user share this sign-in holder. It persists a refreshed credential before returning a token sealed for the caller.
// The sign-in is the user's ChatGPT plan: the holder keeps it in the plan's `model_plan` row (credentials/plans.ts).

import { changed as machinesChanged } from "../user-machines.js";
import { type ItemsCtx, notifyProviderWaits, queueChanged } from "../user-items.js";
import { UserError } from "rivetkit";
import type { RawAccess } from "rivetkit/db";
import { clientError, requireService, requireServiceFor, requireUser, serviceParams } from "../../auth.js";
import type { ChatgptStatus, LinkedLogin, LoginProvider, ModelList, UserProfile } from "../../contract.js";
import { windlassModels } from "../../sandbox/harnesses.js";
import { ModelProblem, standInModels } from "../../account-models.js";
import { providerStatuses } from "../../credentials/keys.js";
import {
	chatgptPlanModels,
	loadChatgptSignIn,
	plansAllowed,
	saveChatgptCheck,
	writeChatgptSignIn,
} from "../../credentials/plans.js";
import { accountLabel, chatgptPlanLabel } from "../../credentials/plan-labels.js";
import type { ChatgptPlan } from "../../credentials/index.js";
import { errorText } from "../../util.js";
import { SandboxUserError, type AccessToken, type ChatgptAccount } from "../../sandbox/api.js";
import { type SealedTokenAnswer, type SignInAnswer, problemOf, tokenSubject } from "../../signin/directory.js";
import { SignInHolder } from "../../signin/holder.js";
import { getSignIns } from "../../signin/index.js";
import { getLayer } from "../../layer.js";
import type { UserCtx, UserVars } from "./state.js";

interface SignInCtx {
	vars: UserVars;
	db: RawAccess;
	key: string[];
}

// The save must finish before the holder hands out a refreshed token.
function signIn(c: SignInCtx): Promise<SignInHolder> {
	c.vars.signInDb = c.db;
	const vars = c.vars;
	const uid = c.key[0]!;
	const db = () => vars.signInDb as RawAccess;
	vars.signIn ??= getSignIns()
		.then(
			({ commands, sealer, hooks }) =>
				new SignInHolder({
					uid,
					commands,
					sealer,
					revoke: hooks.revoke,
					store: {
						load: () => loadChatgptSignIn(db()),
						save: row => writeChatgptSignIn(db(), row),
					},
				}),
		)
		.catch((error: unknown) => {
			vars.signIn = null;
			throw error;
		});
	return vars.signIn;
}

async function answered<T>(
	c: { log: { error: (entry: unknown) => void } },
	step: () => Promise<T>,
): Promise<SignInAnswer<T>> {
	try {
		return { ok: true, value: await step() };
	} catch (error) {
		const problem = problemOf(error);
		if (problem.kind === "other") c.log.error({ msg: "a step on the user's sign-in failed", error: problem.message });
		return { ok: false, problem };
	}
}

export interface ModelsCtx extends SignInCtx {
	keepAwake<T>(promise: Promise<T>): Promise<T>;
}

// Keep the actor awake until any sign-in refreshed while listing models is saved.
export async function modelsOf(c: ModelsCtx, demo: boolean): Promise<ModelList> {
	if (demo) return standInModels("demo");
	const account = await c.vars.models.current({
		db: c.db,
		generation: async () => (await loadChatgptSignIn(c.db))?.generation ?? null,
		list: () =>
			c.keepAwake((async () => (await getSignIns()).commands.models(await (await signIn(c)).accessToken()))()),
	});
	return windlassModels(account, await providerStatuses(c.db));
}

/**
 * The ChatGPT plan's current access token and its generation, for a relay request or a turn's relay: the holder
 * refreshes it when it has less than twenty minutes left. Null when there is no sign-in, or it was replaced while
 * the token was asked for. The refresh token never leaves the holder.
 */
export async function chatgptPlanToken(
	c: ModelsCtx,
): Promise<{ secret: string; generation: string; expiresAt: number } | null> {
	const before = await loadChatgptSignIn(c.db);
	if (!before) return null;
	let token: AccessToken;
	try {
		token = await c.keepAwake((await signIn(c)).accessToken());
	} catch (error) {
		if (error instanceof SandboxUserError) return null;
		throw error;
	}
	const after = await loadChatgptSignIn(c.db);
	if (after?.generation !== before.generation) return null;
	return { secret: token.accessToken, generation: before.generation, expiresAt: token.expiresAt };
}

/**
 * Learns the ChatGPT plan's account label ("a@b.com · Plus") from the saved sign-in and, where plans are on for the
 * user (only hosted Codex uses them), the models its catalog lists, with a current access token, server-side.
 * Without plans no token is asked for, so connecting ChatGPT for Windlass costs no extra request. A catalog that
 * does not answer keeps the models known before; never throws.
 */
export async function checkChatgptPlan(c: ModelsCtx): Promise<void> {
	const uid = c.key[0]!;
	try {
		const account = await (await signIn(c)).status();
		const row = await loadChatgptSignIn(c.db);
		if (!account || !row) return;
		const label = accountLabel(account.email, chatgptPlanLabel(account.planType));
		let models: string[] | null = null;
		if (plansAllowed(uid)) {
			const token = await chatgptPlanToken(c);
			if (token?.generation !== row.generation) return;
			models = await chatgptPlanModels(token.secret).catch((error: unknown) => {
				console.warn(`[wlp] plan.check_failed uid=${uid} provider=openai: ${errorText(error)}`);
				return null;
			});
		}
		await saveChatgptCheck(c.db, row.generation, { account: label, models });
	} catch (error) {
		console.warn(`[wlp] plan.check_failed uid=${uid} provider=openai: ${errorText(error)}`);
	}
}

/** The ChatGPT plan as credentials/index.ts reaches it. Forgetting it is forgetting the sign-in: Windlass and hosted Codex both stop using it. */
export function chatgptPlan(c: SignInActionCtx): ChatgptPlan {
	return {
		token: () => chatgptPlanToken(c),
		adopt: async material => {
			await (await getLayer()).logins.ensureUserVolume(c.key[0]!);
			await (await signIn(c)).adoptMaterial(material);
			await adopted(c);
		},
		check: () => checkChatgptPlan(c),
		forget: () => forgetSignIn(c, c.key[0]!),
	};
}

export function modelInput<T>(pick: () => T, refusalCode?: "bad_input"): T {
	try {
		return pick();
	} catch (error) {
		if (error instanceof ModelProblem) throw new UserError(error.message, { code: refusalCode ?? error.code });
		throw error;
	}
}

export type SignInActionCtx = ModelsCtx & ItemsCtx;

/** API-token admission and background work use this actor-local profile. Only a new login may update it. */
export async function writeActorProfile(c: UserCtx, profile: UserProfile, atLogin: boolean): Promise<void> {
	const written = await c.db.execute(
		`INSERT INTO profile (id, uid, email, demo, updated_at) VALUES (1, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET email=excluded.email, demo=excluded.demo, updated_at=excluded.updated_at
		WHERE ? RETURNING id`,
		profile.uid,
		profile.email,
		Number(profile.demo),
		Date.now(),
		Number(atLogin),
	);
	if (written.length) c.vars.profile = profile;
}

/** After a new sign-in is stored: its label and models, and everything waiting on a ChatGPT sign-in hears of it. */
async function adopted(c: SignInActionCtx): Promise<void> {
	await checkChatgptPlan(c);
	if (c.vars.machines.size) await machinesChanged(c);
	queueChanged(c);
	await notifyProviderWaits(c, c.vars.items.items.values(), "adopted");
	c.vars.reached = true;
	console.log(`[wlp] sign-in.adopted uid=${c.key[0]}`);
}

async function forgetSignIn(c: SignInActionCtx, uid: string) {
	await (await signIn(c)).logout();
	await c.vars.models.forget(c.db);
	console.log(`[wlp] sign-in.forgotten uid=${uid}`);
}

export const signinActions = {
	linkedLogins: (c: SignInActionCtx): Promise<LinkedLogin[]> => {
		const { uid } = requireUser(c);
		return c.client().accountIdentities.getOrCreate(["platform"], { params: serviceParams() }).internalLinked(uid);
	},
	unlinkLogin: (c: SignInActionCtx, provider: LoginProvider): Promise<void> => {
		const { uid } = requireUser(c);
		return c
			.client()
			.accountIdentities.getOrCreate(["platform"], { params: serviceParams() })
			.internalUnlink(uid, provider);
	},
	internalLogin: async (c: SignInActionCtx, profile: UserProfile): Promise<number> => {
		requireServiceFor(c, "call");
		if (profile.uid !== c.key[0]) throw new UserError("Invalid login owner.", { code: "forbidden" });
		await writeActorProfile(c, profile, true);
		c.vars.reached = true;
		return c.vars.tokenGen;
	},
	chatgpt: async (c: SignInActionCtx): Promise<ChatgptStatus> => {
		const profile = requireUser(c);
		try {
			const account = profile.demo ? null : await (await signIn(c)).status();
			if (!account) return { connected: false, email: null, accessExpiresAt: null };
			return { connected: true, email: account.email ?? null, accessExpiresAt: account.accessExpiresAt ?? null };
		} catch (error) {
			throw clientError(c.log, error, "The ChatGPT sign-in could not be checked.");
		}
	},
	forgetChatgpt: async (c: SignInActionCtx): Promise<void> => {
		const profile = requireUser(c);
		if (profile.demo) return;
		try {
			await forgetSignIn(c, profile.uid);
		} catch (error) {
			throw clientError(c.log, error, "The ChatGPT sign-in could not be forgotten. Try again.");
		}
	},
	models: async (c: SignInActionCtx): Promise<ModelList> => {
		const profile = requireUser(c);
		try {
			return await modelsOf(c, profile.demo);
		} catch (error) {
			throw clientError(c.log, error, "Your models could not be read. Try again.");
		}
	},
	internalAdoptSignIn: async (c: SignInActionCtx, sealed: string): Promise<SignInAnswer<null>> => {
		requireService(c);
		return answered(c, async () => {
			await (await signIn(c)).adopt(sealed);
			await adopted(c);
			return null;
		});
	},
	internalSignInStatus: async (c: SignInActionCtx): Promise<SignInAnswer<ChatgptAccount | null>> => {
		requireService(c);
		return answered(c, async () => (await signIn(c)).status());
	},
	internalSignOut: async (c: SignInActionCtx): Promise<SignInAnswer<null>> => {
		requireService(c);
		return answered(c, async () => {
			await forgetSignIn(c, c.key[0]!);
			return null;
		});
	},
	// Seal the token for this request's nonce after persisting any refreshed sign-in.
	internalAccessToken: async (c: SignInActionCtx, nonce: string): Promise<SealedTokenAnswer> => {
		requireService(c);
		if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
			return { ok: false, problem: { kind: "other", message: "the request for an access token carries no nonce" } };
		try {
			const holder = await signIn(c);
			const token = await c.keepAwake(holder.accessToken());
			const { sealer } = await getSignIns();
			return { ok: true, sealed: sealer.seal("transit", tokenSubject(c.key[0]!, nonce), JSON.stringify(token)) };
		} catch (error) {
			const problem = problemOf(error);
			if (problem.kind === "other")
				c.log.error({ msg: "the user's access token could not be had", error: problem.message });
			return { ok: false, problem };
		}
	},
	internalModels: async (c: SignInActionCtx): Promise<ModelList> => {
		requireService(c);
		return modelsOf(c, false);
	},
};
