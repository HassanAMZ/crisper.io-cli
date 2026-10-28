import { describe, expect, it } from "vitest";

import { createProgram } from "../src/cli.js";
import {
  type EditorState,
  edit,
  editorKeys,
  suggest,
  suggestionLines,
} from "../src/lineEditor.js";
import { suggestionsFor } from "../src/shell.js";

const all = suggestionsFor(createProgram().program);
const fresh: EditorState = {
  text: "",
  selected: 0,
  hidden: false,
  historyAt: -1,
};

function type(input: string, history: string[] = [], state = fresh) {
  for (const key of editorKeys(input)) {
    const next = edit(state, key, all, history);
    if (next.submit !== undefined) return { submitted: next.submit, state };
    state = next.state;
  }
  return { submitted: undefined, state };
}

describe("suggestions while typing", () => {
  it("knows every command, with what each one needs", () => {
    const names = all.map((s) => s.command);
    expect(names).toContain("sites status");
    expect(names).toContain("dns check");
    expect(names).not.toContain("sites");
    expect(all.find((s) => s.command === "sites add")?.usage).toBe(
      "<domain> --type <platform>",
    );
  });

  it("shows commands that start with, contain, or are described by what's typed", () => {
    expect(suggest("dn", all).map((s) => s.command)).toEqual([
      "dns records",
      "dns check",
    ]);
    expect(suggest("status", all).map((s) => s.command)).toContain(
      "sites status",
    );
    // Past a command into its arguments, or a finished command: no list.
    expect(suggest("sites list --json", all)).toEqual([]);
    expect(suggest("sites list", all)).toEqual([]);
    expect(suggest("", all)).toEqual([]);
  });

  it("↓ then Enter runs the chosen suggestion; Tab fills it in", () => {
    expect(type("dns\u001b[B\r").submitted).toBe("dns check");
    expect(type("dns\r").submitted).toBe("dns records");
    expect(type("dns\t").state.text).toBe("dns records ");
    // Esc hides the list, so Enter sends exactly what was typed.
    expect(type("dns\u001b\r").submitted).toBe("dns");
  });

  it("↑ walks history when no list is showing; Ctrl-C clears, then leaves", () => {
    expect(type("\u001b[A\r", ["sites list", "auth status"]).submitted).toBe(
      "sites list",
    );
    expect(
      type("\u001b[A\u001b[A\r", ["sites list", "auth status"]).submitted,
    ).toBe("auth status");
    expect(type("sit\u0003").state.text).toBe("");
    expect(type("\u0003").submitted).toBe("\u0003");
    expect(type("\u0004").submitted).toBeNull();
    expect(type("sites lisx\u007ft\r").submitted).toBe("sites list");
  });

  it("draws at most six rows, the chosen one marked, cut to the width", () => {
    const lines = suggestionLines({ ...fresh, text: "s" }, all, 60);
    expect(lines.filter((l) => l.startsWith("❯"))).toHaveLength(1);
    const rows = lines.filter((l) => /^[❯ ] \S/.test(l) && !l.includes("↑/↓"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(6);
    // A long list says how many more there are.
    const many = suggestionLines({ ...fresh, text: "in" }, all);
    if (suggest("in", all).length > 6) expect(many.at(-2)).toContain("more");
    for (const line of lines) expect([...line].length).toBeLessThan(60);
    expect(suggestionLines(fresh, all)[0]).toContain("Type to see");
  });
});
