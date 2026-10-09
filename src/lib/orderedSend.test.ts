import { describe, expect, it } from "vitest";
import { orderedPerKey } from "./orderedSend";

/** A transport that finishes each send only when the test says so, the way
 *  two concurrent IPC requests can be handled in either order. */
function manualTransport() {
  const started: string[] = [];
  const pending: Array<{ label: string; resolve: () => void; reject: (e: Error) => void }> = [];
  const send = (key: string, label: string) => {
    started.push(`${key}:${label}`);
    return new Promise<void>((resolve, reject) => { pending.push({ label, resolve, reject }); });
  };
  const settle = (label: string, fail = false) => {
    const i = pending.findIndex(p => p.label === label);
    const [p] = pending.splice(i, 1);
    if (fail) p.reject(new Error(label)); else p.resolve();
  };
  return { started, send, settle };
}

const tick = () => new Promise<void>(r => setTimeout(r, 0));

describe("orderedPerKey", () => {
  it("sends an idle key's call in the caller's task", () => {
    const t = manualTransport();
    const write = orderedPerKey(t.send);
    void write("pty-1", "a");
    // No await: the send must already have started.
    expect(t.started).toEqual(["pty-1:a"]);
  });

  it("holds a second call until the first has finished", async () => {
    const t = manualTransport();
    const write = orderedPerKey(t.send);
    void write("pty-1", "syllable");
    void write("pty-1", "enter");
    await tick();
    expect(t.started).toEqual(["pty-1:syllable"]);
    t.settle("syllable");
    await tick();
    expect(t.started).toEqual(["pty-1:syllable", "pty-1:enter"]);
  });

  it("without the wrapper both are in flight at once (the control)", () => {
    const t = manualTransport();
    void t.send("pty-1", "syllable");
    void t.send("pty-1", "enter");
    expect(t.started).toEqual(["pty-1:syllable", "pty-1:enter"]);
  });

  it("does not make one key wait on another", () => {
    const t = manualTransport();
    const write = orderedPerKey(t.send);
    void write("pty-1", "a");
    void write("pty-2", "b");
    expect(t.started).toEqual(["pty-1:a", "pty-2:b"]);
  });

  it("keeps going after a send that rejects, and reports the rejection to its caller", async () => {
    const t = manualTransport();
    const write = orderedPerKey(t.send);
    const first = write("pty-1", "a");
    const second = write("pty-1", "b");
    t.settle("a", true);
    await expect(first).rejects.toThrow("a");
    await tick();
    expect(t.started).toEqual(["pty-1:a", "pty-1:b"]);
    t.settle("b");
    await expect(second).resolves.toBeUndefined();
  });

  it("goes back to the immediate path once the key has drained", async () => {
    const t = manualTransport();
    const write = orderedPerKey(t.send);
    const first = write("pty-1", "a");
    t.settle("a");
    await first;
    await tick();
    void write("pty-1", "b");
    expect(t.started).toEqual(["pty-1:a", "pty-1:b"]);
  });
});
