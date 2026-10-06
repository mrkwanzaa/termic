import { describe, it, expect } from "vitest";
import { hookSourceState } from "./AgentHookSource";

// The card's source line decides what the whole Agent state section says, and
// the order of these checks is the part that is easy to get wrong.
describe("hookSourceState", () => {
  const base = { supported: true, installed: false, blocked: false, detected: true };

  it("recommends hooks only for an agent that could have them and is on PATH", () => {
    expect(hookSourceState(base)).toBe("available");
    expect(hookSourceState({ ...base, detected: false })).toBe("absent");
  });

  it("says hooks once installed, whether or not the CLI is detected", () => {
    expect(hookSourceState({ ...base, installed: true })).toBe("hooks");
    expect(hookSourceState({ ...base, installed: true, detected: false })).toBe("hooks");
  });

  it("never claims hooks while the agent's own config blocks them", () => {
    // disableAllHooks: the entries can be on disk and still never fire.
    expect(hookSourceState({ ...base, installed: true, blocked: true })).toBe("blocked");
    expect(hookSourceState({ ...base, blocked: true })).toBe("blocked");
  });

  it("reads an agent with no hooks from the terminal, without a warning state", () => {
    expect(hookSourceState({ ...base, supported: false })).toBe("terminal");
    expect(hookSourceState({ supported: false, installed: true, blocked: true, detected: false })).toBe("terminal");
  });
});
