// The spinner turns by its `termic-spin` class, and `still` drops it: the
// status section's Working header draws the ring as a legend, and a header
// spinning forever would repaint on every frame for no news. The e2e suite
// cannot reach that header (the Working bucket is transient), so this pins it.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  it("turns by default", () => {
    const html = renderToStaticMarkup(createElement(Spinner, { size: 12 }));
    expect(html).toContain("termic-spin");
    expect(html).not.toContain("data-still");
  });

  it("draws the same ring without turning when still", () => {
    const html = renderToStaticMarkup(createElement(Spinner, { size: 12, still: true }));
    expect(html).not.toContain("termic-spin");
    expect(html).toContain('data-still="true"');
    expect(html).toContain('data-mark="spinner"');
  });

  it("is still in the status section's Working header", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "../sidebar/StatusSection.tsx"), "utf8");
    expect(src).toMatch(/bucket === "working" \? <Spinner [^>]*\bstill\b/);
  });
});
