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
