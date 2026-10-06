// The shared accent palette: sidebar group folders and profiles (GH #280).
//
// Keys persist (localStorage for groups, profiles.json for profiles) and
// resolve to the `--color-palette-*` tokens in index.css @theme, so an accent
// stays correct across themes and a theme author can restyle every accent in
// the app at once. Storing the KEY rather than a literal hex is also what
// keeps profiles.json readable and keeps hex out of anything but @theme.
//
// An unknown stored key (hand-edited storage, a palette entry removed in a
// future version) resolves to undefined = default styling, never a crash.

export const ACCENTS: { key: string; label: string; css: string }[] = [
  { key: "red",    label: "Red",    css: "var(--color-palette-red)" },
  { key: "orange", label: "Orange", css: "var(--color-palette-orange)" },
  { key: "yellow", label: "Yellow", css: "var(--color-palette-yellow)" },
  { key: "green",  label: "Green",  css: "var(--color-palette-green)" },
  { key: "teal",   label: "Teal",   css: "var(--color-palette-teal)" },
  { key: "blue",   label: "Blue",   css: "var(--color-palette-blue)" },
  { key: "purple", label: "Purple", css: "var(--color-palette-purple)" },
  { key: "pink",   label: "Pink",   css: "var(--color-palette-pink)" },
];

export const accentCss = (key: string | undefined): string | undefined =>
  ACCENTS.find(c => c.key === key)?.css;

/** Is this stored accent a literal colour rather than a palette key?
 *
 *  Profiles may carry a hex the user picked, so the stored value is either a
 *  key from the table above or `#rgb` / `#rrggbb` / `#rrggbbaa`. Checked by
 *  shape rather than trusted: it is written straight into a `backgroundColor`,
 *  and a value that is neither has to fall back rather than paint nothing.
 *
 *  A user-chosen hex in `profiles.json` is DATA, not a hardcoded style, so it
 *  does not conflict with the rule against hex outside `@theme`: that rule is
 *  about the app's own colours, which still all come from tokens. */
export const isHexAccent = (v: string | undefined): boolean =>
  !!v && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v);

/** The stored value meaning "no colour at all".
 *
 *  A real choice, not the absence of one: someone running a single profile, or
 *  who finds the title-bar wash noisy, needs a way to say so, and an empty
 *  string would be indistinguishable from a profile written before accents
 *  existed (which should still get its default). */
export const ACCENT_NONE = "none";

/** Profiles always render SOMETHING in the dot (the row would jump if one
 *  entry had no dot), so they need a fallback where groups fall back to "no
 *  styling". `none` uses the same neutral, which is what makes it read as
 *  "no colour" rather than as a colour nobody would choose. */
export const PROFILE_ACCENT_FALLBACK = "var(--color-fg-faint)";
export const profileAccentCss = (key: string | undefined): string =>
  (isHexAccent(key) ? key : accentCss(key)) ?? PROFILE_ACCENT_FALLBACK;

/** How far across the title bar the accent wash reaches before it is gone. */
export const WASH_END_PERCENT = 35;
/** How strong the accent is at the very left edge.
 *
 *  Bracketed by eye against PyCharm, from both sides: 22 read as invisible
 *  beside it, 45 and then 30 both read as too much against the breadcrumb.
 *  This sits just above the floor, which is where it wanted to be: the wash is
 *  meant to be noticed peripherally, not looked at. */
export const WASH_ALPHA_PERCENT = 25;
/** ...and at the midpoint, so the falloff is a curve rather than a ramp. */
export const WASH_MID_PERCENT = 9;

/**
 * The profile's accent, washed in from the left edge of the title bar and gone
 * by the first third (GH #280).
 *
 * `undefined` when there is no profile to colour, which is the dormant install
 * and most users: the bar then renders exactly as it always did, with no
 * background image at all.
 *
 * A GRADIENT rather than a fill, and a weak one. The bar carries the
 * breadcrumb and the whole toolbar, so a solid accent behind them fights every
 * glyph on it; the fade also puts the colour where the eye already lands on a
 * window, next to the traffic lights. The prior art is JetBrains, which tints
 * this exact strip per project.
 *
 * `color-mix` rather than an 8-digit hex, because an accent can be either a
 * theme `var(...)` or a user-typed hex and only `color-mix` handles both
 * without parsing the colour ourselves.
 */
export const profileWashCss = (key: string | undefined, hasProfile: boolean): string | undefined => {
  if (!hasProfile) return undefined;
  // Opted OUT: no wash at all, not a grey one. A neutral gradient still reads
  // as a tint and still costs the breadcrumb contrast, which is the whole
  // thing the user asked to be rid of.
  if (key === ACCENT_NONE) return undefined;
  const c = profileAccentCss(key);
  // THREE stops, not two. A straight ramp to transparent reads as a smear;
  // holding most of the colour through the first quarter and then falling away
  // is what makes it read as a tint ON the bar, which is the effect JetBrains
  // gets. Measured against PyCharm side by side: the first version was too
  // faint to see at all next to it.
  return `linear-gradient(to right, `
    + `color-mix(in srgb, ${c} ${WASH_ALPHA_PERCENT}%, transparent) 0%, `
    + `color-mix(in srgb, ${c} ${WASH_MID_PERCENT}%, transparent) 25%, `
    + `transparent ${WASH_END_PERCENT}%)`;
};

/** Where the sidebar's wash starts, at its top edge. Lower than the bar's
 *  `WASH_ALPHA_PERCENT`: the bar's own wash has already fallen part of the way
 *  by the sidebar's middle, and this is the value that meets it there instead
 *  of drawing a brighter band under the bar. */
export const SIDEBAR_WASH_ALPHA_PERCENT = 16;
export const SIDEBAR_WASH_MID_PERCENT = 6;
/** Gone by here, measured down the sidebar. The nav and the first projects sit
 *  in the colour; the long task list below reads on the plain surface. */
export const SIDEBAR_WASH_END_PERCENT = 45;

/**
 * The bar's wash carried DOWN the sidebar, for people who want the profile's
 * colour on more than a 44px strip. Opt-in (`profileSidebarWash` in prefs):
 * the sidebar is a list of names read all day, and a tint under it is a taste,
 * not a default.
 *
 * The same shape as `profileWashCss` turned to run top to bottom, and the same
 * two refusals: nothing without profiles, nothing for a profile that opted out
 * of a colour.
 */
export const profileSidebarWashCss = (key: string | undefined, hasProfile: boolean): string | undefined => {
  if (!hasProfile || key === ACCENT_NONE) return undefined;
  const c = profileAccentCss(key);
  return `linear-gradient(to bottom, `
    + `color-mix(in srgb, ${c} ${SIDEBAR_WASH_ALPHA_PERCENT}%, transparent) 0%, `
    + `color-mix(in srgb, ${c} ${SIDEBAR_WASH_MID_PERCENT}%, transparent) 25%, `
    + `transparent ${SIDEBAR_WASH_END_PERCENT}%)`;
};
