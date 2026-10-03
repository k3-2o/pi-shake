/** Undo-fidelity: byte-identical projection after restore; raw entries never mutate. Real SessionManager. */
import { describe, expect, test } from 'bun:test';
import { estimateTokens, SessionManager } from '@earendil-works/pi-coding-agent';
import { planElide, planImages } from '../src/plans.ts';

const BIG = 'z'.repeat(30000);

function sumTokens(messages: Array<{ role: string; content: unknown }>): number {
	return messages.reduce((sum, m) => sum + estimateTokens(m as never), 0);
}

describe('shake → undo round-trip fidelity (real SessionManager)', () => {
	test('projection after undo is byte-for-byte the pre-shake projection; tokens identical', () => {
		const sm = SessionManager.inMemory('/tmp');

		sm.appendMessage({ role: 'user', content: 'make the schema', timestamp: Date.now() });
		const asst1 = sm.appendMessage({
			role: 'assistant',
			content: [{ type: 'text', text: 'dump:\n```sql\n' + BIG + '\n```\nend' }],
			api: 'anthropic-messages',
			provider: 'anthropic',
			model: 'test',
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: 'end_turn',
			timestamp: Date.now(),
		});
		// tool result with text + image (image must survive elide and be restored exactly)
		const tool1 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c1',
			toolName: 'read',
			isError: false,
			content: [
				{ type: 'text', text: BIG },
				{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
			],
			timestamp: Date.now(),
		});
		const tool2 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c2',
			toolName: 'bash',
			isError: false,
			content: [{ type: 'text', text: BIG }],
			timestamp: Date.now(),
		});
		void tool2; // keeps t1 outside the protect window
		const tail = sm.appendMessage({ role: 'user', content: 'ok', timestamp: Date.now() });
		void tail;

		// baseline
		const before = sm.buildSessionProjection();
		const beforeJson = JSON.stringify(before.messages);
		const beforeTokens = sumTokens(before.messages);

		// guarded copies of the raw content (must stay untouched forever)
		const rawAsst1 = structuredClone(sm.getEntry(asst1)!.message.content);
		const rawTool1 = structuredClone(sm.getEntry(tool1)!.message.content);

		// shake
		const plan = planElide(sm.getBranch() as never[], new Set());
		expect(plan.length).toBeGreaterThan(0);
		for (const edit of plan) sm.appendContextEdit(edit.targetId, { content: edit.content });

		const shaken = sm.buildSessionProjection();
		expect(JSON.stringify(shaken.messages)).not.toBe(beforeJson); // model sees stickers now
		expect(sumTokens(shaken.messages)).toBeLessThan(beforeTokens); // genuinely lighter

		// freed claim sanity: for the toolResult edit, freed == est(raw) − est(sticker)
		const readEdit = plan.find((e) => e.targetId === tool1)!;
		expect(readEdit).toBeDefined();
		const stickerTokens = estimateTokens({
			role: 'toolResult',
			content: readEdit.content,
		} as never);
		const rawTokens = estimateTokens({ role: 'toolResult', content: rawTool1 } as never);
		expect(readEdit.freed).toBe(rawTokens - stickerTokens);

		// raw entries untouched
		expect(JSON.stringify(sm.getEntry(asst1)!.message.content)).toBe(JSON.stringify(rawAsst1));
		expect(JSON.stringify(sm.getEntry(tool1)!.message.content)).toBe(JSON.stringify(rawTool1));

		// undo
		for (const edit of plan) {
			const entry = sm.getEntry(edit.targetId)!;
			const content =
				entry.type === 'message'
					? (entry.message.content as string | Array<unknown>)
					: (entry.content as string | Array<unknown> | undefined);
			sm.appendContextEdit(edit.targetId, { content: content as never });
		}

		// after undo
		const after = sm.buildSessionProjection();
		expect(JSON.stringify(after.messages)).toBe(beforeJson); // byte-for-byte
		expect(after.messages).toHaveLength(before.messages.length);
		expect(sumTokens(after.messages)).toBe(beforeTokens); // token-identical
		expect(JSON.stringify(sm.getEntry(asst1)!.message.content)).toBe(JSON.stringify(rawAsst1));
		expect(JSON.stringify(sm.getEntry(tool1)!.message.content)).toBe(JSON.stringify(rawTool1));
	});

	test('the patch appends ONLY context_edit entries (no surprise writes to originals)', () => {
		const sm = SessionManager.inMemory('/tmp');
		sm.appendMessage({ role: 'user', content: 'x', timestamp: Date.now() });
		const t1 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c',
			toolName: 'bash',
			isError: false,
			content: [{ type: 'text', text: 'q'.repeat(20000) }],
			timestamp: Date.now(),
		});
		const t2 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c2',
			toolName: 'bash',
			isError: false,
			content: [{ type: 'text', text: 'q'.repeat(20000) }],
			timestamp: Date.now(),
		});
		const tail = sm.appendMessage({ role: 'user', content: 'tail', timestamp: Date.now() });
		void tail;

		const entriesBefore = sm.getEntries().length as number;
		const beforeShake = JSON.stringify(sm.getEntry(t1)!.message.content);

		const plan = planElide(sm.getBranch() as never[], new Set());
		expect(plan.map((e) => e.targetId)).toContain(t1);
		expect(plan.map((e) => e.targetId)).not.toContain(t2); // inside the protect window
		for (const edit of plan) sm.appendContextEdit(edit.targetId, { content: edit.content });

		const entriesAfterShake = sm.getEntries();
		const newEntries = entriesAfterShake.slice(entriesBefore);
		// every appended entry is exactly one context_edit for a plan target
		expect(newEntries).toHaveLength(plan.length);
		expect(newEntries.every((e) => e.type === 'context_edit')).toBe(true);
		expect(newEntries.map((e) => e.targetId).toSorted()).toEqual(plan.map((e) => e.targetId).toSorted());

		// original message content unchanged, and no stray entries of other types
		expect(JSON.stringify(sm.getEntry(t1)!.message.content)).toBe(beforeShake);
		expect(entriesAfterShake.filter((e) => e.type !== 'context_edit')).toHaveLength(entriesBefore);
	});

	test('images mode round-trips image blocks exactly', () => {
		const sm = SessionManager.inMemory('/tmp');
		const img = { type: 'image' as const, data: 'aGVsbG8=', mimeType: 'image/png' };
		const userMsg = sm.appendMessage({
			role: 'user',
			content: [{ type: 'text', text: 'look' }, img],
			timestamp: Date.now(),
		});
		const tail = sm.appendMessage({ role: 'user', content: 'done', timestamp: Date.now() });
		void tail;

		const before = JSON.stringify(sm.buildSessionProjection().messages);
		const raw = sm.getEntry(userMsg)!.message.content as Array<{ type: string }>;

		const plan = planImages(sm.getBranch() as never[], new Set());
		expect(plan.map((e) => e.targetId)).toContain(userMsg);
		for (const edit of plan) sm.appendContextEdit(edit.targetId, { content: edit.content });

		const shaken = sm.buildSessionProjection();
		expect(JSON.stringify(shaken.messages)).not.toBe(before);

		sm.appendContextEdit(userMsg, { content: raw as never });
		const restored = sm.buildSessionProjection();
		expect(JSON.stringify(restored.messages)).toBe(before);
		expect(sumTokens(restored.messages)).toBe(sumTokens(JSON.parse(before) as never[]));
	});
});
