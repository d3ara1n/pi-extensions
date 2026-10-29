import { extractBashTargetsDetailed } from "../bash-extract.ts";
import type { ToolAdapter } from "./types.ts";

export const bashAdapter: ToolAdapter = {
  label: "bash command",
  action: "may access",
  extract(input, cwd) {
    return typeof input.command === "string" ? extractBashTargetsDetailed(input.command, cwd) : [];
  },
};
