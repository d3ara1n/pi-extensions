/**
 * Type definitions for pi-access-denied.
 */

/** Access control mode. */
export type AccessMode = "prompt" | "deny" | "allow";

/** Per-path session decision chosen from the authorization dialog. */
export type Decision = "allow-once" | "allow-always" | "deny-once" | "deny-always";

/**
 * Configuration stored under the `accessDenied` key in pi settings
 * (`~/.pi/agent/settings.json` globally, `.pi/settings.json` per project).
 * Project settings override global ones.
 */
export interface AccessDeniedConfig {
	/** Default mode on session start. Defaults to `"prompt"`. */
	mode: AccessMode;
	/**
	 * Extra absolute (or home-relative) directories to treat as in-bounds,
	 * in addition to the current project cwd.
	 */
	extraAllowedDirs: string[];
	/**
	 * Additional always-safe paths (e.g. log dirs) that never trigger a
	 * prompt. Use `extraAllowedDirs` for full read/write roots; this is a
	 * finer-grained escape hatch. Defaults to `[]`.
	 */
	extraSafePaths: string[];
	/** Built-in tools to gate. Defaults to `["write", "edit", "bash"]`. */
	tools: string[];
}

export const DEFAULT_CONFIG: AccessDeniedConfig = {
	mode: "prompt",
	extraAllowedDirs: [],
	extraSafePaths: [],
	tools: ["write", "edit", "bash"],
};
