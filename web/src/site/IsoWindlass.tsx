/**
 * The landing's hero picture: an isometric windlass on a deck, hauling work items in on its line. Each
 * item passes the Factory's gates (implement, check, CI, review) and, as it reaches the drum, comes up
 * as a pull request ready for you.
 *
 * Drawn in code from one projection (`iso`), so every face, coil and label sits on the same grid. It is
 * static SVG: everything that moves is CSS in landing.css (`.iso-*`), timed from the constants below,
 * and under reduced motion the picture holds still with one item under each gate.
 *
 * Timing: the line moves at HAUL / LOOP units a second. Items leave every LOOP / ITEMS seconds, so a
 * gate's lamp blinks with that period, offset by how far down the line the gate stands; the drum turns
 * at the same surface speed as the line.
 */
import type { CSSProperties } from "react";

const C = Math.cos(Math.PI / 6);
const S = 0.5;
const OX = 566;
const OY = 50;

type Point = [number, number];

/** World (x across the deck, y along the line toward you, z up) to the page. */
function iso(x: number, y: number, z: number): Point {
	return [OX + (x - y) * C, OY + (x + y) * S - z];
}

const f = (n: number) => Math.round(n * 10) / 10;
const pts = (...ps: [number, number, number][]) => ps.map(([x, y, z]) => iso(x, y, z).map(f).join(",")).join(" ");
const at = (x: number, y: number, z: number) => iso(x, y, z).map(f).join(" ");

/* ---- the layout and the clock ---------------------------------------------------------------------- */

const LINE_X = 100;
const START = 584;
const END = 142;
const HAUL = START - END;
const LOOP = 14;
const ITEMS = 4;
const GAP = LOOP / ITEMS;

const DRUM = { y: 86, z: 44, r: 32, from: 56, to: 144, flange: 40 };
const ROPE_Z = DRUM.z - DRUM.r;
/** Seconds the drum takes to turn once: its surface moves with the line. */
const TURN = (2 * Math.PI * DRUM.r) / (HAUL / LOOP);

const GATES = [
	{ y: 512, n: "02", label: "plan", kind: "plan" },
	{ y: 434, n: "03", label: "build", kind: "implement" },
	{ y: 356, n: "04", label: "check", kind: "check" },
	{ y: 278, n: "05", label: "ci", kind: "ci" },
	{ y: 202, n: "06", label: "review", kind: "review" },
] satisfies { y: number; n: string; label: string; kind: GateKind }[];

const CRATES = ["#412", "#418", "#423", "#427"];
const PULLS = ["#88", "#89", "#90", "#91"];

/* ---- shapes ------------------------------------------------------------------------------------- */

/** A box's three visible faces: top, the face toward +x (right), the face toward +y (left). */
function Box({
	x0,
	x1,
	y0,
	y1,
	z0,
	z1,
	className = "",
}: {
	x0: number;
	x1: number;
	y0: number;
	y1: number;
	z0: number;
	z1: number;
	className?: string;
}) {
	return (
		<g className={`iso-box ${className}`}>
			<polygon className="iso-l" points={pts([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0])} />
			<polygon className="iso-r" points={pts([x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [x1, y0, z0])} />
			<polygon className="iso-t" points={pts([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1])} />
		</g>
	);
}

/** A point on a circle of radius r in the plane x = const, around (y, z); t = 0 points toward you (+y), 90° straight down. */
function ring(x: number, y: number, z: number, r: number, t: number): Point {
	const a = (t * Math.PI) / 180;
	return iso(x, y + r * Math.cos(a), z - r * Math.sin(a));
}

function arc(x: number, y: number, z: number, r: number, t0: number, t1: number, steps = 40): string[] {
	const out: string[] = [];
	for (let i = 0; i <= steps; i++)
		out.push(
			ring(x, y, z, r, t0 + ((t1 - t0) * i) / steps)
				.map(f)
				.join(" "),
		);
	return out;
}

/** A cylinder lying along x: the far rim's outer half, the near rim's visible half, the two tangents between. */
function cylinder(x0: number, x1: number, y: number, z: number, r: number): string {
	const back = arc(x0, y, z, r, 45, 225);
	const front = arc(x1, y, z, r, -135, 45);
	return `M${back.join(" L")} L${front.join(" L")} Z`;
}

/** The SVG matrix that lays flat drawing (u right, v down) onto the plane x = const, centred at (y, z). */
function face(x: number, y: number, z: number): string {
	const [px, py] = iso(x, y, z);
	return `matrix(${f(-C * 1000) / 1000} ${S} 0 1 ${f(px)} ${f(py)})`;
}

/** The SVG matrix that lays flat drawing onto a top face (z = const): text runs along +x, its top toward the drum. */
function top(x: number, y: number, z: number): string {
	const [px, py] = iso(x, y, z);
	return `matrix(${f(C * 1000) / 1000} ${S} ${f(-C * 1000) / 1000} ${S} ${f(px)} ${f(py)})`;
}

function teeth(r: number, count: number, depth: number): string {
	const out: string[] = [];
	for (let i = 0; i < count; i++) {
		const a0 = (i / count) * Math.PI * 2;
		const a1 = ((i + 0.72) / count) * Math.PI * 2;
		const a2 = ((i + 1) / count) * Math.PI * 2;
		out.push(`${i === 0 ? "M" : "L"}${f(Math.cos(a0) * r)} ${f(Math.sin(a0) * r)}`);
		out.push(`L${f(Math.cos(a1) * (r + depth))} ${f(Math.sin(a1) * (r + depth))}`);
		out.push(`L${f(Math.cos(a2) * r)} ${f(Math.sin(a2) * r)}`);
	}
	return `${out.join(" ")} Z`;
}

/** One end of the windlass: an A-frame in the plane x, standing on a sill. */
function Frame({ x }: { x: number }) {
	const { y, z } = DRUM;
	const leg = (dir: 1 | -1) => (
		<>
			<polygon
				className="iso-l"
				points={pts([x, y - 3 * dir, z + 7], [x, y + 3 * dir, z + 7], [x, y + 40 * dir, 6], [x, y + 31 * dir, 6])}
			/>
			<polygon
				className="iso-r"
				points={pts(
					[x + 5, y - 3 * dir, z + 7],
					[x + 5, y + 3 * dir, z + 7],
					[x + 5, y + 40 * dir, 6],
					[x + 5, y + 31 * dir, 6],
				)}
			/>
		</>
	);
	return (
		<g className="iso-frame">
			<Box x0={x - 3} x1={x + 8} y0={y - 48} y1={y + 48} z0={0} z1={6} />
			{leg(-1)}
			{leg(1)}
			<polygon
				className="iso-r"
				points={pts([x + 5, y - 6, z + 4], [x + 5, y + 6, z + 4], [x + 5, y + 8, z - 4], [x + 5, y - 8, z - 4])}
			/>
			<circle className="iso-hub" cx={iso(x + 5, y, z)[0]} cy={iso(x + 5, y, z)[1]} r={2.6} />
		</g>
	);
}

type GateKind = "plan" | "implement" | "check" | "ci" | "review";

function Lamp({
	x,
	y,
	z,
	delay,
	r = 4.2,
	className = "",
}: {
	x: number;
	y: number;
	z: number;
	delay: number;
	r?: number;
	className?: string;
}) {
	const [cx, cy] = iso(x, y, z);
	return (
		<ellipse
			className={`iso-lamp ${className}`}
			cx={f(cx)}
			cy={f(cy)}
			rx={r}
			ry={f(r * 0.56)}
			style={{ animationDelay: `${f(delay * 100) / 100}s` } as CSSProperties}
		/>
	);
}

/** A disc lamp standing in the plane x (facing you on the right), for the signal tower. */
function SideLamp({ x, y, z, delay }: { x: number; y: number; z: number; delay: number }) {
	return (
		<g transform={face(x, y, z)}>
			<circle className="iso-lamp" r={3.6} style={{ animationDelay: `${f(delay * 100) / 100}s` } as CSSProperties} />
		</g>
	);
}

/**
 * Each stage has its own gate. `back` is what stands behind the items (drawn first), `front` what stands
 * before them. implement: a sandbox the item goes through. check: a scanner with a lamp per test and a
 * console. ci: a tall gantry with a signal tower. review: a second agent's booth, its camera over the line.
 */
function Gate({ kind, y, part, delay }: { kind: GateKind; y: number; part: "back" | "front"; delay: number }) {
	const L = LINE_X;
	if (kind === "plan") {
		if (part === "back")
			return <Box className="iso-post" x0={L - 26} x1={L - 22} y0={y - 2} y1={y + 2} z0={0} z1={52} />;
		const tag = (dx: number, z: number) => (
			<g key={dx}>
				<path className="iso-cable" d={`M${at(L + dx, y, 50)} L${at(L + dx, y, z + 6)}`} />
				<Box className="iso-tag" x0={L + dx - 4} x1={L + dx + 4} y0={y - 1} y1={y + 1} z0={z} z1={z + 6} />
			</g>
		);
		return (
			<g>
				<Box className="iso-post" x0={L + 22} x1={L + 26} y0={y - 2} y1={y + 2} z0={0} z1={52} />
				<Box className="iso-beam" x0={L - 26} x1={L + 26} y0={y - 3} y1={y + 3} z0={50} z1={56} />
				{tag(-13, 34)}
				{tag(0, 38)}
				{tag(13, 34)}
				<Box className="iso-post" x0={L + 42} x1={L + 45} y0={y - 1.5} y1={y + 1.5} z0={0} z1={22} />
				<polygon
					className="iso-t iso-board"
					points={pts([L + 34, y - 12, 30], [L + 54, y - 12, 22], [L + 54, y + 12, 22], [L + 34, y + 12, 30])}
				/>
				<path
					className="iso-screen-lines iso-board-lines"
					d={[[-7], [-1], [5]].map(([d]) => `M${at(L + 40, y + d!, 27.6)} L${at(L + 50, y + d!, 23.6)}`).join(" ")}
				/>
				<Lamp x={L} y={y + 3} z={56} delay={delay} r={3} />
			</g>
		);
	}
	if (kind === "implement") {
		if (part === "back")
			return <Box className="iso-wall" x0={L - 28} x1={L - 24} y0={y - 18} y1={y + 18} z0={0} z1={42} />;
		const vents = [-10, 0, 10].map(d => `M${at(L - 20, y + d, 46)} L${at(L + 20, y + d, 46)}`).join(" ");
		return (
			<g>
				<Box className="iso-wall" x0={L + 24} x1={L + 28} y0={y - 18} y1={y + 18} z0={0} z1={42} />
				<Box className="iso-roof" x0={L - 30} x1={L + 30} y0={y - 20} y1={y + 20} z0={42} z1={46} />
				<path className="iso-vents" d={vents} />
				<polygon
					className="iso-sandbox"
					points={pts([L - 27, y + 20, 40], [L + 27, y + 20, 40], [L + 27, y + 20, 2], [L - 27, y + 20, 2])}
				/>
				<Lamp x={L + 20} y={y + 14} z={46} delay={delay} r={3.4} />
			</g>
		);
	}
	if (kind === "check") {
		if (part === "back")
			return <Box className="iso-post" x0={L - 26} x1={L - 22} y0={y - 2} y1={y + 2} z0={0} z1={50} />;
		const console_ = { x0: L + 38, x1: L + 52, y0: y - 9, y1: y + 9 };
		return (
			<g>
				<Box className="iso-post" x0={L + 22} x1={L + 26} y0={y - 2} y1={y + 2} z0={0} z1={50} />
				<Box className="iso-beam" x0={L - 26} x1={L + 26} y0={y - 3} y1={y + 3} z0={48} z1={54} />
				{[-12, 0, 12].map((d, i) => (
					<Lamp key={d} x={L + d} y={y} z={54} delay={delay + i * 0.16} r={2.8} />
				))}
				<path className="iso-cable" d={`M${at(L + 26, y, 6)} L${at(console_.x0, y, 6)}`} />
				<Box className="iso-console" {...console_} z0={0} z1={24} />
				<g transform={face(console_.x1, y, 17)}>
					<rect className="iso-screen" x={-7} y={-5} width={14} height={11} rx={1} />
					<path className="iso-screen-lines" d="M-4.5 -2 H3 M-4.5 0.8 H4.5 M-4.5 3.6 H1.5" />
				</g>
			</g>
		);
	}
	if (kind === "ci") {
		if (part === "back")
			return <Box className="iso-post" x0={L - 27} x1={L - 22} y0={y - 3} y1={y + 3} z0={0} z1={70} />;
		return (
			<g>
				<Box className="iso-post" x0={L + 22} x1={L + 27} y0={y - 3} y1={y + 3} z0={0} z1={70} />
				<Box className="iso-beam" x0={L - 27} x1={L + 27} y0={y - 4} y1={y + 4} z0={64} z1={70} />
				<path
					className="iso-truss"
					d={`M${at(L - 22, y + 3, 64)} L${at(L - 8, y + 3, 56)} L${at(L + 8, y + 3, 64)} L${at(L + 22, y + 3, 56)} M${at(L - 8, y + 3, 56)} H${iso(L + 22, y + 3, 56)[0].toFixed(1)}`}
				/>
				<Box className="iso-post" x0={L + 42} x1={L + 46} y0={y - 2} y1={y + 2} z0={0} z1={58} />
				<Box className="iso-console" x0={L + 39} x1={L + 49} y0={y - 5} y1={y + 5} z0={58} z1={88} />
				{[64, 73, 82].map((z, i) => (
					<SideLamp key={z} x={L + 49} y={y} z={z} delay={delay + (2 - i) * 0.18} />
				))}
				<Box className="iso-console" x0={L + 36} x1={L + 52} y0={y - 8} y1={y + 8} z0={0} z1={3} />
			</g>
		);
	}
	// review
	if (part === "back") return null;
	const [lx, ly] = iso(L, y, 48);
	const [a0] = iso(L - 14, y, 24);
	const [a1] = iso(L + 14, y, 24);
	const lip = iso(L, y, 24)[1];
	return (
		<g>
			<polygon
				className="iso-cone"
				points={`${f(lx - 3)},${f(ly)} ${f(lx + 3)},${f(ly)} ${f(a1 + 4)},${f(lip + 8)} ${f(a0 - 4)},${f(lip - 6)}`}
				style={{ animationDelay: `${f(delay * 100) / 100}s` } as CSSProperties}
			/>
			<Box className="iso-beam" x0={L - 6} x1={L + 46} y0={y - 2} y1={y + 2} z0={58} z1={62} />
			<Box className="iso-post" x0={L + 42} x1={L + 46} y0={y - 2} y1={y + 2} z0={30} z1={58} />
			<Box className="iso-post" x0={L - 4} x1={L + 4} y0={y - 4} y1={y + 4} z0={50} z1={58} />
			<g transform={top(L, y, 50)}>
				<circle className="iso-lens" r={5.5} style={{ animationDelay: `${f(delay * 100) / 100}s` } as CSSProperties} />
			</g>
			<Box className="iso-booth" x0={L + 32} x1={L + 62} y0={y - 15} y1={y + 15} z0={0} z1={30} />
			<Box className="iso-roof" x0={L + 30} x1={L + 64} y0={y - 17} y1={y + 17} z0={30} z1={33} />
			<polygon
				className="iso-window"
				points={pts([L + 37, y + 15, 24], [L + 57, y + 15, 24], [L + 57, y + 15, 12], [L + 37, y + 15, 12])}
			/>
			<Lamp x={L + 47} y={y + 15} z={33} delay={delay} r={2.6} />
		</g>
	);
}

function GateLabel({ y, n, label, kind }: { y: number; n: string; label: string; kind: GateKind }) {
	const [x0, y0] = iso(72, y, kind === "ci" ? 70 : kind === "implement" ? 44 : kind === "plan" ? 54 : 52);
	const x1 = x0 - 18;
	const y1 = (kind === "ci" ? y0 + 10 : y0) - 12;
	return (
		<g className="iso-label">
			<path className="iso-leader" d={`M${f(x0 - 2)} ${f(y0 - 1)} L${f(x1)} ${f(y1)} H${f(x1 - 6)}`} />
			<text x={f(x1 - 10)} y={f(y1 + 3.5)} textAnchor="end">
				<tspan className="iso-label-n">{n}</tspan> {label}
			</text>
		</g>
	);
}

function Crate({ index, label }: { index: number; label: string }) {
	const y = START;
	// Still (reduced motion), item i waits under gate i; moving, it leaves GAP seconds after the one before.
	const still = (START - GATES[index % GATES.length]!.y) / HAUL;
	const style = {
		animationDelay: `${f(-index * GAP * 100) / 100}s`,
		"--iso-p": f(still * 1000) / 1000,
	} as CSSProperties;
	return (
		<g className="iso-crate" style={style}>
			<Box x0={LINE_X - 15} x1={LINE_X + 15} y0={y - 15} y1={y + 15} z0={0} z1={24} />
			<text className="iso-crate-label" transform={top(LINE_X - 10, y + 4, 24)}>
				{label}
			</text>
			<circle
				className="iso-crate-dot"
				cx={f(iso(LINE_X + 15, y + 8, 12)[0])}
				cy={f(iso(LINE_X + 15, y + 8, 12)[1])}
				r={1.8}
			/>
		</g>
	);
}

function PullTag({ index, label }: { index: number; label: string }) {
	const [x, y] = iso(LINE_X + 6, DRUM.y, DRUM.z + 74);
	const style = { animationDelay: `${f(-index * GAP * 100) / 100}s` } as CSSProperties;
	return (
		<g
			className={index === 0 ? "iso-pull iso-pull-still" : "iso-pull"}
			style={style}
			transform={`translate(${f(x)} ${f(y)})`}
		>
			<g className="iso-pull-in">
				<rect x={-84} y={-13} width={168} height={26} rx={7} />
				<circle cx={-71} cy={0} r={3} />
				<text x={-62} y={4}>
					PR {label} · windlass/verified ✓
				</text>
			</g>
		</g>
	);
}

/** A part of the picture that builds in on load: the `i`th, 160 ms after the one before (landing.css `.iso-in`). */
const build = (i: number, className = "iso-in") => ({ className, style: { "--i": i } as CSSProperties });

/* ---- the picture -------------------------------------------------------------------------------- */

export function IsoWindlass() {
	const { y: dy, z: dz, r, from, to, flange } = DRUM;
	const rope = `M${at(LINE_X, 620, ROPE_Z)} L${at(LINE_X, dy, ROPE_Z)}`;
	const coils: string[] = [];
	for (let x = from + 6; x <= to - 5; x += 9.5) coils.push(`M${arc(x, dy, dz, r + 0.6, -135, 45, 28).join(" L")}`);
	const grid: string[] = [];
	for (let x = 0; x <= 200; x += 40) grid.push(`M${at(x, 0, 0)} L${at(x, 620, 0)}`);
	for (let y = 0; y <= 620; y += 40) grid.push(`M${at(0, y, 0)} L${at(200, y, 0)}`);
	const timing = {
		"--iso-loop": `${LOOP}s`,
		"--iso-gap": `${GAP}s`,
		"--iso-turn": `${f(TURN * 100) / 100}s`,
		"--iso-click": `${f((TURN / 16) * 1000) / 1000}s`,
		"--iso-dash": `${f((8 / (HAUL / LOOP)) * 1000) / 1000}s`,
	} as CSSProperties;
	const [ex, ey] = iso(LINE_X - 18, 606, 0);
	const [wx, wy] = iso(to + 30, dy - 40, dz + 30);
	const travel = { "--iso-dx": `${f(HAUL * C)}px`, "--iso-dy": `${f(-HAUL * S)}px` } as CSSProperties;
	return (
		<svg className="iso" viewBox="0 8 850 468" role="img" aria-labelledby="iso-title" style={{ ...timing, ...travel }}>
			<title id="iso-title">
				A windlass on a deck hauls work items in on its line. Each is planned, built, checked, run through CI and
				reviewed, and comes up as a pull request ready for you.
			</title>

			{/* the deck */}
			<g {...build(0)}>
				<Box className="iso-deck" x0={0} x1={200} y0={0} y1={620} z0={-12} z1={0} />
				<path className="iso-grid" d={grid.join(" ")} />
				<path
					className="iso-track"
					d={`M${at(LINE_X - 18, 620, 0)} L${at(LINE_X - 18, dy + 50, 0)} M${at(LINE_X + 18, 620, 0)} L${at(LINE_X + 18, dy + 50, 0)}`}
				/>
			</g>

			{/* the windlass: back frame, drum with its line, front frame and crank */}
			<g {...build(GATES.length + 1)}>
				<Frame x={from - 16} />
				<path className="iso-l iso-flange" d={cylinder(from - 4, from, dy, dz, flange)} />
				<path className="iso-drum" d={cylinder(from, to, dy, dz, r)} />
				<path className="iso-coils" d={coils.join(" ")} />
				<path className="iso-l iso-flange" d={cylinder(to, to + 4, dy, dz, flange)} />
				<g transform={face(to + 4, dy, dz)}>
					<circle className="iso-r iso-cap" r={flange} />
					<g className="iso-spin">
						<path className="iso-ratchet" d={teeth(flange - 9, 16, 4)} />
						<path
							className="iso-spokes"
							d={`M0 ${-flange + 13} V${flange - 13} M${-(flange - 13) * C} ${-(flange - 13) * S} L${(flange - 13) * C} ${(flange - 13) * S} M${-(flange - 13) * C} ${(flange - 13) * S} L${(flange - 13) * C} ${-(flange - 13) * S}`}
						/>
						<circle className="iso-tick" cx={0} cy={-(flange - 5)} r={2.2} />
					</g>
					<circle className="iso-axle" r={5} />
					<g className="iso-pawl" transform={`translate(${f((flange - 2) * 0.7)} ${f(-(flange - 2) * 0.72)})`}>
						<g className="iso-pawl-arm">
							<path d="M0 0 L-9 9 L-6 11 Z" />
							<circle r={2} />
						</g>
					</g>
				</g>
				<Frame x={to + 12} />
				<g transform={face(to + 18, dy, dz)}>
					<g className="iso-spin">
						<path className="iso-crank" d="M0 0 L0 -24" />
						<circle className="iso-crank-knob" cx={0} cy={-24} r={3.4} />
					</g>
				</g>
			</g>

			{/* the line and what it hauls */}
			<g {...build(GATES.length + 2, "iso-in-fade")}>
				<path className="iso-rope" d={rope} />
				<path className="iso-rope-lay" d={rope} />
			</g>
			{GATES.map((gate, index) => (
				<g key={gate.y} {...build(index + 1)}>
					<Gate kind={gate.kind} y={gate.y} part="back" delay={0} />
				</g>
			))}
			<g className="iso-crates iso-in-fade" style={{ "--i": GATES.length + 3 } as CSSProperties}>
				{CRATES.map((label, index) => (
					<Crate key={label} index={index} label={label} />
				))}
			</g>
			{GATES.map((gate, index) => {
				const at = (LOOP * (START - gate.y)) / HAUL;
				return (
					<g key={gate.y} {...build(index + 1)}>
						<Gate kind={gate.kind} y={gate.y} part="front" delay={(at % GAP) - GAP} />
					</g>
				);
			})}

			{/* labels */}
			{GATES.map((gate, index) => (
				<g key={gate.y} {...build(index + 1.6, "iso-in-fade")}>
					<GateLabel {...gate} />
				</g>
			))}
			<g className="iso-label iso-in-fade" style={{ "--i": 0.6 } as CSSProperties}>
				<path className="iso-leader" d={`M${f(ex - 2)} ${f(ey - 2)} L${f(ex - 22)} ${f(ey - 14)} H${f(ex - 28)}`} />
				<text x={f(ex - 32)} y={f(ey - 11)} textAnchor="end">
					<tspan className="iso-label-n">01</tspan> file
				</text>
				<text className="iso-label-sub" x={f(ex - 32)} y={f(ey + 2.5)} textAnchor="end">
					an issue or a chat
				</text>
			</g>
			<g className="iso-label iso-in-fade" style={{ "--i": GATES.length + 1.6 } as CSSProperties}>
				<text x={f(wx + 18)} y={f(wy)}>
					<tspan className="iso-label-n">07</tspan> verified
				</text>
				<text className="iso-label-sub" x={f(wx + 18)} y={f(wy + 13.5)}>
					08 · you merge, or auto-merge
				</text>
			</g>
			{PULLS.map((label, index) => (
				<PullTag key={label} index={index} label={label} />
			))}
		</svg>
	);
}
