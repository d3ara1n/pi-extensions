// Rust str::trim uses Unicode White_Space, which differs from JavaScript trim
// for U+0085 and U+FEFF. Preserve that distinction when matching source text.
/** @internal */
export const trimEnd = (text: string): string => text.replace(/\p{White_Space}+$/u, "");
/** @internal */
export const trim = (text: string): string => trimEnd(text.replace(/^\p{White_Space}+/u, ""));
