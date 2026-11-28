import type { CostRates, ItemSummary, ItemView } from "@contract";
import { HARNESS_NAMES } from "../lib/acp";
import { CostFigure } from "./CostFigure";
import { costWords, lineWords, payerAmount, payerLabel, payerName, sandboxRows, summaryCost } from "../lib/cost";
import { compact, plural } from "../lib/format";
import { modelWords } from "../lib/models";
import { linkProps } from "../lib/router";
import { itemCost } from "../../../server/src/factory/cost.js";

const modelName = (model: string) => (model === "default" ? "agent's default" : modelWords(model));

/**
 * An item's cost, split by who carried it: the headline is what it added to your bills, then each plan's turns (and
 * their value at API prices), each key's dollars, and hosted time included in the Windlass plan or extra (lib/cost.ts).
 * The tokens behind it are in `CostByModel`.
 */
export function ItemCost({ view, rates }: { view: ItemView; rates: CostRates | null }) {
	if (!rates) return <p className="usage-note item-dollars-wait">Reading prices…</p>;
	const total = summaryCost(view, rates);
	const own = itemCost(view.spent.usage, rates);
	const parts: ItemSummary[] = view.children ?? [];
	const rows = [
		...(total.payers.length
			? total.payers.map(payer => ({ label: payerLabel(payer), value: payerAmount(payer) }))
			: [{ label: "Models", value: "None yet" }]),
		...sandboxRows(total, view.place.kind, rates),
	];
	return (
		<div className="item-dollars">
			<dl className="usage-facts item-facts item-cost">
				<div>
					<dt>Total</dt>
					<dd className="usage-number item-total">
						<CostFigure words={costWords(total) ?? "Nothing yet"} />
					</dd>
				</div>
				{rows.map(row => (
					<div key={row.label}>
						<dt>{row.label}</dt>
						<dd className="usage-number">{row.value}</dd>
					</div>
				))}
			</dl>
			{parts.length > 0 ? (
				<table className="usage-table item-dollars-table">
					<caption className="visually-hidden">Cost of each part</caption>
					<thead>
						<tr>
							<th scope="col">Part</th>
							<th scope="col" className="usage-number">
								Cost
							</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<th scope="row">Planning, review and summary</th>
							<td className="usage-number">{costWords(own) ?? "Nothing yet"}</td>
						</tr>
						{parts.map(part => (
							<tr key={part.id}>
								<th scope="row">
									<a className="link" {...linkProps({ name: "item", id: part.id })}>
										{part.title}
									</a>
								</th>
								<td className="usage-number">{costWords(summaryCost(part, rates)) ?? "Nothing yet"}</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
		</div>
	);
}

/** By model: who paid, the tokens behind each figure and where the prices come from, for "How this is counted". */
export function CostByModel({ view, rates }: { view: ItemView; rates: CostRates | null }) {
	if (!rates) return null;
	const total = summaryCost(view, rates);
	return (
		<>
			{total.lines.length > 0 ? (
				<div className="item-dollars-models">
					<table className="usage-table item-dollars-table">
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col">Paid by</th>
								<th scope="col" className="usage-number">
									Tokens
								</th>
								<th scope="col" className="usage-number">
									Cost
								</th>
							</tr>
						</thead>
						<tbody>
							{total.lines.map(line => (
								<tr key={`${line.harness}:${line.model}:${line.provider}:${line.payer}`}>
									<th scope="row">
										{HARNESS_NAMES[line.harness] ?? line.harness} · {modelName(line.model)}
									</th>
									<td>{payerName(line)}</td>
									<td className="usage-number tone-dim">
										{compact(line.tokens.inputTokens)} in ({compact(line.tokens.cachedInputTokens)} cached),{" "}
										{compact(line.tokens.outputTokens)} out · {plural(line.turns, "turn")}
									</td>
									<td className="usage-number">{lineWords(line)}</td>
								</tr>
							))}
						</tbody>
					</table>
					{rates.source ? (
						<p>
							Token prices from {rates.source.name}, read {new Date(rates.source.fetchedAt).toISOString().slice(0, 10)}.
							Claude Code's own reported cost is used where it gives one. Turns a plan carried are valued the same way,
							at API prices: the plan charges nothing more for them.
						</p>
					) : (
						<p>Token prices could not be read, so only what an agent reported of its own cost is counted.</p>
					)}
				</div>
			) : null}
		</>
	);
}
