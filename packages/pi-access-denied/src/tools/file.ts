import { paths } from "../paths.ts";
import type { ToolAdapter } from "./types.ts";

export const fileAdapter: ToolAdapter = {
  extract(input, cwd) {
    return typeof input.path === "string" ? [{ path: paths.target(input.path, cwd) }] : [];
  },
};
