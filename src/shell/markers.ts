// src/shell/markers.ts — the single source of truth for "machine vs human" comment identity (#97).
// monastery stamps every comment/panel it writes with an HTML marker prefixed `<!--monastery-`
// (`-state` / `-spec` / `-endorse` / `-reply`). Human comments carry no marker. We discriminate by this
// marker, NOT by author: monastery often runs AS the repo owner, so its comments' author == the human
// owner and is not a reliable signal (#92). Trust-critical approval still rides on reactions, not markers.
export const MONASTERY_MARKER_PREFIX = "<!--monastery-";

/** True if the body carries any monastery marker (i.e. monastery authored it). */
export const isMonasteryComment = (body: string): boolean => body.includes(MONASTERY_MARKER_PREFIX);

/** True if the comment is human-authored (no monastery marker). */
export const isHumanComment = (c: { body: string }): boolean => !isMonasteryComment(c.body);

// #154: class-B markers — the small `<!--monastery-<name> k=v ...-->` tags monastery stamps on its own
// comments (reply / rework / impl-rejected). They used to be located by bare `body.includes(...)`, which
// misfires on field-value prefixes (`to=C_123` matched `to=C_1234`) and reads field VALUES by substring
// (`includes("committed=true")`). These helpers render/parse/locate them by EXACT field instead.
export type MarkerFields = Record<string, string | number>;

// The class-B marker names — named here so call sites never pass a bare string literal that could drift.
export const REPLY_MARKER = "reply";
export const REWORK_MARKER = "rework";
export const IMPL_REJECTED_MARKER = "impl-rejected";

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A marker is `<!--monastery-<name>` then optional whitespace-led `k=v` attrs, terminated by `-->`. The
// attrs group must START with whitespace (so `name` can't bleed into a longer name) and excludes `>` so it
// stops cleanly at the closing `-->` — `to=C_123-->` yields the value `C_123`, never `C_123--`.
const markerRe = (name: string): RegExp => new RegExp(`<!--monastery-${escapeRe(name)}(\\s[^>]*?)?-->`, "g");

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tok of attrs.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/** Render a class-B marker. Field values are stringified; `{}` yields a bare `<!--monastery-<name>-->`. */
export function renderMarker(name: string, fields: MarkerFields = {}): string {
  const attrs = Object.entries(fields).map(([k, v]) => ` ${k}=${v}`).join("");
  return `<!--monastery-${name}${attrs}-->`;
}

/** Every `<!--monastery-<name> ...-->` in `body`, each as its parsed `k=v` field record. */
export function parseMarkers(body: string, name: string): Record<string, string>[] {
  return [...body.matchAll(markerRe(name))].map((m) => parseAttrs(m[1] ?? ""));
}

/**
 * True if `body` carries a `<name>` marker. With `fields`, every given field must match EXACTLY (values
 * compared as strings) — so `to=C_123` no longer misfires on `to=C_1234`, and `committed` is read by field.
 */
export function hasMarker(body: string, name: string, fields?: MarkerFields): boolean {
  const want = fields && Object.entries(fields).map(([k, v]) => [k, String(v)] as const);
  return parseMarkers(body, name).some((got) => !want || want.every(([k, v]) => got[k] === v));
}
