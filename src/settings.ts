/** No extension settings-write API exists; the popup writes the file, shake reads it per invocation. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROFILES } from './constants.ts';
import type { ProfileName } from './constants.ts';

/** Test seam: redirect project/agent dirs to temp roots. */
let settingsRoots: { project: string; agent: string } | undefined;
export function setSettingsRoots(project: string, agent: string): void {
	settingsRoots = { project, agent };
}
export function clearSettingsRoots(): void {
	settingsRoots = undefined;
}

function settingsPaths(): { projectPath: string; globalPath: string } {
	if (settingsRoots) {
		return {
			projectPath: join(settingsRoots.project, 'settings.json'),
			globalPath: join(settingsRoots.agent, 'settings.json'),
		};
	}
	const cwd = process.cwd();
	const home = process.env.HOME ?? '';
	return {
		projectPath: join(cwd, '.pi', 'settings.json'),
		globalPath: join(home, '.pi', 'agent', 'settings.json'),
	};
}

/** Distinguish missing from unparseable so corrupt files surface instead of silently defaulting. */
function readJsonLoose(path: string): { data?: Record<string, unknown>; corrupt?: boolean } {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf-8').replace(/^\uFEFF/, ''));
		return parsed && typeof parsed === 'object' ? { data: parsed as Record<string, unknown> } : { corrupt: true };
	} catch {
		return { corrupt: true };
	}
}

/** Accept junk like "aggressive:" (trailing colon/space) as "aggressive". */
function normalizeProfile(value: unknown): ProfileName | undefined {
	if (typeof value !== 'string') return undefined;
	const cleaned = value.trim().replace(/:+$/, '');
	return cleaned in PROFILES ? (cleaned as ProfileName) : undefined;
}

export function resolveProfileFromFiles(): { profile: ProfileName; source: string } {
	const { projectPath, globalPath } = settingsPaths();
	for (const [path, label] of [
		[projectPath, 'settings.json (project)'],
		[globalPath, 'settings.json (agent-directory)'],
	] as const) {
		const { data, corrupt } = readJsonLoose(path);
		if (corrupt) return { profile: 'default', source: `default (${label} is not parseable JSON)` };
		if (data === undefined) continue;
		const rawProfile = (data as { shake?: { profile?: unknown } }).shake?.profile;
		if (rawProfile === undefined) continue;
		const p = normalizeProfile(rawProfile);
		if (p !== undefined) return { profile: p, source: label };
		return { profile: 'default', source: `default (invalid "${String(rawProfile)}" in ${label})` };
	}
	return { profile: 'default', source: 'default' };
}

/** Project settings if present, else agent-directory; merges, never clobbers an unparseable file. */
export function writeProfileToSettings(
	profile: ProfileName,
): { tier: 'project' | 'agent-directory'; path: string } | undefined {
	const { projectPath, globalPath } = settingsPaths();
	const target = existsSync(projectPath) ? projectPath : globalPath;
	const targetExists = existsSync(target);
	const { data, corrupt } = targetExists ? readJsonLoose(target) : {};
	if (corrupt || (targetExists && data === undefined)) return undefined;
	try {
		const current = data ?? {};
		const shake =
			typeof current.shake === 'object' && current.shake !== null && !Array.isArray(current.shake)
				? (current.shake as Record<string, unknown>)
				: {};
		current.shake = { ...shake, profile };
		const dir = dirname(target);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(target, JSON.stringify(current, null, 2) + '\n', 'utf-8');
		return { tier: target === projectPath ? 'project' : 'agent-directory', path: target };
	} catch {
		return undefined;
	}
}
