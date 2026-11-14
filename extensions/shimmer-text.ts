/** Shimmer effects used by the working spinner text. */

import { mixRgb, type Rgb } from "./theme-colors.ts";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** One glyph of sweep progress per step. */
const CHAR_SWEEP_MS = 95;
/** Highlight half-width in glyphs — a tight crest, so a clear flash travels the row instead of a broad wash. */
const SWEEP_BLUR = 1.15;
const FLASH_PULSE_MS = 180;
const FLASH_SECOND_START_MS = 340;
const FLASH_SECOND_STRENGTH = 0.55;

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
export type ShimmerStyle = "sweep" | "flash";

function pulseStrength(elapsedMs: number, startMs: number, strength: number): number {
    const progress = (elapsedMs - startMs) / FLASH_PULSE_MS;
    if (progress <= 0 || progress >= 1) return 0;
    return Math.sin(Math.PI * progress) * strength;
}

function doubleFlashStrength(elapsedMs: number): number {
    return Math.max(
        pulseStrength(elapsedMs, 0, 1),
        pulseStrength(elapsedMs, FLASH_SECOND_START_MS, FLASH_SECOND_STRENGTH),
    );
}

/**
 * Renders `body` with either a traveling per-glyph highlight or a double flash.
 *
 * The highlight glides across the glyphs and rests between sweeps, keeping the
 * base text steady instead of pulsing. Flash mode brightens the whole string
 * twice; `elapsedMs` is measured from that flash's start. `intensity` eases
 * either effect back to the base color.
 */
export function renderShimmerText(
    body: string,
    baseAnsi: string,
    seed: number,
    hovered = false,
    nowMs: number = Date.now(),
    options: {
        direction?: ShimmerDirection;
        color?: string;
        intensity?: number;
        style?: ShimmerStyle;
        elapsedMs?: number;
    } = {},
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

    if (options.style === "flash") {
        const amount = Math.max(0, Math.min(1, doubleFlashStrength(options.elapsedMs ?? 0) * intensity + hoverLift));
        const color = mixRgb(base, highlight, amount);
        const ansi = `\x1b[38;2;${Math.round(color.r)};${Math.round(color.g)};${Math.round(color.b)}m`;
        return `${ansi}${body}\x1b[0m`;
    }

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
