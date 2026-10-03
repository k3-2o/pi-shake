/** Pure-layer tests: scanner, plans, profiles, boundary. */
import { describe, expect, test } from 'bun:test';
import { PROFILES } from '../src/constants.ts';
import { activeEditTargets, planElide, planImages, planThinking } from '../src/plans.ts';
import { entryTokens, scanTextForBlockRanges } from '../src/scanner.ts';
import type { Entry } from '../src/types.ts';

const shakeLog = (id: string, action: string, targets: string[]): Entry => ({
	id,
	type: 'custom',
	customType: 'shake',
	data: { action, targets },
});

const compactionEntry = (id: string, firstKeptEntryId?: string) => ({
	id,
	type: 'compaction',
	parentId: 'e1',
	timestamp: new Date().toISOString(),
	summary: 'sum',
	firstKeptEntryId: firstKeptEntryId ?? null,
	tokensBefore: 1000,
});

const M = (id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) => ({
	id,
	type: 'message',
	message: { role, content, ...extra },
});

describe('scanTextForBlockRanges (scanner)', () => {
	test('finds complete fenced blocks', () => {
		const ranges = scanTextForBlockRanges('intro\n```ts\nconst a = 1;\n```\noutro\n~~~\nmore\n~~~');
		expect(ranges).toHaveLength(2);
		const text = 'intro\n```ts\nconst a = 1;\n```\noutro\n~~~\nmore\n~~~';
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('```ts\nconst a = 1;\n```');
		expect(text.slice(ranges[1].start, ranges[1].end)).toBe('~~~\nmore\n~~~');
		expect(ranges.every((r) => r.kind === 'fence')).toBe(true);
	});

	test('ignores unterminated fences and top-level XML inside fences', () => {
		const open = 'start\n```\nnever closed';
		expect(scanTextForBlockRanges(open)).toHaveLength(0);

		const fenceWithXml = 'a\n```\n<output>x</output>\n```\nb';
		expect(scanTextForBlockRanges(fenceWithXml)).toHaveLength(1); // only the fence
	});

	test('finds top-level XML spans and nests correctly', () => {
		const text = 'before\n<tool-result>\n<inner>deep</inner>\n</tool-result>\nafter';
		const ranges = scanTextForBlockRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('<tool-result>\n<inner>deep</inner>\n</tool-result>');
		expect(ranges[0].kind).toBe('xml');
	});

	test('unterminated XML yields nothing', () => {
		expect(scanTextForBlockRanges('x\n<open>\nnever closed\n')).toHaveLength(0);
	});

	test('uppercase tags are ignored (conservative)', () => {
		expect(scanTextForBlockRanges('<OUTPUT>\nbig\n</OUTPUT>')).toHaveLength(0);
	});

	test('self-closing tags (<br />) do not break a top-level span', () => {
		const text = 'before\n<output>\na\n<br />\nb\n</output>\nafter';
		const ranges = scanTextForBlockRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('<output>\na\n<br />\nb\n</output>');
	});

	test('a bare self-closing line yields no range', () => {
		expect(scanTextForBlockRanges('intro\n<br />\noutro')).toHaveLength(0);
	});

	test('CRLF text still detects spans and fences (N2)', () => {
		const xml = 'a\r\n<output>\r\nbig\r\n</output>\r\nb\r\n';
		const ranges = scanTextForBlockRanges(xml);
		expect(ranges).toHaveLength(1);
		expect(xml.slice(ranges[0].start, ranges[0].end)).toBe('<output>\r\nbig\r\n</output>\r');
		expect(scanTextForBlockRanges('```\r\ncode\r\n```\r\n')).toHaveLength(1);
	});

	test('fence closing must match the opening delimiter (N3)', () => {
		// ~~~ inside a ``` fence is content; the fence closes only on ```.
		expect(scanTextForBlockRanges('```\nline\n~~~\nmore\n```')).toHaveLength(1);
		// A mismatched closer never closes it: unclosed fence → nothing.
		expect(scanTextForBlockRanges('```\nline\n~~~')).toHaveLength(0);
		expect(scanTextForBlockRanges('~~~\nline\n```\n~~~')).toHaveLength(1);
	});

	test('a stray fence line inside a top-level XML span is content (N4)', () => {
		const text = '<output>\n```\nnot closed\n</output>';
		const ranges = scanTextForBlockRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.slice(ranges[0].start, ranges[0].end)).toBe('<output>\n```\nnot closed\n</output>');
	});

	test('void-element lines never open a span', () => {
		expect(scanTextForBlockRanges('intro\n<hr>\n<hr />\n<img src=x>')).toHaveLength(0);
	});
});

describe('entryTokens string-content normalization (N5)', () => {
	test('assistant string content weighs like block content', () => {
		const blocks = {
			id: 'b1',
			type: 'message',
			message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(10000) }] },
		};
		const legacy = { id: 's1', type: 'message', message: { role: 'assistant', content: 'x'.repeat(10000) } };
		expect(entryTokens(legacy as never)).toBe(entryTokens(blocks as never));
		expect(entryTokens(legacy as never)).toBeGreaterThan(0);
	});
});

describe('compaction boundary (F2)', () => {
	test('missing/pruned kept-id bounds the boundary at the compaction entry itself', () => {
		const big = M('e1', 'toolResult', [{ type: 'text', text: 'x'.repeat(20000) }], {
			toolCallId: 'c1',
			toolName: 'bash',
			isError: false,
		});
		const after = M('after', 'toolResult', [{ type: 'text', text: 'q'.repeat(20000) }], {
			toolCallId: 'c2',
			toolName: 'bash',
			isError: false,
		});
		const tail = M('t1', 'user', 'tail');

		// Null firstKeptEntryId: everything before the compaction is summarized away.
		const nullBranch = [big, compactionEntry('cmp1'), after, tail] as never[];
		expect(planElide(nullBranch, new Set()).find((e) => e.targetId === 'big')).toBeUndefined();
		expect(planElide(nullBranch, new Set()).map((e) => e.targetId)).not.toContain('after'); // after has only ~5k newer tokens < 4k tail

		// Pruned id (rewind/fork): same bound.
		const prunedBranch = [big, compactionEntry('cmp2', 'pruned-gone'), after, tail] as never[];
		expect(planElide(prunedBranch, new Set()).find((e) => e.targetId === 'big')).toBeUndefined();
	});
});

describe('planElide', () => {
	const bigTool = M('e1', 'toolResult', [{ type: 'text', text: 'x'.repeat(20000) }], {
		toolCallId: 'c1',
		toolName: 'bash',
		isError: false,
	});
	const bigToolWithImage = M(
		'e2',
		'toolResult',
		[
			{ type: 'text', text: 'y'.repeat(20000) },
			{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
		],
		{ toolCallId: 'c2', toolName: 'read', isError: false },
	);
	const fenceAssistant = M('e3', 'assistant', [
		{ type: 'text', text: 'here is a big block\n```json\n' + 'z'.repeat(20000) + '\n```\ndone' },
	]);
	const xmlUser = M('e4', 'user', 'some text\n<output>\n' + 'w'.repeat(20000) + '\n</output>\nmore');
	const recent = M('e5', 'user', 'recent small message');

	test('elides old tool results and large blocks, preserves images, protects tail', () => {
		const branch = [bigTool, bigToolWithImage, fenceAssistant, xmlUser, recent] as never[];
		const edits = planElide(branch, new Set());

		// Recent tail (e5) protected; earlier entries shaken.
		const ids = edits.map((e) => e.targetId);
		expect(ids).toContain('e1');
		expect(ids).toContain('e2');
		expect(ids).toContain('e3');
		expect(ids).not.toContain('e4'); // e4 sits inside the 4k protect window before the tail
		expect(ids).not.toContain('e5');

		const e2 = edits.find((e) => e.targetId === 'e2')!;
		expect(Array.isArray(e2.content)).toBe(true);
		const blocks = e2.content as Array<{ type: string }>;
		expect(blocks.some((b) => b.type === 'image')).toBe(true);
		expect((blocks[0] as { type: string; text: string }).text).toMatch(/^\[read output omitted \(~/);

		// Freed tokens are positive and bounded.
		for (const edit of edits) expect(edit.freed).toBeGreaterThan(100);

		const e3 = edits.find((e) => e.targetId === 'e3')!;
		const e3Text = (e3.content as Array<{ type: string; text: string }>)[0].text;
		expect(e3Text).toContain('[code block omitted (~');
		expect(e3Text).not.toContain('z'.repeat(100));
		expect(e3Text).toContain('here is a big block');
		expect(e3Text).toContain('done');
	});

	test('skips entries already carrying a context_edit', () => {
		const editEntry = {
			id: 'ce1',
			type: 'context_edit',
			targetId: 'e1',
			replacement: { content: 'x' },
		};
		const branch = [bigTool, recent, editEntry] as never[];
		const targets = activeEditTargets(branch);
		expect(targets.has('e1')).toBe(true);
		const edits = planElide(branch, targets);
		expect(edits.find((e) => e.targetId === 'e1')).toBeUndefined();
	});

	test('a target undone once and re-shaken is stuck again (no history leak)', () => {
		const stuck = activeEditTargets([
			shakeLog('l1', 'shake', ['e1']),
			shakeLog('l2', 'undo', ['e1']),
			shakeLog('l3', 'shake', ['e1']),
		] as never[]);
		expect(stuck.has('e1')).toBe(true);
		const unstuck = activeEditTargets([shakeLog('l1', 'shake', ['e1']), shakeLog('l2', 'undo', ['e1'])] as never[]);
		expect(unstuck.has('e1')).toBe(false);
	});

	test('context_edit targets we never shook (pi recovery) stay off-limits', () => {
		const branch = [{ id: 'rec1', type: 'context_edit', targetId: 'pi-target', replacement: null }] as never[];
		expect(activeEditTargets(branch).has('pi-target')).toBe(true);
	});

	test('skips entries summarized away before the latest compaction boundary', () => {
		const compaction = {
			id: 'cmp',
			type: 'compaction',
			parentId: 'e1',
			timestamp: new Date().toISOString(),
			summary: 'sum',
			firstKeptEntryId: 'recent',
			tokensBefore: 1000,
		};
		// e1 is before the kept boundary → skipped despite its size.
		const branch = [bigTool, compaction, recent] as never[];
		const edits = planElide(branch, new Set());
		expect(edits.find((e) => e.targetId === 'e1')).toBeUndefined();
	});

	test('images and thinking also skip the compaction boundary (no inert edits)', () => {
		const compaction = {
			id: 'cmp',
			type: 'compaction',
			parentId: 'e1',
			timestamp: new Date().toISOString(),
			summary: 'sum',
			firstKeptEntryId: 'recent',
			tokensBefore: 1000,
		};
		// An image and a thinking block, both BEFORE the kept boundary.
		const oldImage = M('old-img', 'user', [
			{ type: 'text', text: 'look' },
			{ type: 'image', data: 'aGk=', mimeType: 'image/png' },
		]);
		const oldThinking = M('old-think', 'assistant', [
			{ type: 'thinking', thinking: 'r'.repeat(800) },
			{ type: 'text', text: 'answer' },
		]);
		const recentMsg = M('recent', 'user', 'still visible');
		const branch = [oldImage, oldThinking, compaction, recentMsg] as never[];

		expect(planImages(branch, new Set()).find((e) => e.targetId === 'old-img')).toBeUndefined();
		expect(planThinking(branch, new Set()).find((e) => e.targetId === 'old-think')).toBeUndefined();

		// Sanity: without the compaction, both are found.
		expect(planImages([oldImage, recentMsg] as never[], new Set()).map((e) => e.targetId)).toContain('old-img');
		expect(planThinking([oldThinking, recentMsg] as never[], new Set()).map((e) => e.targetId)).toContain('old-think');
	});

	test('large XML blocks in user text are elided outside the protect window', () => {
		const xmlUserMsg = M('x1', 'user', 'some text\n<output>\n' + 'w'.repeat(20000) + '\n</output>\nmore');
		const filler1 = M('f1', 'toolResult', [{ type: 'text', text: 'q'.repeat(20000) }], {
			toolCallId: 'c',
			toolName: 'bash',
			isError: false,
		});
		const filler2 = M('f2', 'toolResult', [{ type: 'text', text: 'q'.repeat(20000) }], {
			toolCallId: 'c',
			toolName: 'bash',
			isError: false,
		});
		const tail = M('t1', 'user', 'tail');
		const edits = planElide([xmlUserMsg, filler1, filler2, tail] as never[], new Set());
		const edit = edits.find((e) => e.targetId === 'x1');
		expect(edit).toBeDefined();
		const text = edit.content as string;
		expect(text).toContain('[XML block omitted (');
		expect(text).not.toContain('w'.repeat(100));
		expect(text).toContain('some text');
		expect(text).toContain('more');
	});

	test('empty branch yields nothing', () => {
		expect(planElide([], new Set())).toHaveLength(0);
	});
});

describe('planImages', () => {
	const withImg = M('u1', 'user', [
		{ type: 'text', text: 'look' },
		{ type: 'image', data: 'aGk=', mimeType: 'image/png' },
	]);
	const toolImg = M('t1', 'toolResult', [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }], {
		toolCallId: 'c',
		toolName: 'read',
		isError: false,
	});
	const plain = M('p1', 'user', 'no images here');

	test('strips image blocks and marks purely-image messages', () => {
		const edits = planImages([withImg, toolImg, plain] as never[], new Set());
		expect(edits.map((e) => e.targetId).toSorted()).toEqual(['t1', 'u1']);
		const u1 = edits.find((e) => e.targetId === 'u1')!;
		expect(u1.content).toEqual([{ type: 'text', text: 'look' }]);
		const t1 = edits.find((e) => e.targetId === 't1')!;
		expect((t1.content as Array<{ type: string }>).every((b) => b.type !== 'image')).toBe(true);
		expect((t1.content as Array<{ type: string }>).some((b) => b.type === 'text')).toBe(true);
		expect(u1.count).toBe(1);
	});
});

describe('planThinking', () => {
	const thinking = M('a1', 'assistant', [
		{ type: 'thinking', thinking: 'internal reasoning '.repeat(200) },
		{ type: 'text', text: 'answer' },
	]);
	const withToolCall = M('a2', 'assistant', [
		{ type: 'thinking', thinking: 'r'.repeat(800) },
		{ type: 'toolCall', id: 'tc1', name: 'read', arguments: { path: 'x' } },
	]);
	const plain = M('a3', 'assistant', [{ type: 'text', text: 'no thinking' }]);

	test('drops thinking blocks, keeps tool calls and text', () => {
		const edits = planThinking([thinking, withToolCall, plain] as never[], new Set());
		expect(edits.map((e) => e.targetId).toSorted()).toEqual(['a1', 'a2']);
		const a1 = edits.find((e) => e.targetId === 'a1')!;
		expect((a1.content as Array<{ type: string }>).every((b) => b.type !== 'thinking')).toBe(true);
		const a2 = edits.find((e) => e.targetId === 'a2')!;
		expect((a2.content as Array<{ type: string }>).some((b) => b.type === 'toolCall')).toBe(true);
		expect(a1.count).toBe(1);
	});

	test('replaces a thinking-only message with a sizing reasoning sticker', () => {
		const onlyThinking = M('a4', 'assistant', [{ type: 'thinking', thinking: 'z'.repeat(500) }]);
		const edits = planThinking([onlyThinking] as never[], new Set());
		expect(edits).toHaveLength(1);
		expect((edits[0].content as Array<{ type: string; text: string }>)[0].text).toBe(
			'[reasoning omitted (~125 tokens)]',
		);
	});
});

describe('profiles', () => {
	test('aggressive folds more than default on the same branch', () => {
		const e1 = M('a1', 'toolResult', [{ type: 'text', text: 'x'.repeat(20000) }], {
			toolCallId: 'c',
			toolName: 'bash',
			isError: false,
		});
		const e2 = M('a2', 'toolResult', [{ type: 'text', text: 'y'.repeat(12000) }], {
			toolCallId: 'c',
			toolName: 'bash',
			isError: false,
		});
		const tail = M('a3', 'user', 'done');
		const branch = [e1, e2, tail] as never[];
		// Default: e1 has ~3,004 newer tokens (< 4,000) → protected.
		expect(planElide(branch, new Set())).toHaveLength(0);
		// Aggressive (tail 2,000): e1 is now eligible, e2 still protected.
		const aggressive = planElide(branch, new Set(), PROFILES.aggressive);
		expect(aggressive.map((e) => e.targetId)).toContain('a1');
		expect(aggressive.map((e) => e.targetId)).not.toContain('a2');
	});
});

describe('estimation sanity (matches pi chars/4 heuristic)', () => {
	test('freed for a tool result = text tokens - placeholder tokens', () => {
		const branch = [
			M('s0', 'toolResult', [{ type: 'text', text: 'z'.repeat(20000) }], {
				toolCallId: 'c0',
				toolName: 'bash',
				isError: false,
			}),
			M('s1', 'toolResult', [{ type: 'text', text: 'z'.repeat(20000) }], {
				toolCallId: 'c',
				toolName: 'bash',
				isError: false,
			}),
			M('s2', 'user', 'tail'),
		] as never[];
		const [edit] = planElide(branch, new Set());
		expect(edit).toBeDefined();
		expect(edit.targetId).toBe('s0');
		const content = edit.content as Array<{ type: string; text: string }>;
		const placeholder = content[0].text;
		expect(edit.freed).toBe(Math.ceil(20000 / 4) - Math.ceil(placeholder.length / 4));
		expect(Math.round(edit.freed)).toBeGreaterThan(4000);
	});
});
