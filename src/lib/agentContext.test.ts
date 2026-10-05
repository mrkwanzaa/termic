import { describe, expect, it } from "vitest";
import { parseContextBody, sameContext, formatTokens, contextLevel, CONTEXT_BODY_PREFIX, footerSources, footerNeedsHooks, footerReports } from "./agentContext";
import { USAGE_BODY_PREFIX } from "./agentUsage";
import { HOOK_OSC_BODY, HOOK_OSC_READY_BODY } from "./agentHooks";

describe("parseContextBody", () => {
  it("pins the prefix the Rust side writes", () => {
    // KEEP IN SYNC with agent_hooks::CONTEXT_BODY_PREFIX.
    expect(CONTEXT_BODY_PREFIX).toBe("ctx ");
  });

  it("never collides with another body on the same channel", () => {
    for (const other of [USAGE_BODY_PREFIX, HOOK_OSC_BODY, HOOK_OSC_READY_BODY]) {
      expect(other.startsWith(CONTEXT_BODY_PREFIX)).toBe(false);
      expect(CONTEXT_BODY_PREFIX.startsWith(other)).toBe(false);
    }
  });

  it("derives the percentage from tokens when the agent sends none (claude)", () => {
    expect(parseContextBody("ctx 8123 200000")).toEqual({
      usedTokens: 8123, windowTokens: 200000, usedPercent: (8123 / 200000) * 100,
    });
  });

  it("prefers the agent's own percentage when it sends one (codex's baseline)", () => {
    expect(parseContextBody("ctx 34357 258400 9")?.usedPercent).toBe(9);
  });

  it("clamps a percentage past the window", () => {
    expect(parseContextBody("ctx 300000 200000")?.usedPercent).toBe(100);
  });

  it("is no reading at all without a window or tokens, rather than 0%", () => {
    expect(parseContextBody("ctx 100 0")).toBeNull();
    expect(parseContextBody("ctx - 200000")).toBeNull();
    expect(parseContextBody("ctx 100")).toBeNull();
    expect(parseContextBody("ctx ")).toBeNull();
  });

  it("drops anything that is not a bare number", () => {
    expect(parseContextBody("ctx 1e5 200000")).toBeNull();
    expect(parseContextBody("ctx -5 200000")).toBeNull();
    expect(parseContextBody("ctx 5 200000 abc")?.usedPercent).toBeCloseTo(0.0025);
  });

  it("is not a usage body", () => {
    expect(parseContextBody("usage 1 2 - - -")).toBeNull();
  });
});

describe("sameContext", () => {
  it("compares every field", () => {
    const a = { usedTokens: 1, windowTokens: 2, usedPercent: 50 };
    expect(sameContext(a, { ...a })).toBe(true);
    expect(sameContext(a, { ...a, usedTokens: 2 })).toBe(false);
    expect(sameContext(a, undefined)).toBe(false);
    expect(sameContext(undefined, undefined)).toBe(true);
  });
});

describe("formatTokens", () => {
  it("abbreviates", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(84_400)).toBe("84k");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });
});

describe("contextLevel", () => {
  it("colours only near compaction", () => {
    expect(contextLevel(79)).toBe("normal");
    expect(contextLevel(80)).toBe("warn");
    expect(contextLevel(90)).toBe("critical");
  });
});

describe("footer sources", () => {
  const both = { usage: true, context: true };

  it("sends every agent whose context comes from the hooks install to the install", () => {
    for (const a of ["claude", "codex", "agy", "copilot", "devin", "grok", "opencode", "pi", "omp"]) {
      expect(footerNeedsHooks(footerSources(a), both), a).toBe(true);
    }
  });

  it("does not ask for hooks when only a pulled readout is left on", () => {
    // codex, copilot, devin and omp pull their usage; hiding context leaves
    // nothing that hooks would bring.
    for (const a of ["codex", "copilot", "devin", "omp"]) {
      expect(footerNeedsHooks(footerSources(a), { usage: true, context: false }), a).toBe(false);
    }
    // claude's usage IS the status line, so it still needs them.
    expect(footerNeedsHooks(footerSources("claude"), { usage: true, context: false })).toBe(true);
  });

  it("pulls omp's usage and hooks its context", () => {
    // `omp usage --json` is a measured cold transport (18.6.0), the plugin's
    // getContextUsage the context source — the same split as codex's.
    expect(footerSources("omp")).toEqual({ usage: "pull", context: "hooks" });
  });

  it("has no source for muse or an unknown agent", () => {
    expect(footerReports("muse")).toEqual({ usage: false, context: false });
    expect(footerReports("nope")).toEqual({ usage: false, context: false });
    expect(footerNeedsHooks(footerSources("muse"), both)).toBe(false);
  });
});
