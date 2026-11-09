/**
 * Typewriter-style verb switching for the spinner working line.
 *
 * The first verb is displayed instantly. Later verbs — picked by a jittered
 * timer every so often — fade out briefly, then type in one character at a
 * time with a staggered delay.
 *
 * Tool activity suppresses switching while a tool description owns the line;
 * timers keep polling so the sequence resumes smoothly once tools finish.
 */

export type SpawnScheduler = (delayMs: number, fire: () => void) => () => void;

export interface TypewriterAnimatorOptions {
    /** Picks the next verb; receives the current one so callers can avoid repeats. */
    pickNext: (current: string) => string;
    /** Jittered quiet period between stable display and the next switch. */
    minStableMs?: number;
    maxStableMs?: number;
    /** Per-character typing delay range. */
    typeMinMs?: number;
    typeMaxMs?: number;
    /** Poll interval while switches wait for tool activity to clear. */
    switchPollMs?: number;
}

export type TypewriterPhase = "stable" | "fading" | "typing";

const FADE_STEP_MS = 50;
const FADE_STEPS = 3;

export class TypewriterAnimator {
    private target = "";
    private shown = "";
    private phase: TypewriterPhase = "stable";
    private fadeStep = 0;
    private cancelTimer: (() => void) | null = null;
    private stopped = true;
    private toolActive = false;
    private readonly pickNext: (current: string) => string;
    private readonly minStableMs: number;
    private readonly maxStableMs: number;
    private readonly typeMinMs: number;
    private readonly typeMaxMs: number;

    private readonly scheduler: SpawnScheduler;
    private readonly random: () => number;
    private readonly onChange?: () => void;
    private readonly onPhaseChange?: (phase: TypewriterPhase) => void;
    private readonly switchPollMs: number;

    constructor(
        scheduler: SpawnScheduler,
        random: () => number = Math.random,
        onChange?: () => void,
        onPhaseChange?: (phase: TypewriterPhase) => void,
        options?: TypewriterAnimatorOptions,
    ) {
        this.scheduler = scheduler;
        this.random = random;
        this.onChange = onChange;
        this.onPhaseChange = onPhaseChange;
        const opts = (options ?? {}) as TypewriterAnimatorOptions;
        // options defaults safe: pickNext is validated up front.
        const pickNext = opts.pickNext;
        const pick = typeof pickNext === "function" ? pickNext : undefined;
        if (typeof pick !== "function") throw new Error("TypewriterAnimator requires pickNext");
        this.pickNext = pick as (current: string) => string;
        this.minStableMs = Math.max(1_000, opts.minStableMs ?? 11_000);
        this.maxStableMs = Math.max(this.minStableMs, opts.maxStableMs ?? 24_000);
        this.typeMinMs = Math.max(5, opts.typeMinMs ?? 44);
        this.typeMaxMs = Math.max(this.typeMinMs, opts.typeMaxMs ?? 160);
        this.switchPollMs = Math.max(100, opts.switchPollMs ?? 600);
    }

    get displayedText(): string {
        return this.shown;
    }

    get isAnimating(): boolean {
        return this.phase !== "stable";
    }

    get fadeAmount(): number {
        return this.phase === "fading" ? this.fadeStep / FADE_STEPS : 0;
    }

    get currentPhase(): TypewriterPhase {
        return this.phase;
    }

    /** Show the first verb immediately; typing only sets in on later switches. */
    start(initialVerb: string): void {
        this.stop();
        this.stopped = false;
        this.target = initialVerb;
        this.shown = initialVerb;
        this.fadeStep = 0;
        this.phase = "stable";
        this.scheduleSwitch();
    }

    stop(): void {
        this.stopped = true;
        this.cancelTimer?.();
        this.cancelTimer = null;
        this.phase = "stable";
        this.target = "";
        this.shown = "";
        this.fadeStep = 0;
        this.toolActive = false;
    }

    /**
     * While a tool description owns the line, switch timers keep polling but
     * never begin a typing sequence, so tool text is never interrupted.
     * Returning to the verb: a switch that was mid-flight fast-forwards to the
     * finished verb, so the post-tool transition is instant like tool rows.
     */
    setToolActive(active: boolean): void {
        if (this.toolActive === active) return;
        this.toolActive = active;
        if (!active && this.phase !== "stable") {
            this.shown = this.target;
            this.fadeStep = 0;
            this.cancelTimer?.();
            this.cancelTimer = null;
            this.setPhase("stable");
            this.onChange?.();
            this.scheduleSwitch();
        }
    }

    private setPhase(phase: TypewriterPhase): void {
        if (this.phase === phase) return;
        this.phase = phase;
        this.onPhaseChange?.(phase);
    }

    /** Replaces any pending timer with a new one. */
    private reschedule(delayMs: number, fire: () => void): void {
        this.cancelTimer?.();
        this.cancelTimer = this.scheduler(delayMs, fire);
    }

    private scheduleSwitch(): void {
        if (this.stopped || this.cancelTimer) return;
        const delay = this.minStableMs + this.random() * (this.maxStableMs - this.minStableMs);
        this.reschedule(delay, () => {
            this.cancelTimer = null;
            if (this.stopped || this.phase !== "stable") return;
            if (this.toolActive) {
                this.scheduleSwitchPoll();
                return;
            }
            this.beginSwitch();
        });
    }

    private scheduleSwitchPoll(): void {
        if (this.stopped || this.cancelTimer) return;
        this.reschedule(this.switchPollMs, () => {
            this.cancelTimer = null;
            if (this.stopped || this.phase !== "stable") return;
            if (this.toolActive) {
                this.scheduleSwitchPoll();
                return;
            }
            this.beginSwitch();
        });
    }

    private beginSwitch(): void {
        if (this.stopped) return;
        this.target = this.pickNext(this.target);
        if (this.shown) {
            this.fadeStep = 1;
            this.setPhase("fading");
            this.onChange?.();
            this.scheduleFadeStep();
            return;
        }
        this.beginTyping();
    }

    private scheduleFadeStep(): void {
        if (this.stopped || this.phase !== "fading" || this.cancelTimer) return;
        this.reschedule(FADE_STEP_MS, () => {
            this.cancelTimer = null;
            if (this.stopped || this.phase !== "fading") return;
            if (this.fadeStep >= FADE_STEPS) {
                this.beginTyping();
                return;
            }
            this.fadeStep++;
            this.onChange?.();
            this.scheduleFadeStep();
        });
    }

    private beginTyping(): void {
        this.shown = "";
        this.fadeStep = 0;
        this.setPhase("typing");
        this.onChange?.();
        this.scheduleTypeStep();
    }

    private scheduleTypeStep(): void {
        const shownCharacters = Array.from(this.shown);
        const targetCharacters = Array.from(this.target);
        if (this.stopped || this.cancelTimer || shownCharacters.length >= targetCharacters.length) {
            if (shownCharacters.length >= targetCharacters.length) {
                this.setPhase("stable");
                this.scheduleSwitch();
            }
            return;
        }
        const delay = this.typeMinMs + this.random() * (this.typeMaxMs - this.typeMinMs);
        this.reschedule(delay, () => {
            this.cancelTimer = null;
            if (this.stopped || this.phase !== "typing") return;
            this.shown = targetCharacters.slice(0, shownCharacters.length + 1).join("");
            this.onChange?.();
            if (Array.from(this.shown).length >= targetCharacters.length) {
                this.setPhase("stable");
                this.scheduleSwitch();
                return;
            }
            this.scheduleTypeStep();
        });
    }
}
