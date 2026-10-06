import { describe, it, expect } from "vitest";
import { EMPTY_DRAFT, isComposing, nextDraft, type DraftState } from "@/lib/draftTracker";

/** Feed a sequence of onData payloads, none of them answering a prompt. */
const type = (keys: string[], from: DraftState = EMPTY_DRAFT) =>
  keys.reduce((d, k) => nextDraft(d, k, false), from);

const UP = "\x1b[A";
const DOWN = "\x1b[B";

describe("nextDraft", () => {
  it("typing is a draft, and Enter, Ctrl-C or Ctrl-U ends it", () => {
    expect(isComposing(type(["h", "i"]))).toBe(true);
    for (const end of ["\r", "\n", "\x03", "\x15"]) {
      expect(isComposing(type(["h", "i", end]))).toBe(false);
    }
  });

  it("backspacing everything typed leaves an empty prompt", () => {
    expect(isComposing(type(["h", "i", "\x7f"]))).toBe(true);
    expect(isComposing(type(["h", "i", "\x7f", "\x7f"]))).toBe(false);
    // One more than was typed is still empty, not negative.
    expect(isComposing(type(["h", "\x7f", "\x7f", "\x7f"]))).toBe(false);
  });

  // The deadlock this module exists for. claude's permission dialog takes a
  // bare digit with no Enter; counted as a draft character it was never
  // submitted and never cleared, so every message another agent sent queued
  // behind a prompt that was empty.
  it("a key that answers the agent's own prompt is not a draft", () => {
    expect(isComposing(nextDraft(EMPTY_DRAFT, "1", true))).toBe(false);
    expect(isComposing(nextDraft(EMPTY_DRAFT, "y", true))).toBe(false);
  });

  it("answering a prompt leaves a draft that was already there alone", () => {
    const draft = type(["f", "i", "x"]);
    // The dialog covers the input box; Enter on it submits the answer, not
    // the draft, which is still in the box afterwards.
    expect(nextDraft(draft, "2", true)).toEqual(draft);
    expect(nextDraft(draft, "\r", true)).toEqual(draft);
  });

  it("deleting a word takes the word out of the draft, both spellings", () => {
    for (const wordDelete of ["\x17", "\x1b\x7f", "\x1b\b"]) {
      // One word: the prompt is empty again. It used to stay "composing".
      expect(isComposing(type([..."hello", wordDelete]))).toBe(false);
      // Two words: the first is still there.
      expect(isComposing(type([..."fix this", wordDelete]))).toBe(true);
      expect(isComposing(type([..."fix this", wordDelete, wordDelete]))).toBe(false);
      // Trailing space goes with the word, as readline does it.
      expect(isComposing(type([..."hello ", wordDelete]))).toBe(false);
    }
  });

  it("history recalled with Up is a draft until Down steps back out of it", () => {
    expect(isComposing(type([UP]))).toBe(true);
    expect(isComposing(type([UP, DOWN]))).toBe(false);
    expect(isComposing(type([UP, UP, DOWN]))).toBe(true);
    expect(isComposing(type([UP, UP, DOWN, DOWN]))).toBe(false);
    // Application cursor keys, same thing.
    expect(isComposing(type(["\x1bOA", "\x1bOB"]))).toBe(false);
    // Down on an empty prompt is nothing.
    expect(isComposing(type([DOWN]))).toBe(false);
  });

  it("errs towards a draft where the text was never seen", () => {
    // A recalled entry edited by hand: we cannot know what is left of it.
    expect(isComposing(type([UP, "x", "\x7f"]))).toBe(true);
    expect(isComposing(type([UP, "\x7f"]))).toBe(true);
    expect(isComposing(type([UP, "\x17"]))).toBe(true);
    // Until it is submitted or cleared.
    expect(isComposing(type([UP, "x", "\r"]))).toBe(false);
    // Up with text typed moves the cursor in the draft; Down then proves nothing.
    expect(isComposing(type(["a", UP, DOWN]))).toBe(true);
  });

  it("a paste is a draft", () => {
    expect(isComposing(type(["\x1b[200~pasted text\x1b[201~"]))).toBe(true);
    expect(isComposing(type(["\x1b[200~pasted text\x1b[201~", "\r"]))).toBe(false);
  });

  it("ignores what is not typing: arrows, a bare Escape, xterm's own replies", () => {
    for (const k of ["\x1b", "\x1b[C", "\x1b[D", "\x1b[12;40R", "\x1b[I", "\x1b[O", "\x1b[Z"]) {
      expect(nextDraft(EMPTY_DRAFT, k, false)).toEqual(EMPTY_DRAFT);
      const draft = type(["a"]);
      expect(nextDraft(draft, k, false)).toEqual(draft);
    }
  });
});
