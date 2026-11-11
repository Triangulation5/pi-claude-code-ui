import assert from "node:assert/strict";
import { test } from "node:test";

import { noteShimmerActivity, noteShimmerRow, renderShimmerText, shimmerRowInfo } from "../extensions/shimmer-text.ts";

const BASE = "\x1b[38;2;80;90;100m";

function firstForegroundColor(text: string): number[] {
    const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(text);
    assert.ok(match);
    return match.slice(1).map(Number);
}

test("flash brightens text twice, with a dimmer second pulse", () => {
    const render = (elapsedMs: number) => renderShimmerText("Working", BASE, 0, false, 0, {
        style: "flash",
        elapsedMs,
    });
    const base = firstForegroundColor(render(800));
    const first = firstForegroundColor(render(90));
    const second = firstForegroundColor(render(430));

    assert.ok(first[0] > second[0]);
    assert.ok(second[0] > base[0]);
});

test("default shimmer sweeps across Thinking text", () => {
    const first = renderShimmerText("Thinking...", BASE, 0, false, 0);
    const next = renderShimmerText("Thinking...", BASE, 0, false, 200);

    assert.notEqual(first, next);
});

test("registering a live collapsed Thinking row arms its shimmer", () => {
    let live = true;
    const row = { isShimmerText: () => live };
    noteShimmerActivity(false);
    try {
        noteShimmerRow(row);
        assert.ok(shimmerRowInfo(row));
    } finally {
        live = false;
        noteShimmerActivity(false);
    }
    assert.equal(shimmerRowInfo(row), null);
});
