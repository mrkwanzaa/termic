// Keeps one key's async sends in call order.
//
// Two `invoke`s issued back to back are two independent requests, and nothing
// promises the second is handled after the first. For PTY input that is a
// correctness bug, not a cosmetic one: xterm and the IME bridge each write the
// same PTY on their own, so a reordered pair types the Enter before the
// syllable it was meant to submit. Seen on WebView2 in CI, where the bridge's
// replacement landed on the line AFTER the one its Enter had already sent.

/**
 * Wrap `send` so calls sharing a key run one at a time, in the order they
 * were made. A call that finds nothing in flight for its key is sent in the
 * caller's own task, so an idle PTY pays no extra tick per keystroke. A send
 * that rejects does not stall the ones queued behind it.
 */
export function orderedPerKey<A extends unknown[]>(
  send: (key: string, ...args: A) => Promise<void>,
): (key: string, ...args: A) => Promise<void> {
  const tails = new Map<string, Promise<void>>();
  return (key, ...args) => {
    const prev = tails.get(key);
    const result = prev ? prev.then(() => send(key, ...args)) : send(key, ...args);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return result;
  };
}
