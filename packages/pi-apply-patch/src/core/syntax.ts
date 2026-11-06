/** Canonical structural markers shared by normalization and parsing. @internal */
export const BEGIN = "*** Begin Patch";
export const END = "*** End Patch";
export const ADD = "*** Add File: ";
export const DELETE = "*** Delete File: ";
export const UPDATE = "*** Update File: ";
export const MOVE = "*** Move to: ";
export const EOF = "*** End of File";

/** @internal */
export function operationHeader(marker: string) {
  return (
    [
      [ADD, "add"],
      [DELETE, "delete"],
      [UPDATE, "update"],
    ] as const
  ).find(([prefix]) => marker.startsWith(prefix));
}
