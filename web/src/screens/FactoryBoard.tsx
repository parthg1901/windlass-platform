import type { ItemSummary } from "@contract";
import { useCallback, useEffect, useId, useState } from "react";
import { boardCards, boardTracks, columnName, PIPELINE_COLUMNS, type BoardCard, type BoardColumn } from "../lib/board";
import { HARNESS_NAMES } from "../lib/acp";
import { absoluteTime, compact, plural, relativeTime } from "../lib/format";
import { machineLabel } from "../lib/machines";
import type { FeedFilters } from "../lib/repositories";
import { linkProps, useHistoryState } from "../lib/router";
import { itemDoing, subtaskState } from "../lib/subtasks";
import { EndedFoot, useEndedPages } from "./Items";
import { ItemStanding } from "../components/ItemRow";
import { ItemSourceTag } from "../components/ItemSource";
import { requestNumber } from "../lib/host";
import { questionLine } from "../lib/items";
import { useMachines } from "../state/machines";

const COLUMN_LIMIT = 8;

function costSoFar({ item, parts }: BoardCard): string | null {
	const cost = item.agent?.cost;
	if (cost)
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: cost.currency,
			maximumFractionDigits: 2,
		}).format(cost.amount);
	const tokens = item.spent.tokens + parts.reduce((sum, part) => sum + part.spent.tokens, 0);
	return tokens > 0 ? `${compact(tokens)} tokens` : null;
}

function placeOf(item: ItemSummary, machines: Map<string, string>): string | null {
	if (item.state === "draft") return null;
	if (item.placement?.name) return item.placement.name;
	if (item.place.kind === "hosted") return "hosted";
	return machines.get(item.place.machineId) ?? "your machine";
}

function Card({
	card,
	now,
	reviewer,
	machines,
}: {
	card: BoardCard;
	now: number;
	reviewer: boolean;
	machines: Map<string, string>;
}) {
	const { item, parts } = card;
	if (card.column === "ended") {
		return (
			<li data-state={item.state}>
				<a className="board-ended-title" {...linkProps({ name: "item", id: item.id })}>
					{item.title}
				</a>
				<span className="board-ended-meta">
					{item.state === "done" ? "merged" : item.state}
					{item.pullRequest && ` · #${item.pullRequest.number}`}
				</span>
			</li>
		);
	}
	const needs = card.column === "needs";
	const asking = item.question ? item : parts.find(part => part.question);
	let line;
	if (asking) line = asking === item ? questionLine(item) : `${asking.title}: ${questionLine(asking)}`;
	else if (item.state === "review") line = <ItemStanding item={item} reviewer={reviewer} />;
	else if (item.state === "draft") line = "Draft, not started.";
	else if (!parts.length && item.state === "waiting" && item.wait) line = item.wait.sentence;
	else if (!parts.length) {
		const { word, fact } = itemDoing(item, now);
		line = fact ? `${word} · ${fact}` : word;
	}
	const place = placeOf(item, machines);
	const agent = HARNESS_NAMES[item.agent?.harness ?? "windlass"];
	const action =
		needs && asking
			? { words: "Answer", id: asking.id }
			: card.column === "ready"
				? { words: "Open", id: item.id }
				: null;
	return (
		<li className="board-card" data-state={item.state}>
			<a className="board-card-title" {...linkProps({ name: "item", id: item.id })}>
				{item.title}
				{needs ? <span className="visually-hidden"> (waiting for your answer)</span> : null}
			</a>
			{line && <p className={item.state === "review" && !asking ? "board-card-standing" : "board-card-why"}>{line}</p>}
			{parts.length > 0 ? (
				<ul className="board-parts" aria-label={`Open parts of ${item.title}`}>
					{parts.slice(0, 5).map(part => {
						const state = subtaskState(part);
						return (
							<li key={part.id} className={`board-part board-part-${state}`}>
								<a className="board-part-title" {...linkProps({ name: "item", id: part.id })} title={part.title}>
									{part.title}
								</a>
								<span className="board-part-doing">{itemDoing(part, now).word}</span>
							</li>
						);
					})}
					{parts.length > 5 ? (
						<li className="board-part board-part-more">{plural(parts.length - 5, "more part")}</li>
					) : null}
				</ul>
			) : null}
			<p className="board-card-meta">
				<span>
					{item.repository.owner}/{item.repository.name}
					{item.pullRequest ? requestNumber(item.repository.provider, item.pullRequest.number) : ""}
				</span>
				{item.source !== "web" ? (
					<span>
						<ItemSourceTag source={item.source} origin={item.origin} />
					</span>
				) : null}
				<span>{place ? `${agent} · ${place}` : agent}</span>
			</p>
			<div className="board-card-foot">
				<span className="board-card-cost">{costSoFar(card)}</span>
				{action ? (
					<a
						className="board-card-action"
						{...linkProps({ name: "item", id: action.id })}
						aria-label={`${action.words}: ${item.title}`}
					>
						{action.words}
					</a>
				) : (
					<time
						className="board-card-time"
						dateTime={new Date(item.updatedAt).toISOString()}
						title={absoluteTime(item.updatedAt)}
					>
						{relativeTime(item.updatedAt, now)}
					</time>
				)}
			</div>
		</li>
	);
}

export function FactoryBoard({
	list,
	children,
	filters,
	endedCount,
	now,
	reviewer,
}: {
	list: readonly ItemSummary[];
	children?: readonly ItemSummary[];
	filters: FeedFilters;
	endedCount: number;
	now: number;
	reviewer: boolean;
}) {
	const columns = boardCards(list, children, reviewer);
	const id = useId();
	// Kept in the history entry: Back from an item brings the columns shown in full back.
	const [expanded, setExpanded] = useHistoryState<Partial<Record<BoardColumn, boolean>>>("board", {});
	const [trayLimit, setTrayLimit] = useState(2);
	const measureTray = useCallback((grid: HTMLUListElement | null) => {
		if (!grid) return;
		const measure = () => setTrayLimit(2 * getComputedStyle(grid).gridTemplateColumns.split(" ").length);
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(grid);
		return () => observer.disconnect();
	}, []);

	const endedTarget = expanded.ended ? endedCount : Math.min(endedCount, COLUMN_LIMIT);
	const needsPages = endedTarget > columns.ended.length;
	const pages = useEndedPages(needsPages, filters, list);
	useEffect(() => {
		if (needsPages && pages.items.length < endedTarget && pages.more && !pages.loading && !pages.error)
			pages.loadMore();
	}, [needsPages, endedTarget, pages]);
	if (pages.items.length) columns.ended = boardCards(pages.items, undefined, reviewer).ended;

	const onMachine = list.some(item => item.place.kind === "machine" && !item.placement?.name && item.state !== "draft");
	const machineList = useMachines(onMachine).list;
	const machines = new Map(machineList?.map(machine => [machine.machineId, machineLabel(machine)]));

	function columnView(column: BoardColumn) {
		const tray = column === "needs";
		const ended = column === "ended";
		const cards = columns[column];
		if (tray && !cards.length) return null;
		const total = ended ? endedCount : cards.length;
		const limit = tray ? trayLimit : COLUMN_LIMIT;
		const open = !!expanded[column];
		const listId = `${id}-${column}`;
		const Heading = tray ? "h2" : "h3";
		if (!tray && total === 0) {
			// Nothing in it: a slim strip, its name and count standing up.
			return (
				<section
					key={column}
					className={`board-column board-column-${column} board-column-slim`}
					aria-labelledby={`${listId}-heading`}
				>
					<Heading id={`${listId}-heading`} className="board-heading">
						{columnName(column, reviewer)} <span className="board-column-count">0</span>
					</Heading>
				</section>
			);
		}
		return (
			<section
				key={column}
				className={tray ? "board-tray" : `board-column board-column-${column}`}
				aria-labelledby={`${listId}-heading`}
			>
				<Heading id={`${listId}-heading`} className="board-heading">
					{columnName(column, reviewer)} <span className="board-column-count">{total}</span>
				</Heading>
				<ul id={listId} className={ended ? "board-ended" : "board-cards"} ref={tray ? measureTray : undefined}>
					{(open ? cards : cards.slice(0, limit)).map(card => (
						<Card key={card.item.id} card={card} now={now} reviewer={reviewer} machines={machines} />
					))}
				</ul>
				{total > limit && (
					<button
						type="button"
						className="link board-toggle"
						aria-expanded={open}
						aria-controls={listId}
						onClick={() => setExpanded({ ...expanded, [column]: !expanded[column] })}
					>
						{open ? "Show fewer" : tray ? `Show all ${total}` : `Show ${total - limit} more`}
					</button>
				)}
				{ended && needsPages && (pages.loading || pages.error) && <EndedFoot pages={pages} />}
			</section>
		);
	}

	return (
		<div className="factory-board">
			{columnView("needs")}
			<div
				className="board-pipeline"
				role="group"
				aria-label="Where each work item is"
				tabIndex={0}
				style={{
					gridTemplateColumns: boardTracks({
						planning: columns.planning.length,
						building: columns.building.length,
						ci: columns.ci.length,
						review: columns.review.length,
						ready: columns.ready.length,
						ended: endedCount,
					}),
				}}
			>
				{PIPELINE_COLUMNS.map(columnView)}
			</div>
		</div>
	);
}
