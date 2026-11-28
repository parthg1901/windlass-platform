/**
 * Stops an item's turn at its budget while it runs (#100a). Where it stops is the blueprint's decision, handed over
 * with the delivery (session-inbox.ts `Delivery.budget`, factory/budget.ts `turnBudget`); this module only measures
 * the turn's spend so far in that figure and, once `crossedStop` says it reached it, calls `onOver` once. The turn
 * (turn.ts) then stops as a person's Stop would (`abortTurn`: the agent is cancelled and its conversation kept), the
 * item asks its budget question, and "give more" goes on where the turn stopped (blueprint `budgetStopped`).
 *
 * What is measured live:
 *   usd      the turn's dollars of work at today's prices, whoever pays (`turnUsd`): Windlass's per-step usage, or the
 *            cost an ACP agent reports with its usage updates (Claude Code's)
 *   tokens   Windlass's weighted tokens per step; an ACP agent reports its tokens only at the end, so it never stops
 * Interactive turns carry no budget and are never watched. What is not known never stops a turn.
 */

import type { CostRates, HarnessId, TurnUsage } from "../../contract.js";
import {
	crossedStop,
	type RunningSeen,
	type TurnBudget,
	type TurnFigure,
	turnUsd,
	weightedTokens,
} from "../../factory/budget.js";
import { turnMeter } from "../../factory/cost.js";
import { modelPrices } from "../../model-prices.js";
import { capabilitiesOf } from "../../sandbox/harnesses.js";
import { addUsage, type TurnCredential } from "../turn-resume.js";

export interface BudgetWatchInput {
	budget: TurnBudget;
	harness: HarnessId;
	credential: TurnCredential;
	itemSignIn?: TurnCredential["itemSignIn"];
	/** What the turn's earlier segments used (a resumed turn). */
	earlier: TurnUsage | null;
	/** Today's model prices; null where they cannot be read. */
	prices?: () => Promise<CostRates["models"] | null>;
	/** The turn reached its budget: called once, with what it used of the figure it reached. */
	onOver: (running: number, figure: TurnFigure) => void;
}

export class BudgetWatch {
	private usage: TurnUsage | null;
	private cost: { amount: number; currency: string } | null = null;
	private models: CostRates["models"] | null = null;
	private done = false;

	constructor(private readonly input: BudgetWatchInput) {
		this.usage = input.earlier;
		if (input.budget.figure === "usd") {
			const prices = input.prices ?? (() => modelPrices().then(rates => rates.models));
			void prices()
				.then(models => {
					this.models = models;
					this.check();
				})
				.catch(() => undefined);
		}
	}

	/** A model request's usage as the agent reported it (Windlass's steps). */
	used(usage: TurnUsage): void {
		this.usage = addUsage(this.usage, usage);
		this.check();
	}

	/** The turn's cost as an ACP agent reports it with a usage update. */
	reported(cost: { amount: number; currency: string } | null | undefined): void {
		if (!cost) return;
		this.cost = cost;
		this.check();
	}

	close(): void {
		this.done = true;
	}

	/** What the turn used so far in each figure it can be stopped at; null where it is not known. */
	running(): RunningSeen {
		const { credential, itemSignIn, harness } = this.input;
		const meter =
			this.models && (this.usage || this.cost)
				? turnMeter({
						harness,
						model: credential.model,
						key: credential.key,
						signIn: itemSignIn,
						usage: this.usage,
						cost: this.cost,
						size: null,
					})
				: undefined;
		const counted = capabilitiesOf(harness).events === "windlass";
		return {
			usd: meter ? (turnUsd(meter, this.models) ?? null) : null,
			tokens: counted && this.usage ? weightedTokens(this.usage) : null,
		};
	}

	private check(): void {
		if (this.done) return;
		const over = crossedStop(this.input.budget, this.running());
		if (!over) return;
		this.close();
		this.input.onOver(over.running, over.figure);
	}
}

export const budgetStopNote = (agent: string) =>
	`${agent} was stopped: this turn used what was left of the item's budget. Its work so far is kept.`;
