import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { LOG_TYPE, MODES, PROFILES, SCOPE_NAMES, CHARS_PER_TOKEN } from './constants.ts';
import type { Mode, ProfileName, ScopeName } from './constants.ts';
import {
	activeEditTargets,
	describePlan,
	planElide,
	planImages,
	planThinking,
	rawContent,
	shakeLogs,
	shakeWall,
} from './plans.ts';
import { resolveProfileFromFiles, writeProfileToSettings } from './settings.ts';
import type { Entry, PlanEdit } from './types.ts';

interface SessionManagerWithEdits {
	appendContextEdit(targetId: string, replacement: { content: unknown } | null): string;
}

export interface ShakeLog {
	action: string;
	mode?: string;
	targets?: string[];
	freed?: number;
}

type ShakeCommand =
	| {
			mode: 'elide' | Mode;
			dryRun: boolean;
			allScopes?: boolean;
	  }
	| string;

function parseRequest(args: string): ShakeCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const dryRun = tokens.includes('dry-run');
	const verb = tokens.find((t) => t !== 'dry-run');
	const sub = tokens.find((t) => t !== verb && t !== 'dry-run');
	if (verb === undefined) return { mode: 'elide', dryRun, allScopes: true };
	if (dryRun && (verb === 'undo' || verb === 'profile' || verb === 'status')) {
		return `dry-run applies only to elide, thinking, or images, not ${verb}.`;
	}
	if (verb === 'undo') {
		if (sub !== undefined) return `Unknown /shake undo argument "${sub}". /shake undo restores everything.`;
		return { mode: 'undo', dryRun };
	}
	if ((MODES as readonly string[]).includes(verb)) {
		if (sub !== undefined) return `Unknown /shake argument "${sub}" after ${verb}.`;
		return { mode: verb as Mode, dryRun };
	}
	return `Unknown /shake mode "${verb}". Modes: ${[...MODES, 'dry-run'].join(', ')}; plain /shake elides.`;
}

/** Bare dry-run popup; undefined = cancelled (already notified). */
async function pickDryRunScope(ctx: ExtensionCommandContext): Promise<ScopeName | undefined> {
	const choice = await ctx.ui.select('Shake dry-run', [...SCOPE_NAMES]);
	if (choice === undefined) {
		ctx.ui.notify('Preview cancelled.', 'info');
		return undefined;
	}
	if ((SCOPE_NAMES as readonly string[]).includes(choice)) return choice as ScopeName;
	ctx.ui.notify('Preview cancelled.', 'info');
	return undefined;
}

/** A single throw (pi rejects non-editable targets) must not strand the rest outside undo's reach. */
function applyEdits(
	ctx: ExtensionCommandContext,
	edits: PlanEdit[],
	pi: ExtensionAPI,
): {
	appliedIds: string[];
	skipped: number;
	logFailed: boolean;
} {
	const sm = ctx.sessionManager as unknown as SessionManagerWithEdits;
	const appliedIds: string[] = [];
	let freed = 0;
	let skipped = 0;
	let logFailed = false;
	for (const edit of edits) {
		try {
			sm.appendContextEdit(edit.targetId, { content: edit.content });
			appliedIds.push(edit.targetId);
			freed += edit.freed;
		} catch {
			skipped++;
		}
	}
	if (appliedIds.length > 0) {
		try {
			pi.appendEntry(LOG_TYPE, {
				action: 'shake',
				mode: edits[0]?.kind === 'image' ? 'images' : edits[0]?.kind === 'thinking' ? 'thinking' : 'elide',
				targets: appliedIds,
				freed,
				at: Date.now(),
			});
		} catch {
			logFailed = true; // applied but undo cannot reach them
		}
	}
	return { appliedIds, skipped, logFailed };
}

export function buildStatusLines(input: {
	wallSize: number;
	profile: string;
	source: string;
	usage: { tokens: number; contextWindow: number; percent: number } | undefined;
	last: ShakeLog | undefined;
}): string[] {
	const { wallSize, profile, source, usage, last } = input;
	let lastLine = 'last:     no runs yet';
	if (last) {
		const kind = last.action === 'undo' ? 'undo' : last.mode === 'elide' ? 'elide' : (last.mode ?? 'shake');
		const count = last.targets?.length ?? 0;
		const noun = `${count} entr${count === 1 ? 'y' : 'ies'}`;
		const rest = last.action === 'undo' ? 'restored' : `~${(last.freed ?? 0).toLocaleString()} tokens freed`;
		lastLine = `last:     ${kind} · ${noun} · ${rest}`;
	}
	return [
		`wall:     ${wallSize} entr${wallSize === 1 ? 'y' : 'ies'} stuck`,
		`profile:  ${profile} (${source})`,
		`context:  ${usage != null ? `${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${Math.round(usage.percent)}%)` : 'unknown'}`,
		lastLine,
	];
}

export function createShakeCommandSpec(pi: ExtensionAPI): {
	description: string;
	getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }> | null;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
} {
	return {
		description: 'Drop heavy content from context (tool results, large blocks, images, thinking)',
		getArgumentCompletions: (prefix) => {
			const options = [...(MODES as readonly string[]), 'dry-run'];
			const filtered = options.filter((m) => m.startsWith(prefix.toLowerCase()));
			return filtered.length > 0 ? filtered.map((m) => ({ value: m, label: m })) : null;
		},
		handler: async (args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify('/shake is unavailable while streaming. Wait or abort first.', 'warning');
				return;
			}

			const parsed = parseRequest(args);
			if (typeof parsed === 'string') {
				ctx.ui.notify(parsed, 'warning');
				return;
			}
			const { mode, dryRun, allScopes } = parsed;

			const branch = ctx.sessionManager.getBranch() as unknown as Entry[];
			const editedTargets = activeEditTargets(branch);
			const { profile, source } = resolveProfileFromFiles();
			const config = PROFILES[profile];

			if (mode === 'profile') {
				const names = Object.keys(PROFILES) as ProfileName[];
				const valueColumn = Math.max(...names.map((n) => n.length)) + 4;
				const options = names.map((name) => {
					const tailTokens = PROFILES[name].protectTokens.toLocaleString('en-US');
					const blockTokens = (PROFILES[name].fenceMinChars / CHARS_PER_TOKEN).toLocaleString('en-US');
					const label = `${name}:${' '.repeat(valueColumn - name.length - 1)}tail ${tailTokens} tokens · blocks ≥ ~${blockTokens} tokens`;
					return { name, label };
				});
				const choice = await ctx.ui.select(
					`Shake profile (current: ${profile})`,
					options.map((o) => o.label),
				);
				if (choice === undefined) {
					ctx.ui.notify('Profile unchanged.', 'info');
					return;
				}
				const picked = options.find((o) => o.label === choice)?.name;
				if (picked === undefined) {
					ctx.ui.notify('Profile unchanged.', 'info');
					return;
				}
				const written = writeProfileToSettings(picked);
				if (written === undefined) {
					ctx.ui.notify('Could not write settings.json. Profile not saved.', 'warning');
					return;
				}
				ctx.ui.notify(`Shake profile → ${picked} (wrote ${written.tier} settings.json: ${written.path}).`, 'info');
				return;
			}

			if (mode === 'status') {
				const usageRaw = ctx.getContextUsage();
				// pi may report null usage (e.g. post-compaction); print "unknown", never a fake 0%.
				const usage =
					usageRaw == null || usageRaw.tokens === null || usageRaw.percent === null
						? undefined
						: {
								tokens: usageRaw.tokens,
								contextWindow: usageRaw.contextWindow,
								percent: usageRaw.percent,
							};
				const logs = shakeLogs(branch);
				ctx.ui.notify(
					buildStatusLines({
						wallSize: shakeWall(branch).size,
						profile,
						source,
						usage,
						last: logs[logs.length - 1],
					}).join('\n'),
					'info',
				);
				return;
			}

			if (mode === 'undo') {
				const wall = shakeWall(branch);
				const logs = shakeLogs(branch);
				const targets = new Set<string>();
				for (const log of logs) {
					if (log.action !== 'shake') continue;
					for (const t of log.targets ?? []) if (wall.has(String(t))) targets.add(String(t));
				}
				let skipped = 0;
				const restored: string[] = [];
				const sm = ctx.sessionManager as unknown as SessionManagerWithEdits;
				// Snapshot: appendContextEdit mutates the branch while we iterate.
				for (const entry of branch.slice()) {
					if (!targets.has(entry.id)) continue;
					const content = rawContent(entry);
					if (content === undefined) {
						skipped++;
						continue;
					}
					sm.appendContextEdit(entry.id, { content }); // last-wins overlay → exact restore
					restored.push(entry.id);
				}
				if (restored.length === 0) {
					const missing = targets.size - skipped;
					const divergence =
						missing > 0 ? ` (${missing} entr${missing === 1 ? 'y' : 'ies'} on the wall missing from this branch)` : '';
					ctx.ui.notify(
						skipped > 0
							? `Nothing to undo (${skipped} entr${skipped === 1 ? 'y' : 'ies'} with no stored content)${divergence}.`
							: `Nothing to undo${divergence}.`,
						'info',
					);
					return;
				}
				try {
					pi.appendEntry(LOG_TYPE, { action: 'undo', targets: restored, at: Date.now() });
				} catch {
					ctx.ui.notify(
						`Undid ${restored.length} context edit${restored.length === 1 ? '' : 's'}, restoring original content. WARNING: could not log the undo.`,
						'warning',
					);
					return;
				}
				const skipClause =
					skipped > 0 ? ` Skipped ${skipped} entr${skipped === 1 ? 'y' : 'ies'} with no stored content.` : '';
				ctx.ui.notify(
					`Undid ${restored.length} context edit${restored.length === 1 ? '' : 's'}, restoring original content.${skipClause}`,
					'info',
				);
				return;
			}

			const plan =
				mode === 'elide'
					? planElide(branch, editedTargets, config)
					: mode === 'images'
						? planImages(branch, editedTargets)
						: planThinking(branch, editedTargets);

			if (dryRun) {
				const target = allScopes ? await pickDryRunScope(ctx) : mode;
				if (target === undefined) return;

				// Rebuild for the chosen scope (bare form's `plan` is elide's).
				const scopedPlan =
					target === 'elide'
						? planElide(branch, editedTargets, config)
						: target === 'images'
							? planImages(branch, editedTargets)
							: planThinking(branch, editedTargets);

				if (scopedPlan.length === 0) {
					const nothing =
						target === 'images'
							? 'No images found in this session.'
							: target === 'thinking'
								? 'No thinking blocks found in this session.'
								: 'Nothing to shake.';
					ctx.ui.notify(nothing, 'info');
					return;
				}

				const described = describePlan(target, scopedPlan);
				const protectNote =
					target === 'elide' ? ` Protects the last ${config.protectTokens.toLocaleString()} tokens.` : '';
				const dryVerb =
					target === 'elide'
						? `Shook ${described.parts.join(' + ')} (~${described.freed.toLocaleString()} tokens).`
						: target === 'thinking'
							? `Dropped ${described.parts.join(' ')} (~${described.freed.toLocaleString()} tokens).`
							: `Dropped ${described.parts.join(' ')} from this session.`;
				ctx.ui.notify(`[dry-run] · ${dryVerb}${protectNote} Profile: ${profile} (${source}).`, 'info');
				return;
			}

			if (plan.length === 0) {
				const nothing =
					mode === 'images'
						? 'No images found in this session.'
						: mode === 'thinking'
							? 'No thinking blocks found in this session.'
							: 'Nothing to shake.';
				ctx.ui.notify(nothing, 'info');
				return;
			}

			// Wall size before this run (distinct stuck entries, not raw context_edit rows).
			const wallBeforeSize = shakeWall(branch).size;
			const { appliedIds, skipped, logFailed } = applyEdits(ctx, plan, pi);
			const wallAfterSize = new Set([...shakeWall(branch), ...appliedIds]).size;

			// Summaries count what actually applied, not what was planned.
			const appliedSet = new Set(appliedIds);
			const appliedDescribed = describePlan(
				mode,
				plan.filter((e) => appliedSet.has(e.targetId)),
			);

			let summary: string;
			if (appliedIds.length === 0) {
				summary = `Nothing applied${skipped > 0 ? ` (${skipped} skipped, not editable)` : ''}.`;
			} else if (mode === 'images') {
				summary = `Dropped ${appliedDescribed.parts.join(' ')} from this session.`;
			} else if (mode === 'thinking') {
				summary = `Dropped ${appliedDescribed.parts.join(' ')}${appliedDescribed.freed > 0 ? ` (~${appliedDescribed.freed.toLocaleString()} tokens freed)` : ''}.`;
			} else {
				summary = `Shook ${appliedDescribed.parts.join(' + ')} (~${appliedDescribed.freed.toLocaleString()} tokens freed).`;
			}

			const appendClause =
				wallBeforeSize > 0 && appliedIds.length > 0
					? ` Appended ${appliedIds.length} new context edit${appliedIds.length === 1 ? '' : 's'} to ${wallBeforeSize} shaken entr${wallBeforeSize === 1 ? 'y' : 'ies'} (${wallAfterSize} total in the wall).`
					: '';
			const skipClause = skipped > 0 ? ` ${skipped} skipped (not editable).` : '';
			const logNote = logFailed ? ' WARNING: could not log this run; undo may not cover it.' : '';
			// Teach the escape hatch once per branch (first shake only).
			const undoHint = wallBeforeSize === 0 && mode === 'elide' ? ' Run /shake undo to restore.' : '';
			ctx.ui.notify(`${summary}${appendClause}${skipClause}${logNote}${undoHint}`, 'info');
		},
	};
}
