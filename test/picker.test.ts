import { describe, expect, it } from "vitest";

import {
  type PickerState,
  VISIBLE_ROWS,
  frame,
  keysOf,
  step,
} from "../src/picker.js";

const choices = ["Sol Livio", "Herb", "Scaled Ai", "Loopsy"].map((label) => ({
  label,
  value: `org_${label}`,
}));
const start: PickerState = { cursor: 0, filter: "" };

function press(input: string, state = start) {
  for (const key of keysOf(input)) {
    const next = step(state, key, choices);
    if (next.done !== undefined) return next.done;
    state = next.state;
  }
  return state;
}

describe("picker", () => {
  it("reads arrows in both terminal modes, Enter, Space, Esc and Ctrl-C", () => {
    expect(keysOf("\u001b[A\u001bOB\r \u001b\u0003")).toEqual([
      "up",
      "down",
      "choose",
      "choose",
      "skip",
      "cancel",
    ]);
    // Other escape sequences (here: right arrow, delete) are ignored.
    expect(keysOf("\u001b[C\u001b[3~")).toEqual([]);
  });

  it("moves with the arrows, wrapping at both ends, and chooses", () => {
    expect(press("\u001b[B\u001b[B\r")).toBe("org_Scaled Ai");
    expect(press("\u001b[A ")).toBe("org_Loopsy");
    expect(press("\u001b[B\u001b")).toBeNull();
  });

  it("typing filters the list; Enter takes the first match", () => {
    expect(press("loo\r")).toBe("org_Loopsy");
    expect(press("HERB\r")).toBe("org_Herb");
    expect(press("zzz\r")).toEqual({ cursor: 0, filter: "zzz" });
    expect(press("zzz\u007f\u007f\u007fsol\r")).toBe("org_Sol Livio");
  });

  it("shows ten rows at a time around the cursor, cut to the terminal width", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      label: `Org ${i + 1}`,
      value: `org_${i + 1}`,
    }));
    const top = frame("Which?", start, many);
    expect(top.filter((l) => /Org \d/.test(l))).toHaveLength(VISIBLE_ROWS);
    expect(top).toContain("❯ Org 1");
    expect(top.at(-1)).toContain("1–10 of 25");
    const low = frame("Which?", { cursor: 14, filter: "" }, many);
    expect(low).toContain("❯ Org 15");
    expect(low.at(-1)).toContain("6–15 of 25");
    for (const line of frame("Which?", start, many, 12))
      expect([...line].length).toBeLessThan(12);
  });
});
