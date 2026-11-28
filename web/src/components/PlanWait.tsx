/**
 * What an item waiting for its plan offers (`Wait.plan`, the server's Pay with): pay this one turn with the saved key
 * instead, where one can (`useKeyNow`), or change the rule on Connections. The wait's own sentence says until when.
 */
import { PLAN_NAMES, type Wait } from "@contract";
import { useState } from "react";
import { errorMessage } from "../api/client";
import { linkProps } from "../lib/router";

/** The Pay-with card of the agent a plan pays for, on Connections (`PayWithCard`'s id). */
const PAY_CARD: Record<NonNullable<Wait["plan"]>["provider"], string> = {
	anthropic: "pay-claude",
	openai: "pay-codex",
};

export function PlanWaitActions({ plan, onUseKey }: { plan: NonNullable<Wait["plan"]>; onUseKey(): Promise<void> }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const useKey = async () => {
		setBusy(true);
		setError(null);
		try {
			await onUseKey();
		} catch (failure) {
			setError(errorMessage(failure));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="plan-wait" aria-label={`Waiting for your ${PLAN_NAMES[plan.provider]}`}>
			<p className="plan-wait-ask">
				{plan.keyNow ? "Rather not wait? Your saved key can pay for this turn." : "Change who pays on Connections."}
			</p>
			<div className="plan-wait-actions">
				{plan.keyNow ? (
					<button
						type="button"
						className="button button-outline button-small"
						disabled={busy}
						onClick={() => void useKey()}
					>
						{busy ? "Switching…" : "Use my key now"}
					</button>
				) : null}
				<a
					className="button button-quiet button-small"
					{...linkProps({ name: "connections", section: PAY_CARD[plan.provider] })}
				>
					Change who pays
				</a>
			</div>
			{error ? (
				<p className="field-note tone-bad" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}
