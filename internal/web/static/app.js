// ping — the whole dashboard. Fetches GET /api/status and draws it.
//
// The server sends buckets with a Start timestamp and the window's From/To
// bounds. Gaps are absent from the array, never zero-filled, so everything here
// is positioned from (Start - From) / (To - From) and never from an index. Draw
// bucket[i] at i/180 and a stretch where the prober was down silently vanishes.

const WINDOWS = ["1h", "3h", "12h", "1d", "3d", "7d"];
const MIN_COL = 368; // px — narrowest a card may get before dropping a column
const GAP = 20;
// How far apart two buckets may sit before the space between them counts as a
// hole rather than the normal rhythm of a slow monitor.
const GAP_FACTOR = 1.75;
const BUCKETS = 180;
const REFRESH_S = 30;

const state = {
	window: initialWindow(),
	monitors: [],
	open: null, // name of the monitor shown in the dialog
};

const els = {
	summary: document.getElementById("summary"),
	windows: document.getElementById("windows"),
	monitors: document.getElementById("monitors"),
	countdown: document.getElementById("countdown"),
	jsonLink: document.getElementById("json-link"),
	detail: document.getElementById("detail"),
	detailBody: document.getElementById("detail-body"),
};

// ---------------------------------------------------------------- utilities

function el(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	// textContent, never innerHTML: monitor names and URLs come from the
	// database and are not ours to trust.
	if (text !== undefined) node.textContent = text;
	return node;
}

function svg(tag, attrs = {}) {
	const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
	for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
	return node;
}

function initialWindow() {
	const asked = new URLSearchParams(location.search).get("window");
	return WINDOWS.includes(asked) ? asked : "1h";
}

const ms = (iso) => new Date(iso).getTime();

// The observed spacing between buckets, which is NOT the bucket width: a
// monitor probed every 60s in a window with 20s buckets produces one bucket per
// three, and every bucket looks isolated. Comparing against the bucket width
// there marks a perfectly healthy monitor as all gap.
function cadence(buckets, bucketMs) {
	if (buckets.length < 2) return bucketMs;

	const gaps = [];
	for (let i = 1; i < buckets.length; i++) {
		gaps.push(ms(buckets[i].Start) - ms(buckets[i - 1].Start));
	}
	gaps.sort((a, b) => a - b);

	// Median, so one real outage does not drag the estimate up.
	return Math.max(bucketMs, gaps[Math.floor(gaps.length / 2)]);
}

function bucketState(b) {
	if (b.OKCount === b.Total) return "up";
	if (b.OKCount === 0) return "down";
	return "degraded";
}

// A monitor is not "down" because it was retired — that is a third state, and
// its history is still worth looking at.
function monitorState(m) {
	if (!m.Enabled) return { key: "idle", label: "retired" };
	if (m.Buckets.length === 0) return { key: "idle", label: "no data" };
	return m.Up ? { key: "up", label: "up" } : { key: "down", label: "down" };
}

function clockLabel(t, span) {
	const d = new Date(t);
	const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	if (span <= 24 * 3600e3) return time;
	return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

const int = (n) => Math.round(n).toLocaleString();

// Round a scale maximum up to something a person would pick.
function niceMax(v) {
	if (v <= 0) return 1;
	const pow = 10 ** Math.floor(Math.log10(v));
	for (const step of [1, 1.5, 2, 2.5, 5, 10]) {
		if (v <= step * pow) return step * pow;
	}
	return 10 * pow;
}

// ------------------------------------------------------------------ fetching

async function load() {
	try {
		const res = await fetch(`/api/status?window=${state.window}`, {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) throw new Error(`status ${res.status}`);
		state.monitors = await res.json();
		render();
	} catch (err) {
		// Refetch keeps the frame: on a failed poll the previous render stays put
		// rather than blanking the page.
		els.summary.textContent = `Couldn't reach the API (${err.message})`;
	}
}

// ------------------------------------------------------------------- filters

function renderWindows() {
	els.windows.replaceChildren();
	for (const w of WINDOWS) {
		const b = el("button", "window", w);
		b.type = "button";
		if (w === state.window) b.setAttribute("aria-current", "true");
		b.addEventListener("click", () => {
			state.window = w;
			history.replaceState(null, "", `/?window=${w}`);
			renderWindows();
			load();
		});
		els.windows.append(b);
	}
	els.jsonLink.href = `/api/status?window=${state.window}`;
}

// --------------------------------------------------------------------- cards

function render() {
	const live = state.monitors.filter((m) => m.Enabled);
	const up = live.filter((m) => m.Up).length;
	els.summary.textContent =
		`${up} of ${live.length} up · ${state.window} window · ` +
		`as of ${new Date().toLocaleTimeString()}`;

	lastCols = columnCount();
	els.monitors.replaceChildren(...state.monitors.map((m, i) => card(m, lastCols, i)));
	els.monitors.setAttribute("aria-busy", "false");
	layout();

	if (state.open) {
		const m = state.monitors.find((x) => x.Name === state.open);
		if (m) fillDetail(m); // keep an open dialog current across refreshes
	}
}

// Masonry proper: every card goes into whichever column is currently shortest,
// so a short card (one with no checks) lets its neighbour ride up beside it.
// CSS `columns` cannot do this — it fills column-major, which both reorders the
// list and leaves the columns ragged.
function columnCount(width = els.monitors.clientWidth) {
	return Math.max(1, Math.floor((width + GAP) / (MIN_COL + GAP)));
}

function layout() {
	const box = els.monitors;
	const cards = [...box.children];
	if (cards.length === 0) {
		box.style.height = "";
		return;
	}

	const width = box.clientWidth;
	const cols = columnCount(width);
	const colWidth = (width - GAP * (cols - 1)) / cols;

	// Width for every card first, heights afterwards: interleaving the two makes
	// the browser re-lay-out the whole list on each read.
	for (const c of cards) c.style.width = `${colWidth}px`;

	const bottoms = new Array(cols).fill(0);
	for (const c of cards) {
		let col = 0;
		for (let i = 1; i < cols; i++) {
			if (bottoms[i] < bottoms[col] - 0.5) col = i;
		}
		c.style.left = `${col * (colWidth + GAP)}px`;
		c.style.top = `${bottoms[col]}px`;
		bottoms[col] += c.offsetHeight + GAP;
	}

	box.style.height = `${Math.max(...bottoms) - GAP}px`;
}

// Relayout on resize, and once the webfont lands — Geist is wider than the
// fallback, so card heights change under it.
let pending = 0;
let lastCols = 0;
window.addEventListener("resize", () => {
	cancelAnimationFrame(pending);
	pending = requestAnimationFrame(() => {
		// Crossing a column boundary changes which card layouts are in play, so
		// that case needs a re-render rather than a reposition.
		if (columnCount() !== lastCols) render();
		else layout();
	});
});
if (document.fonts) document.fonts.ready.then(layout);

// Three card layouts carrying identical information — a stylistic choice, not a
// semantic one. The variant follows position in the (name-sorted) list rather
// than a hash of the name: a hash distributes unevenly on a handful of monitors,
// and four of one layout beside two of another looks like a bug rather than a
// pattern. Position is stable across refreshes; it only shifts when a monitor is
// added or removed, which is a config change, not something the page does on its
// own.
const VARIANTS = ["v-standard", "v-hero", "v-compact"];

function variantFor(index, cols) {
	if (cols < 2) return 0; // single column: one layout, no novelty
	return index % VARIANTS.length;
}

function card(m, cols, index) {
	const s = monitorState(m);
	const v = variantFor(index, cols);

	const root = el("button", `monitor is-${s.key} ${VARIANTS[v]}`);
	root.type = "button";
	root.setAttribute("aria-label", `${m.Name}, ${s.label}. Open latency detail.`);
	root.addEventListener("click", () => openDetail(m));

	const pill = el("span", `pill pill-${s.key}`, s.label);
	const name = el("span", "monitor-name", m.Name);
	const url = el("p", "monitor-url", m.URL);
	const uptime = figure(`${m.Uptime.toFixed(2)}%`, "uptime");
	const avg = figure(`${int(m.AvgMS)}ms`, "avg");

	const head = el("div", "monitor-head");

	if (v === 1) {
		// Hero: the number first, at display size, the way the masthead reads.
		const big = el("div", "hero");
		const value = m.Buckets.length ? `${m.Uptime.toFixed(2)}%` : "—";
		big.append(el("b", "hero-value", value), el("span", "hero-label", "uptime"));
		head.append(pill, name);
		root.append(big, head, url);
		root.append(timeline(m, 52, 2), figures(avg));
	} else if (v === 2) {
		// Compact: strip straight under the title, the numbers beneath it, no axis.
		head.append(pill, name);
		root.append(head, timeline(m, 30, 0), figures(uptime, avg), url);
	} else {
		head.append(pill, name);
		root.append(head, url, figures(uptime, avg), timeline(m, 44, 2));
	}

	return root;
}

function figures(...items) {
	const row = el("div", "figures");
	row.append(...items);
	return row;
}

// The strip plus its axis, or the empty note when the window holds no checks.
function timeline(m, height, ticks) {
	if (m.Buckets.length === 0) return el("p", "empty empty-soft", "No checks in this window");

	const wrap = el("div", "timeline");
	wrap.append(strip(m, height));
	if (ticks > 0) wrap.append(axis(m, ticks));
	return wrap;
}

function figure(value, label) {
	const f = el("span", "figure");
	f.append(el("b", null, value), el("span", "figure-label", label));
	return f;
}

// The availability strip. One rect per bucket, x from its timestamp. Drawn in a
// 1000-unit viewBox with preserveAspectRatio="none" so it stretches to whatever
// width the card ends up with, and the arithmetic stays in one place.
function strip(m, height) {
	const from = ms(m.From);
	const to = ms(m.To);
	const span = to - from;
	const step = cadence(m.Buckets, span / BUCKETS);
	const limit = step * GAP_FACTOR;

	const root = svg("svg", {
		class: "strip",
		viewBox: "0 0 1000 40",
		preserveAspectRatio: "none",
		"shape-rendering": "crispEdges",
		height,
		role: "img",
		"aria-label": `${m.Name}: ${m.Uptime.toFixed(2)}% of checks succeeded`,
	});

	m.Buckets.forEach((b, i) => {
		const st = bucketState(b);
		const start = ms(b.Start);
		// A bar covers the ground up to the next bucket, so a monitor checked
		// less often than the bucket width still reads as continuous. Capped at
		// `limit`, so a stretch where nothing ran is still a visible hole.
		const next = i + 1 < m.Buckets.length ? ms(m.Buckets[i + 1].Start) : Math.min(start + step, to);
		const width = (Math.min(next - start, limit) / span) * 1000;

		const rect = svg("rect", {
			class: `bar bar-${st}`,
			x: Math.max(0, ((start - from) / span) * 1000),
			y: 0,
			width: width + 0.3, // hairline overlap so neighbours do not seam
			height: 40,
		});
		// Texture on the amber bucket: green↔amber measures ΔE 7.7 under
		// protanopia, which is inside the floor band where colour alone is not
		// allowed to carry the distinction.
		if (st === "degraded") rect.setAttribute("fill", "url(#hatch)");
		const title = svg("title");
		title.textContent = bucketTitle(b, span);
		rect.append(title);
		root.append(rect);
	});

	return root;
}

function bucketTitle(b, span) {
	return (
		`${clockLabel(ms(b.Start), span)} — ${b.OKCount}/${b.Total} ok · ` +
		`avg ${int(b.AvgMS)}ms · max ${int(b.MaxMS)}ms`
	);
}

function axis(m, ticks = 4) {
	const from = ms(m.From);
	const span = ms(m.To) - from;
	const root = el("div", "axis");
	for (let i = 0; i <= ticks; i++) {
		const frac = i / ticks;
		const label = el("span", null, clockLabel(from + frac * span, span));
		label.style.left = `${frac * 100}%`;
		root.append(label);
	}
	return root;
}

// -------------------------------------------------------------------- detail

function openDetail(m) {
	state.open = m.Name;
	fillDetail(m);
	els.detail.showModal();
}

els.detail.addEventListener("close", () => {
	state.open = null;
});

// Click outside the panel closes it.
els.detail.addEventListener("click", (e) => {
	if (e.target === els.detail) els.detail.close();
});

function fillDetail(m) {
	const s = monitorState(m);
	const body = el("div", "detail-inner");

	const head = el("div", "detail-head");
	const name = el("h2", "detail-name", m.Name);
	name.id = "detail-name";
	head.append(el("span", `pill pill-${s.key}`, s.label), name);
	body.append(head, el("p", "detail-url", m.URL));

	if (m.Buckets.length === 0) {
		body.append(el("p", "empty", "No checks in this window."));
		els.detailBody.replaceChildren(body);
		return;
	}

	const checks = m.Buckets.reduce((n, b) => n + b.Total, 0);
	const failed = m.Buckets.reduce((n, b) => n + (b.Total - b.OKCount), 0);
	const worst = Math.max(...m.Buckets.map((b) => b.MaxMS));

	const tiles = el("div", "tiles");
	tiles.append(
		tile(`${m.Uptime.toFixed(2)}%`, "uptime", s.key),
		tile(`${int(m.AvgMS)}ms`, "avg latency"),
		tile(`${int(worst)}ms`, "slowest bucket"),
		tile(int(checks), "checks"),
		tile(int(failed), "failed", failed > 0 ? "down" : null),
	);
	body.append(tiles);

	body.append(sectionTitle("Latency", `${state.window} · milliseconds`));
	body.append(latencyChart(m));

	body.append(sectionTitle("Availability", "one bar per bucket"));
	const wide = el("div", "detail-strip");
	wide.append(strip(m, 56), axis(m));
	body.append(wide);

	els.detailBody.replaceChildren(body);
}

function tile(value, label, tone) {
	const t = el("div", `tile${tone ? ` tile-${tone}` : ""}`);
	t.append(el("b", "tile-value", value), el("span", "tile-label", label));
	return t;
}

function sectionTitle(title, note) {
	const h = el("div", "section-title");
	h.append(el("h3", null, title), el("span", "section-note", note));
	return h;
}

// Two marks, one axis: a filled area for each bucket's max and a line for its
// average. Never two y-scales.
function latencyChart(m) {
	const W = 760;
	const H = 260;
	const pad = { l: 56, r: 18, t: 18, b: 30 };
	const from = ms(m.From);
	const span = ms(m.To) - from;
	const step = cadence(m.Buckets, span / BUCKETS);

	const top = niceMax(Math.max(...m.Buckets.map((b) => b.MaxMS)));
	const x = (t) => pad.l + ((t - from) / span) * (W - pad.l - pad.r);
	const y = (v) => H - pad.b - (v / top) * (H - pad.t - pad.b);

	const root = svg("svg", {
		class: "chart",
		viewBox: `0 0 ${W} ${H}`,
		role: "img",
		"aria-label": `Latency for ${m.Name}: average ${int(m.AvgMS)} milliseconds over the last ${state.window}`,
	});

	// Recessive grid, with the value labels on the left.
	for (let i = 0; i <= 4; i++) {
		const v = (top / 4) * i;
		root.append(
			svg("line", { class: "grid", x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v) }),
		);
		const label = svg("text", { class: "tick tick-y", x: pad.l - 8, y: y(v) + 4 });
		label.textContent = int(v);
		root.append(label);
	}

	for (let i = 0; i <= 4; i++) {
		const t = from + (span / 4) * i;
		const label = svg("text", {
			class: "tick",
			x: x(t),
			y: H - pad.b + 18,
			"text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle",
		});
		label.textContent = clockLabel(t, span);
		root.append(label);
	}

	// Break both marks wherever a bucket is missing, so the line never draws a
	// straight run across an outage the prober did not observe.
	for (const run of runs(m.Buckets, step)) {
		const pts = run.map((b) => [x(ms(b.Start) + step / 2), b]);

		// A lone sample has no line to be part of — draw it as a point rather
		// than dropping it, which is what used to empty the whole chart.
		if (pts.length === 1) {
			const [px, b] = pts[0];
			root.append(svg("circle", { class: "point-max", cx: px, cy: y(b.MaxMS), r: 4 }));
			root.append(svg("circle", { class: "point-avg", cx: px, cy: y(b.AvgMS), r: 4.5 }));
			continue;
		}

		const area =
			`M${pts[0][0]},${y(0)} ` +
			pts.map(([px, b]) => `L${px},${y(b.MaxMS)}`).join(" ") +
			` L${pts[pts.length - 1][0]},${y(0)} Z`;
		root.append(svg("path", { class: "area-max", d: area }));
		root.append(
			svg("path", {
				class: "line-avg",
				d: "M" + pts.map(([px, b]) => `${px},${y(b.AvgMS)}`).join(" L"),
			}),
		);
	}

	const last = m.Buckets[m.Buckets.length - 1];
	root.append(directLabel(x(ms(last.Start)) - 6, y(last.MaxMS) - 8, "max", "label-max"));
	root.append(directLabel(x(ms(last.Start)) - 6, y(last.AvgMS) + 16, "avg", "label-avg"));

	return withCrosshair(root, m, { W, H, pad, x, y, from, span, step });
}

// Consecutive buckets, split wherever the spacing exceeds the monitor's own
// rhythm. Single-bucket runs are kept: latencyChart draws them as points.
function runs(buckets, step) {
	const out = [];
	let run = [];
	for (const b of buckets) {
		const prev = run[run.length - 1];
		if (prev && ms(b.Start) - ms(prev.Start) > step * GAP_FACTOR) {
			out.push(run);
			run = [];
		}
		run.push(b);
	}
	if (run.length) out.push(run);
	return out;
}

function directLabel(px, py, text, className) {
	const t = svg("text", { class: `direct ${className}`, x: px, y: py, "text-anchor": "end" });
	t.textContent = text;
	return t;
}

// Crosshair + tooltip: an SVG line chart that cannot be interrogated is a
// picture of data, not a reading of it.
function withCrosshair(chart, m, geo) {
	const wrap = el("div", "chart-wrap");
	const tip = el("div", "tip");
	tip.hidden = true;

	const hair = svg("line", {
		class: "hair",
		y1: geo.pad.t,
		y2: geo.H - geo.pad.b,
		x1: 0,
		x2: 0,
		visibility: "hidden",
	});
	const dot = svg("circle", { class: "hair-dot", r: 4.5, visibility: "hidden" });
	chart.append(hair, dot);

	function move(event) {
		const box = chart.getBoundingClientRect();
		const px = ((event.clientX - box.left) / box.width) * geo.W;
		const t = geo.from + ((px - geo.pad.l) / (geo.W - geo.pad.l - geo.pad.r)) * geo.span;

		let near = null;
		let best = Infinity;
		for (const b of m.Buckets) {
			const d = Math.abs(ms(b.Start) - t);
			if (d < best) {
				best = d;
				near = b;
			}
		}
		if (!near || best > geo.step * GAP_FACTOR) return hide();

		const hx = geo.x(ms(near.Start));
		hair.setAttribute("x1", hx);
		hair.setAttribute("x2", hx);
		hair.setAttribute("visibility", "visible");
		dot.setAttribute("cx", hx);
		dot.setAttribute("cy", geo.y(near.AvgMS));
		dot.setAttribute("visibility", "visible");

		tip.replaceChildren();
		tip.append(el("b", "tip-time", clockLabel(ms(near.Start), geo.span)));
		tip.append(tipRow("avg", `${int(near.AvgMS)}ms`, "avg"));
		tip.append(tipRow("max", `${int(near.MaxMS)}ms`, "max"));
		tip.append(tipRow("ok", `${near.OKCount}/${near.Total}`, bucketState(near)));
		tip.hidden = false;
		// Keep it inside the plot: a tooltip that hangs off the right edge of the
		// dialog is clipped, and the last bucket is the one you check first.
		const pct = Math.min(86, Math.max(14, (hx / geo.W) * 100));
		tip.style.left = `${pct}%`;
	}

	function hide() {
		hair.setAttribute("visibility", "hidden");
		dot.setAttribute("visibility", "hidden");
		tip.hidden = true;
	}

	chart.addEventListener("pointermove", move);
	chart.addEventListener("pointerleave", hide);
	wrap.append(chart, tip);
	return wrap;
}

function tipRow(label, value, key) {
	const row = el("div", "tip-row");
	row.append(el("i", `key key-${key}`), el("span", "tip-label", label), el("b", null, value));
	return row;
}

// --------------------------------------------------------------------- chrome

document.getElementById("theme-toggle").addEventListener("click", () => {
	const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
	document.documentElement.dataset.theme = next;
	try {
		localStorage.setItem("ping-theme", next);
	} catch (e) {
		// Private mode: the toggle still works for this page view.
	}
});

let left = REFRESH_S;
setInterval(() => {
	left -= 1;
	if (left <= 0) {
		left = REFRESH_S;
		load();
	}
	els.countdown.textContent = String(left).padStart(2, "0");
}, 1000);

renderWindows();
load();
