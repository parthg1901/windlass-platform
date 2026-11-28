/**
 * What the Connections page and the first-run setup read: the saved keys, the connected plans and the ChatGPT
 * sign-in (`ConnectionInputs`, lib/connections.ts), read again whenever a key or plan changes (`PROVIDERS_CHANGED`),
 * and the Pay-with choices (server/src/pay-with.ts).
 */
import type { PayWithChoice, PayWithPatch } from "@contract";
import { useCallback, useEffect, useState } from "react";
import type { ConnectionInputs } from "../lib/connections";
import { useApp, useAuth } from "./app";
import { readKeysAndPlans, useChatgpt, watchModelChanges } from "./hooks";

export function useConnectionInputs(): { inputs: ConnectionInputs | null; error: string | null } {
	const { client, explain } = useApp();
	const auth = useAuth();
	const chatgpt = useChatgpt();
	const [read, setRead] = useState<Pick<ConnectionInputs, "keys" | "plans"> | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(
		() =>
			watchModelChanges(isCurrent => {
				readKeysAndPlans(client.user(auth)).then(
					([keys, plans]) => {
						if (!isCurrent()) return;
						setRead({ keys, plans });
						setError(null);
					},
					(failure: unknown) => isCurrent() && setError(explain(failure)),
				);
			}),
		[client, auth, explain],
	);
	const demo = auth.profile.demo;
	// The demo user has no ChatGPT sign-in to wait for.
	const inputs =
		read && (demo || chatgpt.status || chatgpt.error)
			? { ...read, chatgpt: Boolean(chatgpt.status?.connected), canConnectChatgpt: !demo }
			: null;
	return { inputs, error };
}

/** The Pay-with choices, and saving one agent's: the list comes back whole from the save. */
export function usePayWith() {
	const { client, explain } = useApp();
	const auth = useAuth();
	const [choices, setChoices] = useState<PayWithChoice[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState<PayWithPatch["harness"] | null>(null);
	useEffect(() => {
		let live = true;
		client
			.user(auth)
			.payWith()
			.then(
				list => live && setChoices(list),
				(failure: unknown) => live && setError(explain(failure)),
			);
		return () => {
			live = false;
		};
	}, [client, auth, explain]);
	const save = useCallback(
		async (patch: PayWithPatch) => {
			setSaving(patch.harness);
			setError(null);
			// Shown at once; the server's answer replaces it.
			setChoices(now => now?.map(one => (one.harness === patch.harness ? { ...one, ...patch } : one)) ?? now);
			try {
				setChoices(await client.user(auth).savePayWith(patch));
			} catch (failure) {
				setError(explain(failure));
				client
					.user(auth)
					.payWith()
					.then(setChoices, () => undefined);
			} finally {
				setSaving(null);
			}
		},
		[client, auth, explain],
	);
	return { choices, error, saving, save };
}
