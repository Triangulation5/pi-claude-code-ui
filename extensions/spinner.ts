import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

import { getUserSettingsPath } from "./settings-path";
import { renderShimmerText } from "./shimmer-text";
import { createSpinnerTextAnimator, type SpinnerTextAnimator } from "./spinner-animation";
import type { SpawnScheduler } from "./spin-dots";

// ---------------------------------------------------------------------------
// Patch built-in Loader with Claude/OpenBrawd-style glyphs.
// Keep animation cadence constant so the spinner doesn't appear to slow down
// or freeze as the session grows.
// ---------------------------------------------------------------------------

const RAW_ANSI_RE = /\x1b\[[0-9;]*m/;
const RESET = "\x1b[0m";

// Defaults match the previous hardcoded values so behavior is identical
// when no theme is available or themeAdaptive=false. `applyThemeColors`
// below re-derives them from the active pi theme each tick.
let CLAUDE_ORANGE = "\x1b[38;2;215;119;87m";
let STATUS_DIM = "\x1b[38;2;153;153;153m";

// Short TTL so /cc-spinner changes are picked up within ~1s without
// re-reading the file on every spinner tick (~170ms).
type SpinnerSpeed = "slow" | "medium" | "fast";
type SpinnerStyle = "asterisk" | "breathing";
type ShimmerDirection = "left-to-right" | "right-to-left";

let _spinnerSettingsCache: {
    value: {
        adaptive: boolean;
        verbColor: string;
        statusColor: string;
        animatedDots: boolean;
        speed: SpinnerSpeed;
        style: SpinnerStyle;
        shimmerDirection: ShimmerDirection;
        shimmerColor?: string;
    };
    expires: number;
} | null = null;
const SPINNER_SETTINGS_TTL_MS = 1_000;
// Cross-extension bust signal: /cc-spinner in index.ts bumps this counter
// and we drop the cache when it changes.
const SPINNER_BUST_KEY = Symbol.for("pi-claude-style-tools:spinner-settings-bust");
let _spinnerLastBust = 0;

function readSpinnerSettings(): {
    adaptive: boolean;
    verbColor: string;
    statusColor: string;
    animatedDots: boolean;
    speed: SpinnerSpeed;
    style: SpinnerStyle;
    shimmerDirection: ShimmerDirection;
    shimmerColor?: string;
} {
    const now = Date.now();
    const bust = ((globalThis as any)[SPINNER_BUST_KEY] as number | undefined) ?? 0;
    if (bust !== _spinnerLastBust) {
        _spinnerLastBust = bust;
        _spinnerSettingsCache = null;
    }
    if (_spinnerSettingsCache && _spinnerSettingsCache.expires > now) {
        return _spinnerSettingsCache.value;
    }
    let adaptive = true;
    let animatedDots = false;
    let speed: SpinnerSpeed = "medium";
    let style: SpinnerStyle = "asterisk";
    let shimmerDirection: ShimmerDirection = "left-to-right";
    let shimmerColor: string | undefined;
    // Spinner glyph is still pi's accent. Use borderAccent for the verb so it
    // feels themed and lively without collapsing into the exact same Claude
    // orange as the glyph on themes like openAntigravity-dark.
    let verbColor = "borderAccent";
    let statusColor = "muted";
    const paths = [`${process.cwd()}/.pi/settings.json`, getUserSettingsPath()];
    for (const p of paths) {
        try {
            if (!p || !existsSync(p)) continue;
            const raw = JSON.parse(readFileSync(p, "utf8"));
            if (raw && typeof raw === "object") {
                if (raw.themeAdaptive === false) adaptive = false;
                if (typeof raw.spinnerVerbColor === "string" && raw.spinnerVerbColor.length > 0) verbColor = raw.spinnerVerbColor;
                if (typeof raw.spinnerStatusColor === "string" && raw.spinnerStatusColor.length > 0) statusColor = raw.spinnerStatusColor;
                if (typeof raw.spinnerAnimatedDots === "boolean") animatedDots = raw.spinnerAnimatedDots;
                if (raw.spinnerSpeed === "slow" || raw.spinnerSpeed === "medium" || raw.spinnerSpeed === "fast") speed = raw.spinnerSpeed;
                if (raw.spinnerStyle === "asterisk" || raw.spinnerStyle === "breathing") style = raw.spinnerStyle;
                if (raw.spinnerShimmerDirection === "left-to-right" || raw.spinnerShimmerDirection === "right-to-left") {
                    shimmerDirection = raw.spinnerShimmerDirection;
                }
                if (typeof raw.spinnerShimmerColor === "string") shimmerColor = raw.spinnerShimmerColor;
            }
        } catch { /* ignore */ }
    }
    const value = { adaptive, verbColor, statusColor, animatedDots, speed, style, shimmerDirection, shimmerColor };
    _spinnerSettingsCache = { value, expires: now + SPINNER_SETTINGS_TTL_MS };
    return value;
}

function themeAdaptiveEnabled(): boolean {
    return readSpinnerSettings().adaptive;
}

// Original Claude-style values restored when the user turns adaptive off.
const _DEFAULT_CLAUDE_ORANGE = "\x1b[38;2;215;119;87m";
const _DEFAULT_STATUS_DIM = "\x1b[38;2;153;153;153m";

let _themeColorsLastAdaptive: boolean | null = null;
let _themeColorsLastVerbKey: string | null = null;
let _themeColorsLastStatusKey: string | null = null;

function resolveThemeColor(theme: any, key: string, fallbackKey: string): string | null {
    if (!theme || typeof theme.getFgAnsi !== "function") return null;
    try {
        const v = theme.getFgAnsi(key);
        if (typeof v === "string" && v.length > 0) return v;
    } catch { /* ignore */ }
    if (fallbackKey !== key) {
        try {
            const v = theme.getFgAnsi(fallbackKey);
            if (typeof v === "string" && v.length > 0) return v;
        } catch { /* ignore */ }
    }
    return null;
}

function applyThemeColors(theme: any): void {
    const { adaptive, verbColor, statusColor } = readSpinnerSettings();

    // Respond to runtime toggles (themeAdaptive or spinner color key changes)
    // without restarting pi.
    const settingsChanged = _themeColorsLastAdaptive !== adaptive
        || _themeColorsLastVerbKey !== verbColor
        || _themeColorsLastStatusKey !== statusColor;
    if (settingsChanged) {
        _themeColorsLastAdaptive = adaptive;
        _themeColorsLastVerbKey = verbColor;
        _themeColorsLastStatusKey = statusColor;
        if (!adaptive) {
            CLAUDE_ORANGE = _DEFAULT_CLAUDE_ORANGE;
            STATUS_DIM = _DEFAULT_STATUS_DIM;
        }
    }

    if (!theme || !adaptive) return;
    // ctx.ui.theme is Pi's global theme Proxy: the same object before and after
    // /theme or a light/dark switch, so an identity cache never refreshed the
    // spinner colors. Resolving is two map lookups per tick; just do it.
    const verb = resolveThemeColor(theme, verbColor, "accent");
    if (verb) CLAUDE_ORANGE = verb;
    const status = resolveThemeColor(theme, statusColor, "muted");
    if (status) STATUS_DIM = status;
}

// Match OpenBrawd's spinner glyph set, with the final Ghostty frame restored
// to ✽ because the user's font-codepoint-map now centers it correctly.
function getDefaultSpinnerCharacters(): string[] {
    if (process.env.TERM === "xterm-ghostty") {
        return ["·", "✢", "✳", "✶", "✻", "✽"];
    }
    return process.platform === "darwin"
        ? ["·", "✢", "✳", "✶", "✻", "✽"]
        : ["·", "✢", "*", "✶", "✻", "✽"];
}

const SPINNER_CHARS = getDefaultSpinnerCharacters();
const BREATHING_FRAMES = [...SPINNER_CHARS, ...[...SPINNER_CHARS].reverse()];
// Pulse a centered asterisk in place; breathing mode keeps its separate frame set.
const ASTERISK_FRAMES = ["*", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
// Medium preserves the existing cadence; slow and fast are selectable at runtime.
const LOADER_INTERVALS_MS: Record<SpinnerSpeed, number> = { slow: 260, medium: 170, fast: 110 };
const LOADER_LAST_TEXT = Symbol.for("pi-claude-style-tools:loader-last-text");
const LOADER_ACTIVE = Symbol.for("pi-claude-style-tools:loader-active");
const LOADER_GENERATION = Symbol.for("pi-claude-style-tools:loader-generation");
const ACTIVE_UI_SYMBOL = Symbol.for("pi-claude-style-tools:active-ui");

function getLoaderIntervalMs(_loader: any): number {
    return LOADER_INTERVALS_MS[readSpinnerSettings().speed];
}

function getLoaderFrames(): string[] {
    return readSpinnerSettings().style === "breathing" ? BREATHING_FRAMES : ASTERISK_FRAMES;
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null | undefined): void {
    (timer as any)?.unref?.();
}

/** Scheduler for the working-line text animations (dot spawns, typewriter). */
const scheduleAnimation: SpawnScheduler = (delayMs: number, fire: () => void) => {
    const timer = setTimeout(fire, delayMs);
    unrefTimer(timer);
    return () => {
        clearTimeout(timer);
    };
};

function stopLoaderIfUiStopped(loader: any): boolean {
    if (!loader?.ui || !(loader.ui as any).stopped) return false;
    loader.stop?.();
    return true;
}

(Loader.prototype as any).updateDisplay = function patchedUpdateDisplay() {
    if (stopLoaderIfUiStopped(this)) return;
    const frames = getLoaderFrames();
    const frame = frames[this.currentFrame % frames.length];
    const message = typeof this.message === "string" && RAW_ANSI_RE.test(this.message)
        ? this.message
        : this.messageColorFn(this.message);
    const nextText = `${this.spinnerColorFn(frame)} ${message}`;
    if ((this as any)[LOADER_LAST_TEXT] === nextText) return;
    (this as any)[LOADER_LAST_TEXT] = nextText;
    this.setText(nextText);
    if (this.ui && !(this.ui as any).stopped) {
        (globalThis as any)[ACTIVE_UI_SYMBOL] = this.ui;
        this.ui.requestRender();
    }
};

Loader.prototype.start = function patchedStart() {
    this.stop();
    (this as any)[LOADER_ACTIVE] = true;
    const generation = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
    (this as any)[LOADER_GENERATION] = generation;
    delete (this as any)[LOADER_LAST_TEXT];
    (this as any).updateDisplay();
    if (getLoaderFrames().length <= 1 || stopLoaderIfUiStopped(this)) return;
    const scheduleNext = () => {
        if ((this as any)[LOADER_ACTIVE] !== true || (this as any)[LOADER_GENERATION] !== generation || stopLoaderIfUiStopped(this)) return;
        const intervalMs = getLoaderIntervalMs(this);
        const timer = setTimeout(() => {
            (this as any).intervalId = null;
            if ((this as any)[LOADER_ACTIVE] !== true || (this as any)[LOADER_GENERATION] !== generation || stopLoaderIfUiStopped(this)) return;
            const frames = getLoaderFrames();
            (this as any).currentFrame = ((this as any).currentFrame + 1) % frames.length;
            (this as any).updateDisplay();
            scheduleNext();
        }, intervalMs);
        unrefTimer(timer);
        (this as any).intervalId = timer;
    };
    scheduleNext();
};

Loader.prototype.stop = function patchedStop() {
    (this as any)[LOADER_ACTIVE] = false;
    (this as any)[LOADER_GENERATION] = ((this as any)[LOADER_GENERATION] ?? 0) + 1;
    if ((this as any).intervalId) {
        clearTimeout((this as any).intervalId);
        (this as any).intervalId = null;
    }
};

// ---------------------------------------------------------------------------
// Spinner verbs — fun/whimsical loading messages (different set from OpenBrawd)
// ---------------------------------------------------------------------------

const SPINNER_VERBS = [
    "Accomplishing",
    "Actioning",
    "Actualizing",
    "Aligning",
    "Alchemizing",
    "Analyzing",
    "Animating",
    "Assembling",
    "Astral-projecting",
    "Architecting",
    "Baking",
    "Balancing",
    "Bamboozling",
    "Beaming",
    "Beboppin'",
    "Befuddling",
    "Bespangling",
    "Billowing",
    "Blanching",
    "Bloviating",
    "Blueprinting",
    "Boogieing",
    "Boondoggling",
    "Booping",
    "Bootstrapping",
    "Brainstorming",
    "Brewing",
    "Buffering",
    "Bumbling",
    "Bunning",
    "Burrowing",
    "Busying",
    "Calculating",
    "Calibrating",
    "Canoodling",
    "Caramelizing",
    "Cascading",
    "Catapulting",
    "Catalyzing",
    "Cerebrating",
    "Channeling",
    "Choreographing",
    "Churning",
    "Clattering",
    "Coalescing",
    "Cogitating",
    "Combobulating",
    "Composing",
    "Compiling",
    "Computing",
    "Concocting",
    "Conjuring",
    "Considering",
    "Contemplating",
    "Cooking",
    "Coordinating",
    "Crafting",
    "Creating",
    "Crunching",
    "Crystallizing",
    "Cultivating",
    "Dabbling",
    "Daydreaming",
    "Debugging",
    "Deciphering",
    "Deconstructing",
    "Deliberating",
    "Deducing",
    "Determining",
    "Diagnosing",
    "Dilly-dallying",
    "Discombobulating",
    "Distilling",
    "Doodling",
    "Drizzling",
    "Ebbing",
    "Effecting",
    "Elucidating",
    "Embellishing",
    "Enchanting",
    "Engineering",
    "Envisioning",
    "Evaporating",
    "Experimenting",
    "Exploring",
    "Extrapolating",
    "Fabricating",
    "Fathoming",
    "Fermenting",
    "Fiddle-faddling",
    "Finagling",
    "Flambéing",
    "Flibbertigibbeting",
    "Flowing",
    "Flummoxing",
    "Fluttering",
    "Focusing",
    "Forging",
    "Forming",
    "Frolicking",
    "Frosting",
    "Futzing",
    "Gallivanting",
    "Galloping",
    "Garnishing",
    "Gathering",
    "Generating",
    "Gesticulating",
    "Germinating",
    "Glitching",
    "Grappling",
    "Grooving",
    "Gusting",
    "Harmonizing",
    "Hashing",
    "Hatching",
    "Herding",
    "Honing",
    "Hustling",
    "Hullaballooing",
    "Hyperspacing",
    "Ideating",
    "Imagining",
    "Improvising",
    "Incubating",
    "Inferring",
    "Infusing",
    "Innovating",
    "Inspecting",
    "Ionizing",
    "Iterating",
    "Jamming",
    "Jitterbugging",
    "Juggling",
    "Julienning",
    "Knitting",
    "Kneading",
    "Leavening",
    "Levitating",
    "Lollygagging",
    "Manifesting",
    "Mapping",
    "Marinating",
    "Meandering",
    "Meditating",
    "Metamorphosing",
    "Misting",
    "Mashing",
    "Moonwalking",
    "Moseying",
    "Mulling",
    "Mustering",
    "Musing",
    "Nebulizing",
    "Nesting",
    "Noodling",
    "Nucleating",
    "Optimizing",
    "Orbiting",
    "Orchestrating",
    "Osmosing",
    "Outlining",
    "Overthinking",
    "Perambulating",
    "Percolating",
    "Perusing",
    "Philosophising",
    "Photosynthesizing",
    "Plotting",
    "Pollinating",
    "Pondering",
    "Pontificating",
    "Pouncing",
    "Precipitating",
    "Prestidigitating",
    "Probing",
    "Processing",
    "Proofing",
    "Propagating",
    "Prototyping",
    "Puttering",
    "Puzzling",
    "Quantumizing",
    "Querying",
    "Razzle-dazzling",
    "Razzmatazzing",
    "Rebooting",
    "Recombobulating",
    "Refactoring",
    "Refining",
    "Reticulating",
    "Riffing",
    "Roosting",
    "Ruminating",
    "Sautéing",
    "Scampering",
    "Scheming",
    "Schlepping",
    "Scurrying",
    "Seasoning",
    "Shenaniganing",
    "Shimmying",
    "Simmering",
    "Skedaddling",
    "Sketching",
    "Sleuthing",
    "Slithering",
    "Smooshing",
    "Sock-hopping",
    "Spelunking",
    "Spinning",
    "Sprouting",
    "Stacking",
    "Stewing",
    "Sublimating",
    "Summoning",
    "Swirling",
    "Swooping",
    "Symbioting",
    "Syncing",
    "Synthesizing",
    "Tempering",
    "Thinking",
    "Thundering",
    "Tinkering",
    "Tomfoolering",
    "Topsy-turvying",
    "Transfiguring",
    "Transmuting",
    "Troubleshooting",
    "Tuning",
    "Twisting",
    "Undulating",
    "Unfurling",
    "Unpacking",
    "Unravelling",
    "Untangling",
    "Vibing",
    "Waddling",
    "Wandering",
    "Warping",
    "Weaving",
    "Whatchamacalliting",
    "Whirlpooling",
    "Whirring",
    "Whisking",
    "Wibbling",
    "Wondering",
    "Working",
    "Wrangling",
    "Yammering",
    "Zapping",
    "Zesting",
    "Zigzagging",
    "Zooming",

    // Long
    "Consulting the void",
    "Asking the electrons",
    "Bribing the compiler",
    "Negotiating with entropy",
    "Whispering to the bits",
    "Tickling the stack",
    "Massaging the heap",
    "Appeasing the garbage collector",
    "Summoning semicolons",
    "Herding pointers",
    "Untangling spaghetti",
    "Polishing the algorithms",
    "Waxing philosophical",
    "Consulting ancient scrolls",
    "Reading tea leaves",
    "Shaking the magic 8-ball",
    "Sacrificing to the demo gods",
    "Warming up the hamsters",
    "Spinning up the squirrels",
    "Caffeinating",
    "Existentially questioning",
    "Having a little think",
    "Stroking chin thoughtfully",
    "Squinting at the problem",
    "Staring into the abyss",
    "Abyss staring back",
    "Achieving enlightenment",
    "Transcending mere computation",
    "Ascending to a higher plane",
    "Communing with the machine spirit",
    "Performing arcane rituals",
    "Invoking elder functions",
    "Consulting the oracle",
    "Divining the answer",
    "Scrying the codebase",
    "Dowsing for bugs",
    "Rearranging deck chairs",
    "Shuffling bits around",
    "Aligning the chakras",
    "Reticulating splines",
    "Reversing the polarity",
    "Calibrating the flux capacitor",
    "Charging the crystals",
    "Tuning the vibrations",
    "Adjusting the cosmic frequency",
    "Waiting for a sign",
    "Hoping for the best",
    "Manifesting solutions",
    "Willing it into existence",
    "Believing really hard",
    "Politely asking the CPU",
    "Bribing the runtime",
    "Flirting with the database",
    "Sweet-talking the API",
    "Negotiating with deadlines",
    "Having words with the cache",
    "Reasoning with the memory",
    "Pleading with the logs",
    "Bargaining with fate",
    "Making offerings to the CI",
    "Praying to the uptime gods",
    "Consulting the rubber duck",
    "Interrogating the stack trace",
    "Cross-examining the debugger",
    "Petitioning the kernel",
    "Lobbying the scheduler",
    "Schmoozing the network",
    "Buttering up the firewall",
    "Wining and dining the servers",
    "Taking the bytes out for lunch",
    "Giving the code a pep talk",
    "Reading the room",
    "Checking under the hood",
    "Kicking the tires",
    "Shaking loose the cobwebs",
    "Dusting off the neurons",
    "Greasing the gears",
    "Oiling the cogs",
    "Winding up the clockwork",
    "Stoking the furnace",
    "Feeding the machine",
    "Watering the logic tree",
    "Pruning the decision branches",
    "Harvesting the outputs",
    "Planting computational seeds",
    "Nurturing the algorithm",
    "Raising the exceptions",
    "Taming wild pointers",
    "Herding cats in memory",
    "Teaching old code new tricks",
    "Whispering sweet nothings to the compiler",
    "Serenading the syntax",
    "Dancing with dependencies",
    "Waltzing through the codebase",
    "Tangoing with type errors",
    "Doing the deployment dance",
    "Having a moment of clarity",
    "Experiencing a flash of insight",
    "Channeling the ancient developers",
    "Receiving transmissions from the cloud",
    "Asking the hamsters to run faster",
    "Convincing the pixels to cooperate",
    "Teaching electrons new tricks",
    "Bribing the byte fairies",
    "Whispering passwords to the void",
    "Negotiating with cosmic rays",
    "Flattering the floating points",
    "Seducing the semicolons",
    "Wooing the while loops",
    "Charming the curly braces",
    "Hypnotizing the hash tables",
    "Mesmerizing the memory banks",
    "Enchanting the error handlers",
    "Bewitching the boolean logic",
    "Spellbinding the stack frames",
    "Hexing the hexadecimals",
    "Jinxing the JSON parsers",
    "Cursing the cache misses",
    "Blessing the build process",
    "Anointing the algorithms",
    "Consecrating the callbacks",
    "Sanctifying the source code",
    "Exorcising the exceptions",
    "Purifying the parameters",
    "Cleansing the closures",
    "Baptizing the binary",
    "Absolving the abstractions",
    "Redeeming the recursion",
    "Forgiving the for loops",
    "Pardoning the pointers",
    "Liberating the lambdas",
    "Emancipating the enums",
    "Freeing the functions",
    "Releasing the references",
    "Unbinding the variables",
    "Untying the type knots",
    "Unraveling the regex",
    "Decoding the mysteries",
    "Cracking the conundrums",
    "Solving the riddles of RAM",
    "Unlocking the secrets of silicon",
    "Discovering hidden semicolons",
    "Unearthing buried bugs",
    "Excavating ancient APIs",
    "Archeologically analyzing the architecture",
    "Fossil hunting in the functions",
    "Spelunking through the stack",
    "Scuba diving in the data",
    "Snorkeling through the streams",
    "Parasailing past the parameters",
    "Hang gliding through the heap",
    "Bungee jumping into the backend",
    "Skydiving through the source",
    "Surfing the syntax waves",
    "Skateboarding down the stack trace",
    "Snowboarding through the schemas",
    "Mountain climbing the modules",
    "Hiking through the headers",
    "Trekking through the trees",
    "Backpacking through the binaries",
    "Camping in the codebase",
    "Glamping in the globals",
    "Picnicking with the processes",
    "Barbecuing the bugs",
    "Roasting the race conditions",
    "Grilling the glitches",
    "Sautéing the syntax errors",
    "Flambéing the failures",
    "Caramelizing the callbacks",
    "Braising the breakpoints",
    "Poaching the pointers",
    "Blanching the branches",
    "Searing the segments",
    "Smoking the subroutines",
    "Curing the code smells",
    "Pickling the packages",
    "Preserving the protocols",
    "Canning the constants",
    "Bottling the buffers",
    "Jarring the JavaScript",
    "Decanting the data structures",
    "Aerating the arrays",
    "Letting the logic breathe",
    "Aging the algorithms gracefully",
    "Maturing the methods",
    "Ripening the results",
    "Seasoning the solutions",
    "Spicing up the specs",
    "Garnishing the getters",
    "Plating the output nicely",
    "Presenting with pizzazz",
    "Adding a dash of elegance",
    "Sprinkling some magic dust",
    "Drizzling debug sauce",
    "Folding in the features",
    "Whisking the widgets",
    "Kneading the namespaces",
    "Rolling out the runtime",
    "Proofing the promises",
    "Letting the dough rise",
    "Baking at 350 kilobytes",
    "Frosting the functions",
    "Decorating the deployment",
    "Icing the interfaces",
    "Glazing the graphics",
    "Topping with tests",
    "Cherry-picking the commits",
];

// ---------------------------------------------------------------------------
// Spinner glyph characters are now patched into the Loader above.
// No separate glyph prefix needed.
// ---------------------------------------------------------------------------

function pickVerb(exclude?: string): string {
    if (exclude) {
        for (let tries = 0; tries < 8; tries++) {
            const verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
            if (verb !== exclude) return verb;
        }
    }
    return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

/** Format elapsed ms as compact duration: 5s, 1m 23s, 1h 2m 3s */
// What a running tool is doing, for the working line ("Running npm test...",
// "Reading stats.py..."). Random verbs stay for the time the model is thinking.
// No ellipsis of its own: the working line already ends in "...".
function clip(text: string, max: number): string {
    const oneLine = text.split("\n")[0]?.trim() ?? "";
    return oneLine.length > max ? oneLine.slice(0, max).trimEnd() : oneLine;
}

function humanizeToolName(name: string): string {
    const direct = /^mcp__.+?__(.+)$/.exec(name);
    return (direct ? direct[1] : name)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function describeToolActivity(name: string, args: any): string {
    const str = (...keys: string[]): string => {
        for (const key of keys) {
            const value = args?.[key];
            if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
    };
    const file = basename(str("path", "file_path"));
    switch (name) {
        case "bash": {
            const command = clip(str("command"), 50);
            return command ? `Running ${command}` : "Running a shell command";
        }
        case "read":
            return file ? `Reading ${file}` : "Reading a file";
        case "edit":
            return file ? `Editing ${file}` : "Editing a file";
        case "write":
            return file ? `Writing ${file}` : "Writing a file";
        case "grep":
        case "find": {
            const pattern = clip(str("pattern"), 40);
            return pattern ? `Searching for ${pattern}` : "Searching";
        }
        case "ls":
            return `Listing ${str("path") || "."}`;
        case "Agent": {
            const description = clip(str("description"), 50);
            return description ? `Waiting for agent: ${description}` : "Waiting for an agent";
        }
        case "ask_user_question":
        case "questionnaire":
        case "question":
            return "Waiting for your answer";
        default:
            return `Running ${humanizeToolName(name)}`;
    }
}

function formatDuration(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function formatCount(value: number): string {
    return new Intl.NumberFormat("en-US").format(value);
}

/** Characters the model produced in one content block: text, thinking, or tool-call arguments. */
function contentBlockLength(block: any): number {
    if (block?.type === "text" && typeof block.text === "string") return block.text.length;
    if (block?.type === "thinking" && typeof block.thinking === "string") return block.thinking.length;
    if (block?.type === "toolCall") {
        try {
            return JSON.stringify(block.arguments ?? {}).length;
        } catch {
            return 0;
        }
    }
    return 0;
}

/** Output tokens of a finished assistant message: the provider's count, or an estimate (chars / 4). */
function messageOutputTokens(message: any): number {
    const reported = message?.usage?.output;
    if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) return reported;
    if (!Array.isArray(message?.content)) return 0;
    return Math.round(message.content.reduce((sum: number, block: any) => sum + contentBlockLength(block), 0) / 4);
}

function statusText(text: string): string {
    return `${STATUS_DIM}${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// Herdr lifecycle reporting
//
// Stock herdr pi screen detection only matches the literal "Working...".
// This extension replaces that text with themed spinner verbs (Cooking...,
// Syncing..., ...), so herdr sidebars go idle/stale while pi is actually busy.
// When running inside herdr (HERDR_ENV=1), report working/idle over the
// socket only when herdr's official pi integration is not installed. The
// official integration owns the same lifecycle authority and must remain the
// sole reporter when present. UI is unchanged.
// ---------------------------------------------------------------------------

type HerdrAgentState = "working" | "idle";

const HERDR_ENV = process.env.HERDR_ENV;
const HERDR_SOCKET_PATH = process.env.HERDR_SOCKET_PATH;
const HERDR_SOCKET_ENDPOINT =
    process.platform === "win32" && HERDR_SOCKET_PATH
        ? `\\\\.\\pipe\\${HERDR_SOCKET_PATH}`
        : HERDR_SOCKET_PATH;
const HERDR_PANE_ID = process.env.HERDR_PANE_ID;
// Must be exactly "herdr:pi" — herdr only grants full lifecycle authority
// (skip screen-manifest fallback) to that official source pair with agent "pi".
const HERDR_SOURCE = "herdr:pi";
const HERDR_INTEGRATION_MARKER = "HERDR_INTEGRATION_ID=pi";
let officialHerdrIntegrationInstalled: boolean | undefined;

function hasOfficialHerdrIntegration(): boolean {
    if (officialHerdrIntegrationInstalled !== undefined) {
        return officialHerdrIntegrationInstalled;
    }

    const agentDir = process.env.PI_CODING_AGENT_DIR
        || join(homedir(), ".pi", "agent");

    try {
        const integrationPath = join(agentDir, "extensions", "herdr-agent-state.ts");
        officialHerdrIntegrationInstalled =
            existsSync(integrationPath)
            && readFileSync(integrationPath, "utf8").includes(HERDR_INTEGRATION_MARKER);
    } catch {
        officialHerdrIntegrationInstalled = false;
    }
    return officialHerdrIntegrationInstalled;
}

function herdrEnabled(): boolean {
    return HERDR_ENV === "1"
        && !!HERDR_SOCKET_PATH
        && !!HERDR_PANE_ID
        && !hasOfficialHerdrIntegration();
}

function herdrSendAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
    if (!herdrEnabled()) return Promise.resolve(true);

    return new Promise((resolve) => {
        let done = false;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finish = (delivered: boolean) => {
            if (done) return;
            done = true;
            if (timeout) clearTimeout(timeout);
            socket.destroy();
            resolve(delivered);
        };

        const socket = net.createConnection(HERDR_SOCKET_ENDPOINT!);
        socket.on("error", () => finish(false));
        socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", () => finish(true));
        socket.on("end", () => finish(false));
        timeout = setTimeout(() => finish(false), timeoutMs);
        unrefTimer(timeout);
    });
}

async function herdrSend(request: unknown): Promise<void> {
    if (await herdrSendAttempt(request, 500)) return;
    await herdrSendAttempt(request, 1500);
}

let herdrReportSeq = Date.now() * 1000;
let herdrSessionId: string | undefined;
let herdrSessionPath: string | undefined;
let herdrSendInFlight = false;
let herdrQueued: { state: HerdrAgentState; seq: number } | undefined;
let herdrLastState: HerdrAgentState | undefined;

function herdrNextSeq(): number {
    herdrReportSeq += 1;
    return herdrReportSeq;
}

function herdrUpdateSessionRef(ctx: any): void {
    try {
        const file = ctx?.sessionManager?.getSessionFile?.();
        herdrSessionPath =
            typeof file === "string" && file.startsWith("/") ? file : undefined;
    } catch {
        herdrSessionPath = undefined;
    }

    try {
        const id = ctx?.sessionManager?.getSessionId?.();
        herdrSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
    } catch {
        herdrSessionId = undefined;
    }
}

function herdrWithSessionRef(params: Record<string, unknown>): Record<string, unknown> {
    if (herdrSessionPath) return { ...params, agent_session_path: herdrSessionPath };
    if (herdrSessionId) return { ...params, agent_session_id: herdrSessionId };
    return params;
}

function herdrCurrentSessionRef(): Record<string, unknown> | undefined {
    if (herdrSessionPath) return { agent_session_path: herdrSessionPath };
    if (herdrSessionId) return { agent_session_id: herdrSessionId };
    return undefined;
}

function herdrReportSession(sessionStartSource?: string): Promise<void> {
    const sessionRef = herdrCurrentSessionRef();
    if (!sessionRef) return Promise.resolve();

    return herdrSend({
        id: `${HERDR_SOURCE}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "pane.report_agent_session",
        params: {
            pane_id: HERDR_PANE_ID,
            source: HERDR_SOURCE,
            agent: "pi",
            seq: herdrNextSeq(),
            session_start_source: sessionStartSource,
            ...sessionRef,
        },
    });
}

function herdrSendState(state: HerdrAgentState, seq = herdrNextSeq()): Promise<void> {
    return herdrSend({
        id: `${HERDR_SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        method: "pane.report_agent",
        params: herdrWithSessionRef({
            pane_id: HERDR_PANE_ID,
            source: HERDR_SOURCE,
            agent: "pi",
            state,
            seq,
        }),
    });
}

function herdrQueueState(state: HerdrAgentState): void {
    herdrQueued = { state, seq: herdrNextSeq() };
    if (!herdrSendInFlight) void herdrDrainQueue();
}

async function herdrDrainQueue(): Promise<void> {
    if (herdrSendInFlight) return;
    herdrSendInFlight = true;
    try {
        while (herdrQueued) {
            const next = herdrQueued;
            herdrQueued = undefined;
            await herdrSendState(next.state, next.seq);
        }
    } finally {
        herdrSendInFlight = false;
        if (herdrQueued) void herdrDrainQueue();
    }
}

function herdrPublishState(state: HerdrAgentState, force = false): void {
    if (!herdrEnabled()) return;
    if (!force && state === herdrLastState) return;
    herdrLastState = state;
    herdrQueueState(state);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Threshold before showing elapsed time in status parentheses */
const SHOW_TIMER_AFTER_MS = 30_000;

/** How long to preserve "thought for Ns" across turns */
const THOUGHT_DISPLAY_MS = 3_500;

/** Minimum thinking duration before showing "thought for Ns" */
const MIN_THINKING_SHOW_MS = 100;

/** Message refresh cadence. Keep constant so status updates don't stall on long sessions. */
const WORKING_MESSAGE_INTERVAL_MS = 1_000;

/**
 * The "↓ N tokens" counter counts up to each new total instead of jumping there. Tokens arrive
 * in chunks (and a finished message swaps its estimate for the provider's real count), so the
 * shown number eases toward the real one: each frame closes the same share of the gap, about
 * 63% every TOKEN_EASE_MS, and at least one token, so a large jump takes about a second and a
 * steady stream is followed within a few tokens. Frames only run while the numbers differ.
 */
const TOKEN_FRAME_MS = 50;
const TOKEN_EASE_MS = 150;

/** The counter's next value: `shown` moved toward `target` after `elapsedMs`, never past it. */
export function easeTokenCount(shown: number, target: number, elapsedMs: number): number {
    const gap = target - shown;
    if (gap === 0) return target;
    const eased = Math.abs(gap) * (1 - Math.exp(-Math.max(0, elapsedMs) / TOKEN_EASE_MS));
    const step = Math.max(1, Math.round(eased));
    return step >= Math.abs(gap) ? target : shown + Math.sign(gap) * step;
}

/** Completion message linger */
const TURN_COMPLETION_MS = 2_500;
const SPINNER_SHIMMER_MIN_INTERVAL_MS = 22_000;
const SPINNER_SHIMMER_MAX_INTERVAL_MS = 38_000;
const SPINNER_SHIMMER_DURATION_MS = 4_200;
const SPINNER_SHIMMER_FADE_MS = 750;
const SPINNER_SHIMMER_FRAME_MS = 60;


export default function (pi: ExtensionAPI) {
    let agentStartTime = 0;
    let turnStartTime = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    // What the working line shows; eases toward outputTokenCount() (see easeTokenCount).
    let shownTokens = 0;
    let tokenFrameTimer: ReturnType<typeof setTimeout> | null = null;
    let completionTimer: ReturnType<typeof setTimeout> | null = null;
    let thoughtStatusTimer: ReturnType<typeof setTimeout> | null = null;
    let currentVerb = "";
    // Working-line text animation: typewriter verb switching + optional dots.
    let textAnimator: SpinnerTextAnimator | null = null;
    let spinnerShimmerUntil = 0;
    let spinnerShimmerSeed = 0;
    let spinnerShimmerDelay: (() => void) | null = null;
    let spinnerShimmerFrame: (() => void) | null = null;
    // Output tokens for the whole run, like pi-polish: finished messages add their real
    // usage.output; the message still streaming adds an estimate (chars / 4) of its text,
    // thinking and tool-call arguments, so the count climbs as the model writes.
    let runOutputTokens = 0;
    let streamedChars = 0;
    let streamedBlockLengths: number[] = [];
    let thinkingStatus: "thinking" | number /* duration ms */ | null = null;
    let thinkingStartTime = 0;
    let thoughtForSetAt = 0;
    let activeTurnId = 0;
    let turnActive = false;
    let lastWorkingMessage: string | null = null;
    let activeCtx: { ui: any; hasUI: boolean } | null = null;
    // Tools running right now, in start order; the latest one names the working line.
    const runningTools = new Map<string, { name: string; args: unknown }>();
    // Root interactive session only — nested/non-UI contexts must not fight
    // herdr state authority for this pane.
    let herdrRootSession = false;

    function getEffortSuffix(): string {
        try {
            const level = pi.getThinkingLevel();
            if (!level || level === "off") return "";
            return ` with ${level} effort`;
        } catch {
            return "";
        }
    }

    function buildWorkingMessage(): string {
        const elapsed = Date.now() - (agentStartTime || turnStartTime);
        const tokenCount = shownTokens;
        const statusParts: string[] = [];

        if (thinkingStatus === "thinking") {
            statusParts.push(`thinking${getEffortSuffix()}`);
        } else if (typeof thinkingStatus === "number") {
            statusParts.push(`thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`);
        }

        if (tokenCount > 0) {
            statusParts.push(`↓ ${formatCount(tokenCount)} tokens`);
        }

        if (elapsed > SHOW_TIMER_AFTER_MS || thinkingStatus !== null || tokenCount > 0) {
            statusParts.push(formatDuration(elapsed));
        }

        const running = [...runningTools.values()];
        const latest = running[running.length - 1];
        const verb = latest
            ? `${describeToolActivity(latest.name, latest.args)}${running.length > 1 ? ` (+${running.length - 1} more)` : ""}`
            : textAnimator ? textAnimator.displayedText() : currentVerb;
        // The suffix stays static when animated dots are off.
        const dotsSuffix = textAnimator?.dotsSuffix() ?? "...";
        const verbFade = latest ? 0 : textAnimator?.fadeAmount() ?? 0;
        const now = Date.now();
        const shimmering = !latest && spinnerShimmerUntil > now && !textAnimator?.isAnimating();
        const shimmerIntensity = Math.min(1, (spinnerShimmerUntil - now) / SPINNER_SHIMMER_FADE_MS);
        const shimmerSettings = shimmering ? readSpinnerSettings() : undefined;
        let message = shimmering
            ? `${renderShimmerText(verb, CLAUDE_ORANGE, spinnerShimmerSeed, false, Date.now(), {
                direction: shimmerSettings?.shimmerDirection,
                color: shimmerSettings?.shimmerColor,
                intensity: shimmerIntensity,
            })}${CLAUDE_ORANGE}${dotsSuffix}${RESET}`
            : `${getSpinnerVerbColor(verbFade)}${verb}${dotsSuffix}${RESET}`;
        if (statusParts.length > 0) {
            message += statusText(` (${statusParts.join(" · ")})`);
        }
        return message;
    }

    function getSpinnerVerbColor(fadeAmount: number): string {
        const amount = Math.max(0, Math.min(1, fadeAmount));
        if (amount === 0) return CLAUDE_ORANGE;
        const source = CLAUDE_ORANGE.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
        const target = STATUS_DIM.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
        if (!source || !target) return `\x1b[2m${CLAUDE_ORANGE}`;
        const mix = (index: number) => Math.round(
            Number(source[index + 1]) * (1 - amount) + Number(target[index + 1]) * amount,
        );
        return `\x1b[38;2;${mix(0)};${mix(1)};${mix(2)}m`;
    }

    function setStreamedBlockLength(index: number, length: number): void {
        const previous = streamedBlockLengths[index] ?? 0;
        streamedBlockLengths[index] = Math.max(0, length);
        streamedChars = Math.max(0, streamedChars + streamedBlockLengths[index] - previous);
    }

    function resetStreamed(): void {
        streamedBlockLengths = [];
        streamedChars = 0;
    }

    function outputTokenCount(): number {
        return runOutputTokens + Math.round(streamedChars / 4);
    }

    /** Start of a top-level request (not steering or follow-ups inside it). */
    function beginRun(now = Date.now()): void {
        if (agentStartTime) return;
        agentStartTime = now;
        runOutputTokens = 0;
        resetStreamed();
        resetShownTokens();
    }

    function resetShownTokens(): void {
        stopTokenAnimation();
        shownTokens = 0;
    }

    function stopTokenAnimation(): void {
        if (tokenFrameTimer) {
            clearTimeout(tokenFrameTimer);
            tokenFrameTimer = null;
        }
    }

    /** Count the shown tokens toward the real total, one frame at a time, while they differ. */
    function animateTokens(): void {
        if (tokenFrameTimer || !turnActive || shownTokens === outputTokenCount()) return;
        const scheduledAt = Date.now();
        tokenFrameTimer = setTimeout(() => {
            tokenFrameTimer = null;
            shownTokens = easeTokenCount(shownTokens, outputTokenCount(), Date.now() - scheduledAt);
            syncWorkingMessage();
            animateTokens();
        }, TOKEN_FRAME_MS);
        unrefTimer(tokenFrameTimer);
    }

    function syncWorkingMessage(force = false): void {
        try {
            if (!activeCtx?.hasUI) return;
        } catch {
            // Session replacement/reload invalidated the captured context.
            return;
        }
        // Re-derive colors on every tick so /cc-spinner verb/status changes
        // take effect within ~250 ms without waiting for the next pi event.
        // applyThemeColors only re-resolves two theme colors, so this is cheap.
        applyThemeColors(activeCtx.ui?.theme);
        textAnimator?.setDotsEnabled(readSpinnerSettings().animatedDots);
        const nextMessage = buildWorkingMessage();
        if (!force && nextMessage === lastWorkingMessage) return;
        lastWorkingMessage = nextMessage;
        try {
            activeCtx.ui.setWorkingMessage(nextMessage);
        } catch { /* noop */ }
    }

    function restoreDefaultWorkingMessage(): void {
        lastWorkingMessage = null;
        try {
            if (!activeCtx?.hasUI) return;
        } catch {
            // Session replacement/reload invalidated the captured context.
            return;
        }
        try {
            activeCtx.ui.setWorkingMessage();
        } catch { /* noop */ }
    }

    function getWorkingMessageIntervalMs(): number {
        const elapsed = Date.now() - (agentStartTime || turnStartTime);
        const tokenCount = outputTokenCount();
        // Keep ticking once per second even when idle so /cc-spinner changes
        // take effect within ~1s and elapsed-time crossover into the timer-on
        // state still fires close to 30s. syncWorkingMessage short-circuits
        // when the rendered string is unchanged, so the cost is negligible.
        if (thinkingStatus === null && tokenCount === 0 && elapsed <= SHOW_TIMER_AFTER_MS) {
            return Math.max(250, Math.min(WORKING_MESSAGE_INTERVAL_MS, SHOW_TIMER_AFTER_MS - elapsed + 1));
        }
        return Math.max(250, WORKING_MESSAGE_INTERVAL_MS - (elapsed % WORKING_MESSAGE_INTERVAL_MS));
    }

    function scheduleRefreshTick(): void {
        if (!turnActive || refreshTimer) return;
        const intervalMs = getWorkingMessageIntervalMs();
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            syncWorkingMessage();
            scheduleRefreshTick();
        }, intervalMs);
        unrefTimer(refreshTimer);
    }

    function startRefreshLoop(): void {
        stopRefreshLoop();
        syncWorkingMessage(true);
        scheduleRefreshTick();
        animateTokens();
    }

    function rescheduleRefreshLoop(): void {
        if (!turnActive) return;
        stopRefreshLoop();
        scheduleRefreshTick();
        animateTokens();
    }

    function stopRefreshLoop(): void {
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
        stopTokenAnimation();
    }

    function clearCompletionTimer(): void {
        if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = null;
        }
    }

    function scheduleSpinnerShimmer(delayMs?: number): void {
        if (!turnActive || !textAnimator || spinnerShimmerDelay || spinnerShimmerFrame) return;
        const delay = delayMs ?? SPINNER_SHIMMER_MIN_INTERVAL_MS
            + Math.random() * (SPINNER_SHIMMER_MAX_INTERVAL_MS - SPINNER_SHIMMER_MIN_INTERVAL_MS);
        spinnerShimmerDelay = scheduleAnimation(delay, () => {
            spinnerShimmerDelay = null;
            if (!turnActive || !textAnimator) return;
            if (runningTools.size > 0 || textAnimator.isAnimating()) {
                scheduleSpinnerShimmer(3_000);
                return;
            }
            spinnerShimmerSeed = Math.floor(Math.random() * 4_000);
            spinnerShimmerUntil = Date.now() + SPINNER_SHIMMER_DURATION_MS;
            syncWorkingMessage(true);
            scheduleSpinnerShimmerFrame();
        });
    }

    function scheduleSpinnerShimmerFrame(): void {
        if (!turnActive || !textAnimator || !spinnerShimmerUntil || spinnerShimmerFrame) return;
        spinnerShimmerFrame = scheduleAnimation(SPINNER_SHIMMER_FRAME_MS, () => {
            spinnerShimmerFrame = null;
            if (!turnActive || !textAnimator) {
                spinnerShimmerUntil = 0;
                return;
            }
            if (Date.now() >= spinnerShimmerUntil || runningTools.size > 0 || textAnimator.isAnimating()) {
                spinnerShimmerUntil = 0;
                syncWorkingMessage(true);
                scheduleSpinnerShimmer();
                return;
            }
            syncWorkingMessage();
            scheduleSpinnerShimmerFrame();
        });
    }

    function stopSpinnerShimmer(): void {
        spinnerShimmerDelay?.();
        spinnerShimmerDelay = null;
        spinnerShimmerFrame?.();
        spinnerShimmerFrame = null;
        spinnerShimmerUntil = 0;
    }

    /** Fresh typewriter + optional dot loops at the start of each turn. */
    function startTextAnimator(): void {
        stopTextAnimator();
        textAnimator = createSpinnerTextAnimator({
            schedule: scheduleAnimation,
            pickVerb: pickVerb,
            animatedDots: readSpinnerSettings().animatedDots,
            onChange: () => {
                // Diff-checked: only pushes work when the rendered string changed.
                if (turnActive) syncWorkingMessage();
            },
        });
        textAnimator.setToolActive(runningTools.size > 0);
        textAnimator.start(currentVerb);
        scheduleSpinnerShimmer();
    }

    function stopTextAnimator(): void {
        stopSpinnerShimmer();
        if (!textAnimator) return;
        textAnimator.stop();
        textAnimator = null;
    }

    function clearThoughtStatusTimer(): void {
        if (thoughtStatusTimer) {
            clearTimeout(thoughtStatusTimer);
            thoughtStatusTimer = null;
        }
    }

    function scheduleThoughtStatusClear(): void {
        clearThoughtStatusTimer();
        if (typeof thinkingStatus !== "number") return;
        const remaining = THOUGHT_DISPLAY_MS - (Date.now() - thoughtForSetAt);
        if (remaining <= 0) {
            thinkingStatus = null;
            if (turnActive) syncWorkingMessage(true);
            else if (!completionTimer) restoreDefaultWorkingMessage();
            return;
        }
        thoughtStatusTimer = setTimeout(() => {
            thoughtStatusTimer = null;
            if (typeof thinkingStatus !== "number") return;
            if (Date.now() - thoughtForSetAt < THOUGHT_DISPLAY_MS) {
                scheduleThoughtStatusClear();
                return;
            }
            thinkingStatus = null;
            if (turnActive) syncWorkingMessage(true);
            else if (!completionTimer) restoreDefaultWorkingMessage();
        }, remaining);
        unrefTimer(thoughtStatusTimer);
    }

    function clearDisplay(): void {
        stopRefreshLoop();
        clearCompletionTimer();
        clearThoughtStatusTimer();
        stopTextAnimator();
        agentStartTime = 0;
        turnStartTime = 0;
        thinkingStatus = null;
        thoughtForSetAt = 0;
        runOutputTokens = 0;
        resetStreamed();
        resetShownTokens();
        restoreDefaultWorkingMessage();
    }

    function herdrMarkWorking(ctx?: any): void {
        if (!herdrRootSession) return;
        if (ctx) herdrUpdateSessionRef(ctx);
        void herdrReportSession();
        herdrPublishState("working");
    }

    function herdrMarkIdle(ctx?: any, force = false): void {
        if (!herdrRootSession) return;
        if (ctx) herdrUpdateSessionRef(ctx);
        herdrPublishState("idle", force);
    }

    // session_start: claim root UI session + announce native session identity.
    pi.on("session_start", async (event, ctx) => {
        if (!herdrEnabled()) return;
        if (ctx?.hasUI !== true) return;
        herdrRootSession = true;
        herdrUpdateSessionRef(ctx);
        await herdrReportSession((event as any)?.reason);
        // Reload mid-run: isIdle() false means work is still in flight.
        const working = ctx?.isIdle?.() === false;
        herdrPublishState(working ? "working" : "idle", true);
    });

    function onThinkingEnd(): void {
        if (thinkingStatus !== "thinking") return;
        const duration = Date.now() - thinkingStartTime;
        if (duration < MIN_THINKING_SHOW_MS) {
            thinkingStatus = null;
            clearThoughtStatusTimer();
            return;
        }
        thinkingStatus = duration;
        thoughtForSetAt = Date.now();
        scheduleThoughtStatusClear();
    }

    pi.on("before_agent_start", async () => {
        // Start once per top-level request. Steering/follow-up messages while the
        // agent is active must not reset the timer or the token count.
        beginRun();
    });

    pi.on("agent_start", async (_event, ctx) => {
        beginRun();
        herdrMarkWorking(ctx);
    });

    pi.on("turn_start", async (_event, ctx) => {
        activeTurnId++;
        turnActive = true;
        activeCtx = ctx;
        applyThemeColors(ctx.ui?.theme);
        turnStartTime = Date.now();
        beginRun(turnStartTime);
        currentVerb = pickVerb();
        startTextAnimator();
        resetStreamed();
        clearCompletionTimer();
        if (typeof thinkingStatus !== "number" || Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
            thinkingStatus = null;
            clearThoughtStatusTimer();
        } else {
            scheduleThoughtStatusClear();
        }
        startRefreshLoop();
        // turn_start is the earliest UI-visible busy signal; cover cases where
        // agent_start already fired or is ordering-sensitive across reloads.
        herdrMarkWorking(ctx);
    });

    pi.on("message_update", async (event, ctx) => {
        activeCtx = ctx;
        applyThemeColors(ctx.ui?.theme);
        const evt = event.assistantMessageEvent;
        let statusChanged = false;
        const previousTokenCount = outputTokenCount();

        if (evt.type === "start") {
            resetStreamed();
        } else if (evt.type === "text_start" || evt.type === "thinking_start" || evt.type === "toolcall_start") {
            setStreamedBlockLength(evt.contentIndex, 0);
        } else if (evt.type === "text_delta" || evt.type === "thinking_delta" || evt.type === "toolcall_delta") {
            const previous = streamedBlockLengths[evt.contentIndex] ?? 0;
            setStreamedBlockLength(evt.contentIndex, previous + (typeof evt.delta === "string" ? evt.delta.length : 0));
        } else if (evt.type === "text_end" || evt.type === "thinking_end") {
            setStreamedBlockLength(evt.contentIndex, typeof evt.content === "string" ? evt.content.length : 0);
        } else if (evt.type === "toolcall_end") {
            setStreamedBlockLength(evt.contentIndex, contentBlockLength({ type: "toolCall", arguments: evt.toolCall?.arguments }));
        }

        if (evt.type === "thinking_start") {
            clearThoughtStatusTimer();
            thinkingStatus = "thinking";
            thinkingStartTime = Date.now();
            statusChanged = true;
        }
        if (evt.type === "thinking_end") {
            onThinkingEnd();
            statusChanged = true;
        }

        if (statusChanged) {
            syncWorkingMessage(true);
            rescheduleRefreshLoop();
            animateTokens();
            // Same-frame ordering: ensure footer updates even if pi rendered first.
            const timer = setTimeout(() => syncWorkingMessage(true), 0);
            unrefTimer(timer);
            return;
        }

        const nextTokenCount = outputTokenCount();
        if (previousTokenCount === 0 && nextTokenCount > 0) {
            rescheduleRefreshLoop();
        }
        animateTokens();
    });

    // A finished message swaps its estimate for the provider's real output-token count.
    pi.on("message_end", async (event: any) => {
        if (event?.message?.role !== "assistant") return;
        runOutputTokens += messageOutputTokens(event.message);
        resetStreamed();
        if (turnActive) syncWorkingMessage();
        animateTokens();
    });

    pi.on("tool_execution_start", async (event: any, ctx) => {
        if (typeof event?.toolCallId !== "string") return;
        activeCtx = ctx;
        runningTools.set(event.toolCallId, { name: String(event.toolName ?? ""), args: event.args });
        textAnimator?.setToolActive(true);
        if (turnActive) syncWorkingMessage(true);
    });

    pi.on("tool_execution_end", async (event: any, ctx) => {
        if (typeof event?.toolCallId !== "string" || !runningTools.delete(event.toolCallId)) return;
        activeCtx = ctx;
        if (runningTools.size === 0) textAnimator?.setToolActive(false);
        if (turnActive) syncWorkingMessage(true);
    });

    pi.on("turn_end", async (_event, ctx) => {
        turnActive = false;
        activeCtx = ctx;
        applyThemeColors(ctx.ui?.theme);
        const turnId = activeTurnId;
        const elapsed = Date.now() - (agentStartTime || turnStartTime);
        stopRefreshLoop();
        clearCompletionTimer();
        stopTextAnimator();

        if (typeof thinkingStatus === "number" && Date.now() - thoughtForSetAt >= THOUGHT_DISPLAY_MS) {
            thinkingStatus = null;
            clearThoughtStatusTimer();
        }

        try {
            if (activeCtx?.hasUI) {
                const message = `${STATUS_DIM}✻ Turn took ${formatDuration(elapsed)}${RESET}`;
                lastWorkingMessage = message;
                try {
                    activeCtx.ui.setWorkingMessage(message);
                } catch { /* noop */ }
                completionTimer = setTimeout(() => {
                    completionTimer = null;
                    if (activeTurnId !== turnId) return;
                    restoreDefaultWorkingMessage();
                }, TURN_COMPLETION_MS);
                unrefTimer(completionTimer);
            } else if (typeof thinkingStatus !== "number") {
                restoreDefaultWorkingMessage();
            }
        } catch {
            // Session replacement/reload invalidated the captured context.
            return;
        }

        resetStreamed();
    });

    pi.on("agent_end", async () => {
        turnActive = false;
        agentStartTime = 0;
        runningTools.clear();
        // Preserve the just-finished "Turn took ..." line. Pi emits agent_end
        // immediately after the final turn, so clearing here made the completion
        // status disappear before users could see it.
        if (completionTimer) return;
        clearDisplay();
    });

    // Prefer agent_settled over agent_end: pi may still auto-retry, compact, or
    // drain a follow-up queue after agent_end. Settled means truly idle.
    // Cast: agent_settled landed after some older @earendil-works/pi-coding-agent
    // type packages still used for local typecheck; runtime pi has the event.
    (pi as ExtensionAPI & {
        on(event: "agent_settled", handler: (event: unknown, ctx: any) => void | Promise<void>): void;
    }).on("agent_settled", async (_event, ctx) => {
        if (!herdrRootSession) return;
        if (ctx?.isIdle?.() !== true) return;
        herdrMarkIdle(ctx);
    });

    pi.on("session_shutdown", async () => {
        turnActive = false;
        runningTools.clear();
        clearDisplay();
        herdrMarkIdle(undefined, true);
        herdrRootSession = false;
        activeCtx = null;
    });
}
