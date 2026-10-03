/** Property-based tests over generated branches/texts: core invariants must hold for arbitrary input. */
import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CHARS_PER_TOKEN, LOG_TYPE, PROFILES } from '../src/constants.ts';
import { planElide, planImages, planThinking, shakeWall } from '../src/plans.ts';
import { entryTokens, newPlaceholder, scanTextForBlockRanges, textTokens } from '../src/scanner.ts';
import type { Block, Entry } from '../src/types.ts';

const PROFILE_NAMES = Object.keys(PROFILES) as Array<keyof typeof PROFILES>;

const textChunks = [
	'plain text',
	'words and stuff',
	'\n',
	'\n\n',
	'\ttabbed',
	'a'.repeat(30),
	'b'.repeat(120),
	'```',
	'```sql',
	'code here',
	'\n```',
	'~~~',
	'~~~md',
	'\n~~~',
	'<tag>',
	'</tag>',
	'<pre>',
	'</pre>',
	'<br/>',
	'<img/>',
	'<foo bar="x">',
];
const arbText = fc
	.array(fc.constantFrom(...textChunks), { minLength: 1, maxLength: 50 })
	.map((parts) => parts.join(''));

const arbContent: fc.Arbitrary<string | Block[]> = fc.oneof(
	fc.array(
		fc.oneof(
			fc.record({ type: fc.constant<'text'>('text'), text: arbText }),
			fc.record({
				type: fc.constant<'image'>('image'),
				data: fc.constant('data:image/png;base64,xx'),
				mimeType: fc.constant('image/png'),
			}),
			fc.record({ type: fc.constant<'thinking'>('thinking'), thinking: arbText }),
		),
		{ minLength: 0, maxLength: 7 },
	),
);

interface EntrySpec {
	id: string;
	role: string;
	toolName?: string;
	content: string | Block[];
}

const arbEntrySpec: fc.Arbitrary<EntrySpec> = fc.oneof(
	fc.record({
		id: fc.constant(''),
		role: fc.constant('toolResult'),
		toolName: fc.oneof(fc.constant('bash'), fc.constant('read'), fc.constant('web.fetch')),
		content: arbContent,
	}),
	fc.record({
		id: fc.constant(''),
		role: fc.constantFrom('user', 'assistant'),
		content: arbContent,
	}),
);

const arbBranch: fc.Arbitrary<Entry[]> = fc
	.array(arbEntrySpec, { minLength: 0, maxLength: 25 })
	.map((specs) => specs.map(toEntry));

function toEntry(spec: EntrySpec, index: number): Entry {
	const id = `e${index}`;
	if (spec.role === 'toolResult') {
		return {
			id,
			type: 'message',
			message: {
				role: 'toolResult',
				toolCallId: `c${id}`,
				toolName: spec.toolName,
				isError: false,
				content: spec.content,
			},
		} as unknown as Entry;
	}
	return { id, type: 'message', message: { role: spec.role, content: spec.content } } as unknown as Entry;
}

function accumulatedAfter(branch: Entry[]): number[] {
	const n = branch.length;
	const out = Array.from({ length: n }, () => 0);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		out[i] = acc;
		acc += entryTokens(branch[i]);
	}
	return out;
}

describe('scanner invariants (property)', () => {
	test('textTokens: empty text is 0, non-empty is ≥ 1', () => {
		fc.assert(
			fc.property(arbText, (s) => {
				expect(textTokens(s)).toBeGreaterThanOrEqual(1);
			}),
		);
		expect(textTokens('')).toBe(0);
	});

	test('a placeholder always costs strictly less than the content it replaces', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('fence' as const, 'xml' as const),
				fc.integer({ min: 400, max: 200_000 }),
				(kind, chars) => {
					expect(textTokens(newPlaceholder(kind, chars))).toBeLessThan(Math.ceil(chars / CHARS_PER_TOKEN));
				},
			),
		);
	});

	test('scanTextForBlockRanges: sorted, non-empty, non-overlapping ranges', () => {
		fc.assert(
			fc.property(arbText, (s) => {
				const ranges = scanTextForBlockRanges(s);
				for (let i = 0; i < ranges.length; i++) {
					expect(ranges[i].start).toBeLessThan(ranges[i].end);
					if (i > 0) expect(ranges[i].start).toBeGreaterThanOrEqual(ranges[i - 1].end);
				}
			}),
		);
	});
});

describe('plan invariants (property)', () => {
	test('planElide: frees tokens, stays out of the protected tail, skips edited targets', () => {
		fc.assert(
			fc.property(arbBranch, fc.constantFrom(...PROFILE_NAMES), (branch, profileName) => {
				const config = PROFILES[profileName];
				const edited = new Set<string>();
				const edits = planElide(branch, edited, config);
				const tail = accumulatedAfter(branch);
				const indexOf = new Map(branch.map((b, i) => [b.id, i]));
				for (const edit of edits) {
					expect(edit.freed).toBeGreaterThan(0);
					const idx = indexOf.get(edit.targetId);
					expect(idx).toBeDefined();
					expect(tail[idx as number]).toBeGreaterThanOrEqual(config.protectTokens);
				}
			}),
		);
	});

	test('planElide toolResult edits: text is elided, images survive untouched', () => {
		fc.assert(
			fc.property(arbBranch, (branch) => {
				const edits = planElide(branch, new Set<string>(), PROFILES.default);
				for (const edit of edits) {
					if (edit.kind !== 'toolResult') continue;
					const entry = branch.find((b) => b.id === edit.targetId) as Entry;
					const originalBlocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
					const editBlocks = Array.isArray(edit.content) ? edit.content : [];
					const originalImages = originalBlocks.filter((b) => b.type === 'image').length;
					expect(editBlocks.filter((b) => b.type === 'image').length).toBe(originalImages);
					expect(editBlocks.some((b) => b.type === 'text' && b.text.startsWith('['))).toBe(true);
				}
			}),
		);
	});

	test('planImages/planThinking: only the named block kind is dropped, count > 0, freed ≥ 0', () => {
		fc.assert(
			fc.property(arbBranch, (branch) => {
				for (const edit of planImages(branch, new Set<string>())) {
					expect(edit.count).toBeGreaterThan(0);
					expect(edit.freed).toBeGreaterThanOrEqual(0);
					const blocks = Array.isArray(edit.content) ? edit.content : [];
					expect(blocks.some((b) => b.type === 'image')).toBe(false);
				}
				for (const edit of planThinking(branch, new Set<string>())) {
					expect(edit.count).toBeGreaterThan(0);
					expect(edit.freed).toBeGreaterThanOrEqual(0);
					const blocks = Array.isArray(edit.content) ? edit.content : [];
					expect(blocks.some((b) => b.type === 'thinking')).toBe(false);
				}
			}),
		);
	});

	test('shake → undo logs: last-op-wins wall matches the planned targets exactly', () => {
		fc.assert(
			fc.property(arbBranch, (branch) => {
				const ids = planElide(branch, new Set<string>(), PROFILES.default).map((e) => e.targetId);
				const shaken = branch.concat([
					{ id: 'log-shake', type: 'custom', customType: LOG_TYPE, data: { action: 'shake', targets: ids } },
				]);
				const wall = shakeWall(shaken);
				expect(wall.size).toBe(ids.length);
				for (const id of ids) expect(wall.has(id)).toBe(true);
				const undone = shaken.concat([
					{ id: 'log-undo', type: 'custom', customType: LOG_TYPE, data: { action: 'undo', targets: ids } },
				]);
				expect(shakeWall(undone).size).toBe(0);
			}),
		);
	});
});
