import { getLatestCompactionEntry } from '@earendil-works/pi-coding-agent';
import { LOG_TYPE, PROFILES } from './constants.ts';
import {
	contentTokens,
	entryTokens,
	fmtTokens,
	isProtectedTool,
	newPlaceholder,
	scanTextForBlockRanges,
	textTokens,
	toolResultText,
} from './scanner.ts';
import type { Block, BlockRange, Entry, PlanEdit, ShakeConfig, ThinkingBlock } from './types.ts';

/** Last-op-wins over our logs; pi's own recovery targets stay off-limits forever. */
export function activeEditTargets(branch: Entry[]): Set<string> {
	const { stuck, shook } = shakeState(branch);
	for (const entry of branch) {
		if (entry.type === 'context_edit' && entry.targetId && !shook.has(entry.targetId)) {
			stuck.add(entry.targetId);
		}
	}
	return stuck;
}

/** Roles whose content pi allows us to overlay (`appendContextEdit` rejects others). */
const EDITABLE_ROLES = new Set(['user', 'assistant', 'toolResult']);

export function isEditableEntry(entry: Entry): boolean {
	return entry.type === 'custom_message' || (entry.type === 'message' && EDITABLE_ROLES.has(entry.message?.role ?? ''));
}

export function rawContent(entry: Entry): string | Block[] | undefined {
	if (entry.type === 'message' && entry.message) return entry.message.content as string | Block[];
	if (entry.type === 'custom_message') return entry.content as string | Block[] | undefined;
	return undefined;
}

/** First entry the model sees after compaction; missing kept-id → boundary = compaction index+1. */
export function compactionBoundaryIndex(branch: Entry[]): number {
	const latestCompaction = getLatestCompactionEntry(branch as never);
	if (!latestCompaction) return 0;
	const keptIndex = latestCompaction.firstKeptEntryId
		? branch.findIndex((e) => e.id === latestCompaction.firstKeptEntryId)
		: -1;
	if (keptIndex >= 0) return keptIndex;
	const compIndex = branch.findIndex((e) => e.id === latestCompaction.id);
	return compIndex >= 0 ? compIndex + 1 : 0;
}

export function planElide(
	branch: Entry[],
	editedTargets: Set<string>,
	config: ShakeConfig = PROFILES.default,
): PlanEdit[] {
	const n = branch.length;
	if (n === 0) return [];
	const accumulatedAfter = Array.from({ length: n }, () => 0);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		accumulatedAfter[i] = acc;
		acc += entryTokens(branch[i]);
	}

	const boundaryIndex = compactionBoundaryIndex(branch);

	const edits: PlanEdit[] = [];

	for (let i = 0; i < n; i++) {
		if (i < boundaryIndex) continue;
		if (accumulatedAfter[i] < config.protectTokens) continue;
		const entry = branch[i];
		if (editedTargets.has(entry.id)) continue;

		if (entry.type === 'message' && entry.message?.role === 'toolResult') {
			const message = entry.message;
			const toolName = typeof message.toolName === 'string' ? message.toolName : 'tool';
			if (isProtectedTool(toolName)) continue;
			const text = toolResultText(message);
			if (!text) continue;
			const blocksArr = Array.isArray(message.content) ? (message.content as Block[]) : [];
			const nonText = blocksArr.filter((b) => b.type !== 'text');
			const label = `tool result(${toolName})`;
			const placeholder = `[${toolName} output omitted (~${fmtTokens(text.tokens)} tokens)]`;
			const content: Block[] = [{ type: 'text', text: placeholder }, ...nonText];
			const freed = text.tokens - textTokens(placeholder);
			if (freed <= 0) continue;
			edits.push({ targetId: entry.id, kind: 'toolResult', label, content, freed, count: 1 });
			continue;
		}

		if (entry.type === 'message' || entry.type === 'custom_message') {
			if (!isEditableEntry(entry)) continue;
			const content = entry.type === 'message' ? (entry.message?.content as string | Block[]) : entry.content;
			if (content === undefined) continue;
			const label = entry.type === 'message' ? (entry.message?.role ?? 'message') : (entry.customType ?? 'custom');
			const perBlock: Array<{ blockIndex: number; ranges: BlockRange[] }> = [];

			if (typeof content === 'string') {
				const ranges = scanTextForBlockRanges(content).filter((r) => r.end - r.start >= config.fenceMinChars);
				if (ranges.length > 0) perBlock.push({ blockIndex: -1, ranges });
			} else {
				for (let bi = 0; bi < content.length; bi++) {
					const block = content[bi];
					if (block.type !== 'text') continue;
					const ranges = scanTextForBlockRanges(block.text).filter((r) => r.end - r.start >= config.fenceMinChars);
					if (ranges.length > 0) perBlock.push({ blockIndex: bi, ranges });
				}
			}
			if (perBlock.length === 0) continue;

			// Splice highest-start-first so earlier offsets stay valid.
			const before = contentTokens(entry, content);
			let rebuilt: string | Block[];
			if (typeof content === 'string') {
				let out = content;
				const ranges = perBlock[0].ranges;
				for (let r = ranges.length - 1; r >= 0; r--) {
					const range = ranges[r];
					out = out.slice(0, range.start) + newPlaceholder(range.kind, range.end - range.start) + out.slice(range.end);
				}
				rebuilt = out;
			} else {
				rebuilt = content.map((block, bi) => {
					if (block.type !== 'text') return block;
					const pb = perBlock.find((p) => p.blockIndex === bi);
					if (!pb) return block;
					let out = block.text;
					for (let r = pb.ranges.length - 1; r >= 0; r--) {
						const range = pb.ranges[r];
						out =
							out.slice(0, range.start) + newPlaceholder(range.kind, range.end - range.start) + out.slice(range.end);
					}
					return { type: 'text' as const, text: out };
				});
			}
			const after = contentTokens(entry, rebuilt);
			const freed = Math.max(0, before - after);
			if (freed <= 0) continue;
			const blockCount = perBlock.reduce((sum, p) => sum + p.ranges.length, 0);
			edits.push({
				targetId: entry.id,
				kind: 'block',
				label,
				content: rebuilt,
				freed,
				count: blockCount,
			});
		}
	}

	return edits;
}

export function planImages(branch: Entry[], editedTargets: Set<string>): PlanEdit[] {
	const edits: PlanEdit[] = [];
	const boundary = compactionBoundaryIndex(branch);
	for (let i = boundary; i < branch.length; i++) {
		const entry = branch[i];
		if (editedTargets.has(entry.id)) continue;
		const content = entry.type === 'message' ? (entry.message?.content as string | Block[] | undefined) : entry.content;
		if (content === undefined || typeof content === 'string') continue;
		if (!isEditableEntry(entry)) continue;
		const blocks = content as Block[];
		const images = blocks.filter((b) => b.type === 'image');
		if (images.length === 0) continue;
		let kept = blocks.filter((b) => b.type !== 'image');
		if (kept.length === 0) kept = [{ type: 'text', text: '[images omitted]' }]; // message must not vanish
		const before = contentTokens(entry, content);
		const after = contentTokens(entry, kept);
		edits.push({
			targetId: entry.id,
			kind: 'image',
			label: `${images.length} image${images.length === 1 ? '' : 's'}`,
			content: kept,
			freed: Math.max(0, before - after),
			count: images.length,
		});
	}
	return edits;
}

export function planThinking(branch: Entry[], editedTargets: Set<string>): PlanEdit[] {
	const edits: PlanEdit[] = [];
	const boundary = compactionBoundaryIndex(branch);
	for (let i = boundary; i < branch.length; i++) {
		const entry = branch[i];
		if (editedTargets.has(entry.id)) continue;
		if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;
		const content = entry.message.content;
		if (typeof content === 'string') continue;
		const blocks = content as Block[];
		const thinking = blocks.filter((b) => b.type === 'thinking') as ThinkingBlock[];
		if (thinking.length === 0) continue;
		let kept = blocks.filter((b) => b.type !== 'thinking');
		if (kept.length === 0) {
			const thinkingTokens = thinking.reduce((sum, b) => sum + textTokens(b.thinking), 0);
			kept = [{ type: 'text', text: `[reasoning omitted (~${fmtTokens(thinkingTokens)} tokens)]` }];
		}
		const before = contentTokens(entry, content);
		const after = contentTokens(entry, kept);
		edits.push({
			targetId: entry.id,
			kind: 'thinking',
			label: `${thinking.length} thinking block${thinking.length === 1 ? '' : 's'}`,
			content: kept,
			freed: Math.max(0, before - after),
			count: thinking.length,
		});
	}
	return edits;
}

export function describePlan(mode: string, plan: PlanEdit[]): { parts: string[]; freed: number } {
	const freed = plan.reduce((sum, e) => sum + e.freed, 0);
	if (mode === 'images') {
		const images = plan.reduce((sum, e) => sum + e.count, 0);
		return { parts: [`${images} image${images === 1 ? '' : 's'}`], freed };
	}
	if (mode === 'thinking') {
		const blocks = plan.reduce((sum, e) => sum + e.count, 0);
		return { parts: [`${blocks} thinking block${blocks === 1 ? '' : 's'}`], freed };
	}
	const toolResults = plan.filter((e) => e.kind === 'toolResult').length;
	const blocks = plan.reduce((sum, e) => (e.kind === 'block' ? sum + e.count : sum), 0);
	const parts: string[] = [];
	if (toolResults > 0) parts.push(`${toolResults} tool result${toolResults === 1 ? '' : 's'}`);
	if (blocks > 0) parts.push(`${blocks} block${blocks === 1 ? '' : 's'}`);
	return { parts, freed };
}

/** Targets currently stuck (shake adds, undo removes). */
export function shakeWall(branch: Entry[]): Set<string> {
	return shakeState(branch).stuck;
}

function shakeState(branch: Entry[]): { stuck: Set<string>; shook: Set<string> } {
	const stuck = new Set<string>();
	const shook = new Set<string>();
	for (const entry of branch) {
		if (entry.type !== 'custom' || entry.customType !== LOG_TYPE) continue;
		const log = entry.data as { action?: string; targets?: unknown } | undefined;
		if (!log || !Array.isArray(log.targets)) continue;
		for (const t of log.targets) {
			const id = String(t);
			if (log.action === 'shake') {
				stuck.add(id);
				shook.add(id);
			} else if (log.action === 'undo') {
				stuck.delete(id);
			}
		}
	}
	return { stuck, shook };
}

export function shakeLogs(
	branch: Entry[],
): Array<{ action: string; mode?: string; targets?: string[]; freed?: number }> {
	const logs: Array<{ action: string; mode?: string; targets?: string[]; freed?: number }> = [];
	for (const entry of branch) {
		if (entry.type === 'custom' && entry.customType === LOG_TYPE && entry.data && typeof entry.data === 'object') {
			logs.push(entry.data as { action: string; mode?: string; targets?: string[]; freed?: number });
		}
	}
	return logs;
}
