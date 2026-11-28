import { byteSize, count, plural, sandboxTime } from "../lib/format";
import { linkProps } from "../lib/router";
import { FoldRows } from "./Fold";
import { useItems } from "../state/items";
import { useCostRates } from "../state/hooks";
import { costWords, summaryCost, usd } from "../lib/cost";
import type { CostRates, FactoryLimits, ItemSummary } from "@contract";
import { spendWords } from "../lib/budget";
import { CostFigure } from "./CostFigure";
import { SourceNames } from "./ProviderIcon";

function Of({ spent, budget, spell }: { spent: number; budget: number; spell(value: number): string }) {
	return (
		<>
			<span>{spell(spent)}</span>
			<span className="tone-faint"> / {spell(budget)}</span>
		</>
	);
}

/** What the listed items added to your bills together, and what their model work is worth at API prices. */
function ListedTotal({ list, rates }: { list: readonly ItemSummary[]; rates: CostRates }) {
	const costs = list.map(item => summaryCost(item, rates));
	const extra = costs.reduce((total, cost) => total + cost.extraUsd, 0);
	const work = costs.reduce((total, cost) => total + cost.workUsd, 0);
	return (
		<p className="usage-note factory-cost-total">
			The items listed here cost <strong>{usd(extra)} extra</strong>: what your API keys paid and hosted time past your
			plan's minutes. Their model work is worth {usd(work)} at API prices
			{costs.some(cost => cost.unknown) ? ", some cost unknown" : ""}; turns on a Claude or ChatGPT plan are included in
			it.
		</p>
	);
}

export function FactoryUsage({ value }: { value: FactoryLimits }) {
	const { feed, list, error } = useItems();
	const rates = useCostRates();
	// The feed carries the newest ended items only; the older ones are on the Factory page.
	const older = feed ? feed.counts.ended - feed.ended.length : 0;
	return (
		<>
			<p className="usage-lede">
				Each item may spend {spendWords(value.item, null)}, every turn at API prices whoever pays, and{" "}
				{sandboxTime(value.item.hostedSeconds)} of hosted time, then it asks you for more.
			</p>
			<details className="usage-note factory-limits-fold">
				<summary>All limits</summary>
				<dl className="usage-facts factory-limits">
					<div>
						<dt>Hosted sandboxes</dt>
						<dd className="usage-number">{count(value.hostedRunning)}</dd>
						<dd className="usage-gloss">
							running at once on Hosted, work items and your own agents together; more wait their turn
						</dd>
					</div>
					<div>
						<dt>A feature</dt>
						<dd className="factory-limit-text">
							Its subtasks' budgets, as you approve them in its plan, and one item's for its planning, summary and
							review
						</dd>
					</div>
					<div>
						<dt>Items filed from connected services</dt>
						<dd className="factory-limit-text">
							{count(value.githubItemsPerDay)} a day (UTC) in total, whether they come from <SourceNames join="or" />.
							Drafts count.
						</dd>
					</div>
					<div>
						<dt>Screenshots</dt>
						<dd className="factory-limit-text">
							{byteSize(value.attachments.bytes)} each · {count(value.attachments.perItem)} per item ·{" "}
							{byteSize(value.attachments.accountBytes)} per account · kept for {plural(value.attachments.days, "day")}{" "}
							after an item ends
						</dd>
					</div>
					<div>
						<dt>Your machines</dt>
						<dd className="factory-limit-text">Not limited here</dd>
					</div>
				</dl>
			</details>

			{list === null ? (
				error ? (
					<p className="usage-empty tone-bad">The work items could not be loaded: {error}</p>
				) : null
			) : list.length === 0 ? (
				<div className="state state-empty factory-empty">
					<p>No work items yet.</p>
				</div>
			) : (
				<>
					{rates ? <ListedTotal list={list} rates={rates} /> : null}
					<FoldRows items={list} shown={10}>
						{(rows, id) => (
							<table className="usage-table factory-cost" id={id}>
								<thead>
									<tr>
										<th scope="col">Item, spent so far</th>
										<th scope="col" className="usage-number">
											Cost
										</th>
										<th scope="col" className="usage-number usage-wide">
											Working
										</th>
										<th scope="col" className="usage-number">
											Hosted
										</th>
									</tr>
								</thead>
								<tbody>
									{rows.map(item => (
										<tr key={item.id}>
											<th scope="row">
												<a className="usage-agent" {...linkProps({ name: "item", id: item.id })}>
													{item.title}
												</a>
											</th>
											<td className="usage-number factory-cost-figure">
												{rates ? <CostFigure words={costWords(summaryCost(item, rates)) ?? "—"} /> : "…"}
											</td>
											<td className="usage-number usage-wide tone-dim">{sandboxTime(item.spent.activeSeconds)}</td>
											<td className="usage-number">
												{item.place.kind === "hosted" ? (
													<Of spent={item.spent.hostedSeconds} budget={item.budget.hostedSeconds} spell={sandboxTime} />
												) : (
													<span className="tone-faint">your machine</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</FoldRows>
				</>
			)}
			{list !== null && older > 0 ? (
				<p className="usage-note factory-cost-older">
					And {plural(older, "older ended item")}, listed under Ended on the{" "}
					<a className="link" {...linkProps({ name: "factory" })}>
						Factory page
					</a>
					.
				</p>
			) : null}
		</>
	);
}
