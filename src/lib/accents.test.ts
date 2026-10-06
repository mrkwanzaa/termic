// The profile accent helpers, and in particular the title-bar wash (GH #280).

import { describe, it, expect } from "vitest";
import {
  profileAccentCss, profileWashCss, isHexAccent,
  PROFILE_ACCENT_FALLBACK, WASH_END_PERCENT, WASH_ALPHA_PERCENT, WASH_MID_PERCENT,
} from "@/lib/accents";

describe("profileWashCss", () => {
  it("paints nothing at all when there is no profile", () => {
    // The dormant install, which is most users. The bar has to render exactly
    // as it always did: not a transparent gradient, no background-image.
    expect(profileWashCss(undefined, false)).toBeUndefined();
    expect(profileWashCss("teal", false)).toBeUndefined();
  });

  it("fades out before the bar ends", () => {
    // The bar carries the breadcrumb and the whole toolbar, so the wash has to
    // be gone before the text that matters. Half the width is the ceiling:
    // measured against PyCharm, less than that was invisible beside it, and
    // more would put colour under the breadcrumb.
    const css = profileWashCss("teal", true)!;
    expect(css).toContain(`transparent ${WASH_END_PERCENT}%`);
    expect(WASH_END_PERCENT).toBeLessThanOrEqual(55);
  });

  it("falls away rather than ramping straight down", () => {
    // A two-stop ramp reads as a smear. Holding most of the colour through the
    // first quarter is what makes it read as a tint ON the bar.
    const css = profileWashCss("teal", true)!;
    expect(css).toContain(`${WASH_ALPHA_PERCENT}%, transparent) 0%`);
    expect(css).toContain(`${WASH_MID_PERCENT}%, transparent) 25%`);
    expect(WASH_MID_PERCENT).toBeLessThan(WASH_ALPHA_PERCENT);
  });

  it("starts at the left edge, which is where the eye already is", () => {
    expect(profileWashCss("teal", true)).toContain("to right");
    expect(profileWashCss("teal", true)).toMatch(/,\s*transparent\)?\s*0%/);
  });

  it("carries a user-typed hex through unchanged", () => {
    // An accent is either a theme token or a hex the user typed, and the wash
    // must not mangle either. `color-mix` is what lets one code path take
    // both without parsing the colour here.
    const css = profileWashCss("#ff8800", true)!;
    expect(css).toContain("#ff8800");
    expect(css).toContain("color-mix(in srgb,");
  });

  it("falls back rather than emitting an empty colour", () => {
    // An unknown key must not produce `color-mix(in srgb,  22%, transparent)`,
    // which is invalid CSS and drops the whole declaration, taking the bar's
    // background with it.
    const css = profileWashCss("not-a-real-accent", true)!;
    expect(css).toContain(PROFILE_ACCENT_FALLBACK);
    expect(css).not.toMatch(/srgb,\s+\d/);
  });
});

describe("profileAccentCss", () => {
  it("prefers a hex over a named key", () => {
    expect(profileAccentCss("#abc")).toBe("#abc");
    expect(isHexAccent("#abcdef")).toBe(true);
    expect(isHexAccent("teal")).toBe(false);
  });

  it("always answers with something paintable", () => {
    expect(profileAccentCss(undefined)).toBe(PROFILE_ACCENT_FALLBACK);
  });
});

describe("no colour", () => {
  it("paints no wash at all, not a grey one", async () => {
    // A neutral gradient still reads as a tint and still costs the breadcrumb
    // contrast, which is the whole thing the user opted out of.
    const { profileWashCss, ACCENT_NONE } = await import("@/lib/accents");
    expect(profileWashCss(ACCENT_NONE, true)).toBeUndefined();
  });

  it("still gives the dot something to paint", async () => {
    // The dot has to render or the row jumps by its width when one profile
    // has no colour. It uses the same neutral as an unknown key, which is
    // what makes it read as "no colour" rather than as a colour.
    const { profileAccentCss, ACCENT_NONE, PROFILE_ACCENT_FALLBACK } = await import("@/lib/accents");
    expect(profileAccentCss(ACCENT_NONE)).toBe(PROFILE_ACCENT_FALLBACK);
  });

  it("is distinct from a profile that never chose one", async () => {
    // An empty/absent accent is a profile written before accents existed and
    // still gets the default wash; `none` is a decision and does not.
    const { profileWashCss, ACCENT_NONE } = await import("@/lib/accents");
    expect(profileWashCss(undefined, true)).toBeDefined();
    expect(profileWashCss(ACCENT_NONE, true)).toBeUndefined();
  });
});

describe("profileSidebarWashCss", () => {
  it("paints nothing without profiles, or for a profile with no colour", async () => {
    const { profileSidebarWashCss, ACCENT_NONE } = await import("@/lib/accents");
    expect(profileSidebarWashCss("teal", false)).toBeUndefined();
    expect(profileSidebarWashCss(ACCENT_NONE, true)).toBeUndefined();
  });

  it("runs down from the bar, weaker than the bar, and ends above the task list", async () => {
    const a = await import("@/lib/accents");
    const css = a.profileSidebarWashCss("teal", true)!;
    expect(css).toContain("to bottom");
    expect(css).toContain(`${a.SIDEBAR_WASH_ALPHA_PERCENT}%, transparent) 0%`);
    expect(css).toContain(`transparent ${a.SIDEBAR_WASH_END_PERCENT}%`);
    expect(a.SIDEBAR_WASH_ALPHA_PERCENT).toBeLessThan(a.WASH_ALPHA_PERCENT);
    expect(a.SIDEBAR_WASH_END_PERCENT).toBeLessThanOrEqual(50);
  });

  it("takes a custom hex like the bar does", async () => {
    const { profileSidebarWashCss } = await import("@/lib/accents");
    expect(profileSidebarWashCss("#ff8800", true)).toContain("#ff8800");
  });
});
