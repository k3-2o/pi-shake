/** pi's chars-per-token heuristic; kept single-sourced so displayed estimates never drift. */
export const CHARS_PER_TOKEN = 4;

export const PROFILES = {
	default: { protectTokens: 4_000, fenceMinChars: 400 * CHARS_PER_TOKEN },
	conservative: { protectTokens: 8_000, fenceMinChars: 800 * CHARS_PER_TOKEN },
	aggressive: { protectTokens: 2_000, fenceMinChars: 200 * CHARS_PER_TOKEN },
} as const;

export type ProfileName = keyof typeof PROFILES;

/** Guardrail: never user-configurable. */
export const PROTECTED_TOOL_PREFIXES = ['skill'];

export const MODES = ['elide', 'images', 'thinking', 'undo', 'status', 'profile'] as const;
export type Mode = (typeof MODES)[number];

export const SCOPE_NAMES = ['elide', 'thinking', 'images'] as const;
export type ScopeName = (typeof SCOPE_NAMES)[number];

/** Logs shake runs (context-invisible); drives wall/undo/status. */
export const LOG_TYPE = 'shake';
