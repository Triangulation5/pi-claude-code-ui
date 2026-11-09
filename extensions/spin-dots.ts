/**
 * Animated trailing dots for the spinner working line.
 *
 * The ellipsis spawns one dot at a time (`.` → `..` → `...`), each spawn on a
 * jittered delay. Every so often the tempo drifts — dots come in noticeably
 * slower or faster for a few steps — so the cadence never feels metronomic.
 * At `...` the line holds briefly before cycling back to `.`.
 *
 * Pure logic: timers are injected via a scheduler so callers can reuse their
 * own timer utilities (unref-ed setTimeout in pi, fakes in tests).
 */

export type SpawnScheduler = (delayMs: number, fire: () => void) => () => void;

export interface DotsAnimatorOptions {
    /** Delay in ms between dot spawns, before jitter and tempo are applied. */
    baseDelayMs?: number;
    /** Multiplicative jitter range applied on top of baseDelayMs. */
    minJitter?: number;
    maxJitter?: number;
    /** Chance that any spawn starts a tempo drift (slow-down or speed-up). */
    tempoChance?: number;
    /** How long the peak `...` state holds before cycling back to `.`. */
    holdMinMs?: number;
    holdMaxMs?: number;
}

const DOTS_MAX = 3;

export class DotsAnimator {
    private running = false;
    private count = 0;
    private cancelTimer: (() => void) | null = null;
    private tempo = 1;
    private tempoStepsLeft = 0;
    private readonly scheduleFn: SpawnScheduler;
    private readonly random: () => number;
    private readonly onChange?: () => void;
    private readonly baseDelayMs: number;
    private readonly minJitter: number;
    private readonly maxJitter: number;
    private readonly tempoChance: number;
    private readonly holdMinMs: number;
    private readonly holdMaxMs: number;

    constructor(
        schedule: SpawnScheduler,
        random: () => number = Math.random,
        onChange?: () => void,
        options: DotsAnimatorOptions = {},
    ) {
        this.scheduleFn = schedule;
        this.random = random;
        this.onChange = onChange;
        this.baseDelayMs = Math.max(80, options.baseDelayMs ?? 340);
        this.minJitter = Math.max(0.2, options.minJitter ?? 0.7);
        this.maxJitter = Math.max(this.minJitter, options.maxJitter ?? 1.45);
        this.tempoChance = Math.max(0, Math.min(1, options.tempoChance ?? 0.16));
        this.holdMinMs = Math.max(100, options.holdMinMs ?? 420);
        this.holdMaxMs = Math.max(this.holdMinMs, options.holdMaxMs ?? 950);
    }

    /** Current trailing suffix: "" | "." | ".." | "..." */
    get suffix(): string {
        return ".".repeat(this.count);
    }

    start(): void {
        this.stop();
        this.running = true;
        this.count = 0;
        this.scheduleNext();
    }

    stop(): void {
        this.running = false;
        this.cancelTimer?.();
        this.cancelTimer = null;
        if (this.count !== 0) {
            this.count = 0;
            this.onChange?.();
        }
    }

    /**
     * Delay until the next spawn: base jittered, plus the active tempo drift
     * if one is in progress. Every so often a finished cycle lets a new drift
     * start, so the dots really do slow down and speed up over time.
     */
    private nextDelayMs(): number {
        let delay = this.baseDelayMs * (this.minJitter + this.random() * (this.maxJitter - this.minJitter));
        if (this.tempoStepsLeft <= 0 && this.random() < this.tempoChance) {
            this.tempoStepsLeft = 1 + Math.floor(this.random() * 3);
            this.tempo = this.random() < 0.55
                ? 1.7 + this.random() * 0.9 // drift slower
                : 0.45 + this.random() * 0.25; // drift faster
        }
        if (this.tempoStepsLeft > 0) delay *= this.tempo;
        return delay;
    }

    private scheduleNext(): void {
        if (!this.running || this.cancelTimer) return;
        const delay = this.nextDelayMs();
        this.cancelTimer = this.scheduleFn(delay, () => {
            this.cancelTimer = null;
            this.advance();
        });
    }

    private advance(): void {
        if (!this.running) return;
        if (this.count >= DOTS_MAX) {
            this.scheduleCycleRestart();
            return;
        }
        if (this.tempoStepsLeft > 0) this.tempoStepsLeft--;
        this.count++;
        this.onChange?.();
        this.scheduleNext();
    }

    private scheduleCycleRestart(): void {
        if (!this.running || this.cancelTimer) return;
        const hold = this.holdMinMs + this.random() * (this.holdMaxMs - this.holdMinMs);
        this.cancelTimer = this.scheduleFn(hold, () => {
            this.cancelTimer = null;
            if (!this.running) return;
            this.count = 1;
            this.onChange?.();
            this.scheduleNext();
        });
    }
}
