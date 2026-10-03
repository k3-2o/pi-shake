/** Real SessionManager: overlay projection shrinks, undo restores, raw entries untouched. */
import { describe, expect, test } from 'bun:test';
import { buildSessionProjection, SessionManager } from '@earendil-works/pi-coding-agent';
import { planElide } from '../src/plans.ts';

function sqlText(n: number): string {
	return "SELECT '" + 'x'.repeat(n) + "';";
}

describe('real SessionManager integration', () => {
	test('appendContextEdit shrinks the projection; undo restores it; raw stays', () => {
		const sm = SessionManager.inMemory('/tmp');
		const user1 = sm.appendMessage({
			role: 'user',
			content: 'set up the schema',
			timestamp: Date.now(),
		});
		void user1;

		// Huge fenced block in an assistant reply.
		const asst1 = sm.appendMessage({
			role: 'assistant',
			content: [{ type: 'text', text: 'Here is the dump:\n```sql\n' + sqlText(30000) + "\n```\nThat's it" }],
			api: 'anthropic-messages',
			provider: 'anthropic',
			model: 'test',
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: 'end_turn',
			timestamp: Date.now(),
		});
		void asst1;

		// Huge tool result with an image block that must survive.
		const tool1 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'call_1',
			toolName: 'read',
			isError: false,
			content: [
				{ type: 'text', text: sqlText(30000) },
				{ type: 'image', data: 'aGk=', mimeType: 'image/png' },
			],
			timestamp: Date.now(),
		});

		// Another heavy result pushes the first two outside the protect window.
		const tool2 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'call_2',
			toolName: 'bash',
			isError: false,
			content: [{ type: 'text', text: sqlText(30000) }],
			timestamp: Date.now(),
		});
		void tool2;

		const tail = sm.appendMessage({ role: 'user', content: 'now what?', timestamp: Date.now() });
		void tail;

		const before = sm.buildSessionProjection();

		// shake
		const entries = sm.getBranch() as never[];
		const edits = planElide(entries, new Set());
		expect(edits.map((e) => e.targetId)).toContain(asst1);
		expect(edits.map((e) => e.targetId)).toContain(tool1);
		// tool2 sits inside the 4k protect window (only the tiny tail follows it).
		expect(edits.map((e) => e.targetId)).not.toContain(tool2);

		for (const edit of edits) {
			sm.appendContextEdit(edit.targetId, { content: edit.content });
		}
		const after = sm.buildSessionProjection();
		expect(after.messages).not.toBe(before.messages);

		// A: raw entries untouched — the original giant text is still stored.
		const rawTool1 = sm.getEntry(tool1)!.message.content as Array<{ type: string; text?: string }>;
		expect(rawTool1[0].text).toBe(sqlText(30000));
		expect(rawTool1.some((b) => b.type === 'image')).toBe(true);

		// B: projected messages shrink — placeholder present, image kept,
		//    and the giant text is gone from the *sent* context.
		const projTool1 = after.messages.find((m) => m.role === 'toolResult')!;
		const text = (projTool1.content as Array<{ type: string; text?: string }>)
			.filter((b) => b.type === 'text')
			.map((b) => b.text ?? '')
			.join('');
		expect(text).toMatch(/^\[read output omitted \(~/);
		expect(text).not.toContain('x'.repeat(1000));
		expect((projTool1.content as Array<{ type: string }>).some((b) => b.type === 'image')).toBe(true);

		const projBefore = before.messages.reduce((n, m) => n + JSON.stringify(m.content ?? '').length, 0);
		const projAfter = after.messages.reduce((n, m) => n + JSON.stringify(m.content ?? '').length, 0);
		expect(projAfter).toBeLessThan(projBefore);

		// C: undo restores the projection exactly (last edit wins), raw still pristine.
		sm.appendContextEdit(tool1, { content: rawTool1 });
		const restored = sm.buildSessionProjection();
		const restoredTool1 = restored.messages.find((m) => m.role === 'toolResult')!;
		expect(JSON.stringify(restoredTool1.content)).toBe(JSON.stringify(rawTool1));
	});

	test('edits to off-branch or non-editable targets are rejected by pi', () => {
		const sm = SessionManager.inMemory('/tmp');
		sm.appendMessage({ role: 'user', content: 'hi', timestamp: Date.now() });
		expect(() => sm.appendContextEdit('nope', null)).toThrow();
	});

	test('tree rewind: projecting at a pre-shake leaf returns the raw text', () => {
		const sm = SessionManager.inMemory('/tmp');
		sm.appendMessage({ role: 'user', content: 'go', timestamp: Date.now() });
		const tool1 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c1',
			toolName: 'read',
			isError: false,
			content: [{ type: 'text', text: 'o'.repeat(20000) }],
			timestamp: Date.now(),
		});
		const tool2 = sm.appendMessage({
			role: 'toolResult',
			toolCallId: 'c2',
			toolName: 'bash',
			isError: false,
			content: [{ type: 'text', text: 'p'.repeat(20000) }],
			timestamp: Date.now(),
		});
		void tool2; // pushes tool1 outside the protect window
		const tail = sm.appendMessage({ role: 'user', content: 'ok', timestamp: Date.now() });
		void tail;

		// The leaf id as it was BEFORE any shake: rewinding to here must show raw.
		const preShakeLeaf = sm.getLeafId();

		const edits = planElide(sm.getBranch() as never[], new Set());
		expect(edits.map((e) => e.targetId)).toContain(tool1);
		for (const edit of edits) sm.appendContextEdit(edit.targetId, { content: edit.content });

		// Current leaf: placeholder.
		const now = sm.buildSessionProjection();
		expect(
			(now.messages.find((m) => m.role === 'toolResult')!.content as Array<{ type: string; text?: string }>)[0].text ??
				'',
		).toMatch(/^\[read output omitted \(~/);

		// Rewound leaf (simulated /tree rewind to before the shake): raw text.
		const rewound = buildSessionProjection(sm.getEntries(), preShakeLeaf, (sm as any).byId);
		const rewoundTool = rewound.messages.find((m) => m.role === 'toolResult')!;
		expect((rewoundTool.content as Array<{ type: string; text?: string }>)[0].text).toBe('o'.repeat(20000));
	});
});
