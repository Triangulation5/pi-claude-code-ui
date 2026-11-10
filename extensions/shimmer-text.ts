/**
 * Claude Code-style shimmer for the collapsed "Thinking..." row.
 *
 * While a thinking block streams in (collapsed), its single-line placeholder
 * row carries a bright highlight that sweeps across the glyphs, loops, and
 * repeats — same restless feel as Claude Code's thinking indicator.
 *
 * The sweep runs from a tiny self-contained ticker: pi's TUI only renders on
 * demand, so each frame the ticker invalidates registered rows, drops their
 * host's cached render, and nudges the active UI to re-render. Rows register
 * through WeakRefs, so stale instances disappear with the messages that own
 * them. The host link is the pi-claude-style-tools assistant message render
 * cache (shared via Symbol.for), cleared the same way the extension caches do.
 */

import { mixRgb, type Rgb } from "./theme-colors";

export const SHIMMER_LIVE_BODY = "Thinking...";

/** Host component that owns the row's rendered output (AssistantMessageComponent). */
export const SHIMMER_HOST_KEY = Symbol.for("pi-claude-style-tools:shimmer-host");
/** Same shared render cache the extension patches use for message components. */
const MESSAGE_RENDER_CACHE_KEY = Symbol.for("pi-claude-style-tools:message-render-cache");
/** Fresh UI handle (TuiBase) republished by the spinner's Loader patch. */
const ACTIVE_UI_KEY = Symbol.for("pi-claude-style-tools:active-ui");

export interface ShimmerRowLike {
    /** True while the row is the live "Thinking..." placeholder. */
    isShimmerText?: () => boolean;
    /** Drops the row's cached rendered lines. */
    invalidate?: () => void;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** One glyph of sweep progress per step. */
const CHAR_SWEEP_MS = 95;
/** Highlight half-width in glyphs — a tight crest, so a clear flash travels the row instead of a broad wash. */
const SWEEP_BLUR = 1.15;
/** Ticker cadence. */
const SHIMMER_FRAME_MS = 60;

const FALLBACK_BASE: Rgb = { r: 140, g: 140, b: 140 };

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

function parseAnsiColorToRgb(ansi: string): Rgb | null {
    if (!ansi) return null;
    const t = ansi.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
    if (t) return { r: Number(t[1]), g: Number(t[2]), b: Number(t[3]) };
    const i = ansi.match(/\x1b\[(?:38|48);5;(\d+)m/);
    if (i) {
        // xterm 256 ramp: 232-255 is the 24-step gray ramp.
        const n = Number(i[1]);
        if (n >= 232) {
            const level = 8 + (n - 232) * 10;
            return { r: level, g: level, b: level };
        }
        if (n === 7 || n === 15) return { r: 204, g: 204, b: 204 };
    }
    return null;
}

/** The bright end of the sweep: the base color pushed toward near-white. */
function highlightFor(base: Rgb): Rgb {
    return {
        r: Math.min(255, Math.round(base.r * 1.75 + 40)),
        g: Math.min(255, Math.round(base.g * 1.75 + 40)),
        b: Math.min(255, Math.round(base.b * 1.75 + 40)),
    };
}

function parseShimmerColor(value: string | undefined): Rgb | null {
    if (!value) return null;
    const ansi = parseAnsiColorToRgb(value);
    if (ansi) return ansi;
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    const hex = match[1].length === 3
        ? [...match[1]].map((digit) => `${digit}${digit}`).join("")
        : match[1];
    return {
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
    };
}

export type ShimmerDirection = "left-to-right" | "right-to-left";

/**
 * Renders `body` with the traveling highlight applied per glyph.
 *
 * The highlight glides across the glyphs and rests between sweeps, keeping the
 * base text steady instead of pulsing. `intensity` can ease the highlight back
 * to the base color; `hovered` rows keep their normal brighter base styling.
 */
export function renderShimmerText(
    body: string,
    baseAnsi: string,
    seed: number,
    hovered = false,
    nowMs: number = Date.now(),
    options: { direction?: ShimmerDirection; color?: string; intensity?: number } = {},
): string {
    const base = parseAnsiColorToRgb(baseAnsi) ?? FALLBACK_BASE;
    const highlight = parseShimmerColor(options.color) ?? highlightFor(base);
    const count = [...body].length;
    if (count === 0) return "";

    const sweepMs = Math.max(1, count - 1 + SWEEP_BLUR * 6) * CHAR_SWEEP_MS + 120;
    const rest = 650 + (Math.abs(seed) % 550);
    const period = sweepMs + rest;
    const front = ((nowMs + (Math.abs(seed) % period)) % period) / CHAR_SWEEP_MS - SWEEP_BLUR * 3;
    const hoverLift = hovered ? 0.08 : 0;
    const intensity = Math.max(0, Math.min(1, options.intensity ?? 1));

    let out = "";
    let index = 0;
    for (const glyph of body) {
        const position = options.direction === "right-to-left" ? count - 1 - index : index;
        const sweep = Math.exp(-((position - front) ** 2) / (2 * SWEEP_BLUR * SWEEP_BLUR));
        const amount = Math.max(0, Math.min(1, (sweep + hoverLift) * intensity));
        const color = mixRgb(base, highlight, amount);
        out += `\x1b[38;2;${Math.round(color.r)};${Math.round(color.g)};${Math.round(color.b)}m${glyph}`;
        index++;
    }
    return `${out}\x1b[0m`;
}

// ---------------------------------------------------------------------------
// Row registry + ticker
// ---------------------------------------------------------------------------

const rowRefs = new Set<WeakRef<ShimmerRowLike>>();
/** row → the object its sweep phase should track (the assistant message). */
const rowKeyByRow = new WeakMap<object, object>();
/** Stable per-key sweep seed, so rebuilds of the same row do not jump. */
const seedByKey = new WeakMap<object, number>();

let targetLive = false;
let ticker: ReturnType<typeof setInterval> | null = null;

/**
 * Registers a row so the ticker can animate it while it is live.
 * `phaseKey` should be something stable across row rebuilds (e.g. the
 * assistant message object) so the sweep does not restart its phase.
 */
export function noteShimmerRow(row: object, phaseKey?: object): void {
    if (!phaseKey) phaseKey = row;
    if (![...rowRefs].some((ref) => ref.deref?.() === row)) {
        rowRefs.add(new WeakRef(row as ShimmerRowLike));
    }
    if (!seedByKey.has(phaseKey)) seedByKey.set(phaseKey, Math.floor(Math.random() * 4_000));
    rowKeyByRow.set(row, phaseKey);
}

/** The row is live: start the ticker. */
export function noteShimmerActivity(active: boolean): void {
    if (active === targetLive) return;
    targetLive = active;
    if (active) {
        ensureTicker();
        shimmerTick();
        return;
    }
    // Deactivate: one final pass so lingering live rows flush their cached
    // shimmer gradient back to the static look, then wind the ticker down.
    finalizeSweep();
    shimmerTick();
}

/** Provides the UI handle the ticker should nudge to re-render. */
let renderProvider: (() => unknown) | undefined;
export function setShimmerRenderProvider(get: (() => unknown) | undefined): void {
    renderProvider = get;
}

function derefRows(): ShimmerRowLike[] {
    const rows: ShimmerRowLike[] = [];
    for (const ref of rowRefs) {
        const row = ref.deref?.();
        if (!row) {
            rowRefs.delete(ref);
            continue;
        }
        rows.push(row);
    }
    return rows;
}

function ensureTicker(): void {
    if (ticker) return;
    ticker = setInterval(() => shimmerTick(), SHIMMER_FRAME_MS);
    (ticker as any)?.unref?.();
}

function finalizeSweep(): void {
    for (const row of derefRows()) {
        if (typeof row.isShimmerText === "function" && row.isShimmerText()) refreshRow(row);
    }
}

function shimmerTick(): void {
    if (!targetLive) {
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
        return;
    }
    for (const row of derefRows()) {
        if (typeof row.isShimmerText !== "function" || !row.isShimmerText()) continue;
        refreshRow(row);
    }
    // No live rows yet (activity started mid-rebuild): the ticker keeps
    // running and the next re-render or tick picks the row up.
}

function refreshRow(row: ShimmerRowLike): void {
    try {
        row.invalidate?.();
        const host = (row as any)[SHIMMER_HOST_KEY];
        if (host) {
            // Clear the host's message render cache so the fresh shimmer frame
            // is not short-circuited by the patched cached render path.
            (host as any)[MESSAGE_RENDER_CACHE_KEY] = undefined;
        }
        requestRowRender();
    } catch { /* noop */ }
}

function requestRowRender(): void {
    let ui: any;
    try {
        ui = renderProvider?.();
    } catch {
        ui = undefined;
    }
    if (!ui) {
        try {
            ui = (globalThis as any)[ACTIVE_UI_KEY];
        } catch {
            ui = undefined;
        }
    }
    try {
        ui?.requestRender?.();
    } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Row render hook
// ---------------------------------------------------------------------------

/**
 * Shimmer parameters for a row right now, or null when the row should render
 * statically: global activity off, the row on a message whose thinking is not
 * streaming, or an unregistered row.
 */
export function shimmerRowInfo(row: unknown): { seed: number } | null {
    if (!targetLive) return null;
    const anyRow = row as ShimmerRowLike | null;
    if (!anyRow || typeof anyRow.isShimmerText !== "function" || !anyRow.isShimmerText()) return null;
    const key = rowKeyByRow.get(row as object);
    if (key === undefined) return null;
    const seed = seedByKey.get(key);
    if (seed === undefined) return null;
    return { seed };
}
