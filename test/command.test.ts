/** End-to-end wiring tests: modes, dry-run popup, undo, settings writes. */
import { describe, expect, test } from 'bun:test';
import shakeExtension from '../index.ts';
import { clearSettingsRoots, setSettingsRoots } from '../src/settings.ts';

function runCommand(handler: (args: string, ctx: any) => Promise<void>, ctx: any, args = ''): Promise<void> {
	return handler(args, ctx);
}

describe('command wiring', () => {
	test('elide → undo cycle', async () => {
		const branch: any[] = [
			{
				id: 'e1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			// A second heavy result after e1 pushes e1 outside the 4k protect window.
			{
				id: 'e1b',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1b',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e2',
				type: 'message',
				message: { role: 'user', content: 'tail', timestamp: Date.now() },
			},
		];
		// Real pi never mutates raw entries; the projection is derived. We track
		// "what the model would see" here and keep the raw branch pristine.
		const projected = new Map<string, unknown>();
		const edits: string[] = [];
		const logs: unknown[] = [];
		const notifs: string[] = [];

		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					projected.set(targetId, replacement.content);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
		};
		const pi = {
			registerCommand: (name: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				if (name !== 'shake') throw new Error('expected /shake');
				void opts;
			},
			appendEntry: (customType: string, data: unknown) => {
				logs.push({ customType, data });
				branch.push({ id: `log-${logs.length}`, type: 'custom', customType, data });
			},
			getSettings: () => ({}),
		} as any;

		// Capture the registered handler.
		let capturedHandler: ((a: string, c: any) => Promise<void>) | null = null;
		pi.registerCommand = (name: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
			if (name === 'shake') capturedHandler = opts.handler;
		};
		shakeExtension(pi);
		expect(capturedHandler).toBeDefined();

		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toEqual(['e1']);
		expect((projected.get('e1') as Array<{ type: string; text: string }>)[0].text).toMatch(
			/^\[bash output omitted \(~/,
		);
		expect(notifs.some((n) => n.includes('Shook 1 tool result'))).toBe(true);

		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toHaveLength(1);
		expect(notifs.some((n) => n.includes('Nothing to shake'))).toBe(true);

		await runCommand(capturedHandler!, ctx, 'status');
		expect(notifs.some((n) => n.includes('wall:     1 entry stuck'))).toBe(true);
		expect(notifs.some((n) => n.includes('context:  5,000 / 200,000'))).toBe(true);

		await runCommand(capturedHandler!, ctx, 'undo');
		const e1Raw = branch.find((e) => e.id === 'e1')!;
		expect((e1Raw.message.content[0] as { type: string; text: string }).text).toBe('o'.repeat(20000)); // raw untouched
		expect(projected.get('e1')).toEqual([{ type: 'text', text: 'o'.repeat(20000) }]); // restored
		expect(edits).toHaveLength(2);
		expect(notifs.some((n) => n.includes('Undid 1 context edit'))).toBe(true);

		await runCommand(capturedHandler!, ctx, 'undo');
		expect(edits).toHaveLength(2);
		expect(notifs[notifs.length - 1]).toContain('Nothing to undo.');

		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toHaveLength(3); // shaken again
		// After undo cleared the wall, the re-shake starts fresh (no append count).
		const lastNotif = notifs[notifs.length - 1];
		expect(lastNotif.includes('Shook 1 tool result')).toBe(true);
		expect(lastNotif.includes('Appended')).toBe(false);
		expect(lastNotif.includes('Run /shake undo')).toBe(true);

		// A third shake right after must be a no-op: the re-stick put e1 in the wall again.
		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toHaveLength(3);
		expect(notifs[notifs.length - 1]).toContain('Nothing to shake');
	});

	test('repeat shake with a persistent wall reports appending to it', async () => {
		const branch: any[] = [
			{
				id: 'e1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e1b',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1b',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e2',
				type: 'message',
				message: { role: 'user', content: 'tail', timestamp: Date.now() },
			},
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
		};
		const pi = {
			registerCommand: () => undefined,
			appendEntry: (customType: string, data: unknown) => {
				branch.push({ id: `log-${edits.length}`, type: 'custom', customType, data });
			},
			getSettings: () => ({}),
		} as any;
		let capturedHandler: ((a: string, c: any) => Promise<void>) | null = null;
		pi.registerCommand = (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
			capturedHandler = opts.handler;
		};
		shakeExtension(pi);

		// First shake: e1 is old enough; e1b sits right below the 4k window.
		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toEqual(['e1']);

		// Simulate a turn: enough heavy content to push e1b above the threshold,
		// while e3/e4 stay inside the protected window (sizes chosen accordingly:
		// e4+tail < 4000 est tokens, but e3+e4+tail >= 4000).
		branch.push(
			{
				id: 'e3',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c3',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(12000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e4',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c4',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(5000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 't2',
				type: 'message',
				message: { role: 'user', content: 'tail', timestamp: Date.now() },
			},
		);

		await runCommand(capturedHandler!, ctx, '');
		expect(edits).toEqual(['e1', 'e1b']);
		const lastNotif = notifs[notifs.length - 1];
		expect(lastNotif.includes('Appended 1 new context edit to 1 shaken entry (2 total in the wall)')).toBe(true);
		expect(lastNotif.includes('Run /shake undo')).toBe(false); // hint only when the wall is new
	});

	test('refuses while streaming', async () => {
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
		} as any;
		shakeExtension(pi);
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => false,
			ui: { notify: (m: string, t?: string) => notifs.push(`${t ?? 'info'}: ${m}`) },
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => undefined,
		};
		await runCommand(handler!, ctx);
		expect(notifs[0]).toContain('unavailable while streaming');
	});

	test('unknown mode warns', async () => {
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			getSettings: () => ({}),
		} as any;
		shakeExtension(pi);
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => undefined,
		};
		await runCommand(handler!, ctx, 'bogus');
		expect(notifs[0]).toContain('Unknown /shake mode');
	});

	test('/shake elide is valid and does exactly what plain /shake does', async () => {
		const branch: any[] = [
			{
				id: 'e1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e1b',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1b',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e2', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: () => undefined,
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, 'elide');
		expect(edits).toEqual(['e1']);
		expect(notifs.some((n) => n.includes('Shook 1 tool result'))).toBe(true);
	});

	test('dry-run previews the present state and applies nothing', async () => {
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		const branch: any[] = [
			{
				id: 'e1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e1b',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c1b',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'o'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e2',
				type: 'message',
				message: { role: 'user', content: 'tail', timestamp: Date.now() },
			},
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: {
				notify: (m: string) => notifs.push(m),
				select: async () => 'elide', // bare dry-run pops the scope menu → pick elide
			},
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: () => undefined,
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, 'dry-run');
		expect(edits).toHaveLength(0); // nothing applied
		const lastNotif = notifs[notifs.length - 1];
		expect(lastNotif.includes('[dry-run]')).toBe(true);
		expect(lastNotif.includes('Shook 1 tool result (~4,99')).toBe(true);
		expect(lastNotif.includes('Profile: default (default)')).toBe(true);

		await runCommand(handler!, ctx, '');
		expect(edits).toHaveLength(1);
		clearSettingsRoots();
		rmSync(project, { recursive: true, force: true });
		rmSync(agent, { recursive: true, force: true });
	});

	test('dry-run works per mode too (images dry-run)', async () => {
		const branch: any[] = [
			{
				id: 'i1',
				type: 'message',
				message: {
					role: 'user',
					content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'e2',
				type: 'message',
				message: { role: 'user', content: 'tail', timestamp: Date.now() },
			},
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: () => undefined,
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, 'images dry-run');
		expect(edits).toHaveLength(0);
		const lastNotif = notifs[notifs.length - 1];
		expect(lastNotif.includes('Dropped 1 image from this session.')).toBe(true);

		await runCommand(handler!, ctx, 'dry-run images');
		expect(edits).toHaveLength(0);
		expect(notifs[notifs.length - 1].includes('Dropped 1 image from this session.')).toBe(true);
	});

	test('bare dry-run opens the scope popup and previews the chosen scope', async () => {
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent); // hermetic: default profile, no real files
		try {
			const branch: any[] = [
				{
					id: 't1',
					type: 'message',
					message: {
						role: 'toolResult',
						toolCallId: 'c',
						toolName: 'bash',
						isError: false,
						content: [{ type: 'text', text: 'q'.repeat(20000) }],
						timestamp: Date.now(),
					},
				},
				{
					id: 'f1',
					type: 'message',
					message: {
						role: 'toolResult',
						toolCallId: 'c1',
						toolName: 'bash',
						isError: false,
						content: [{ type: 'text', text: 'q'.repeat(20000) }],
						timestamp: Date.now(),
					},
				},
				{
					id: 'f2',
					type: 'message',
					message: {
						role: 'toolResult',
						toolCallId: 'c2',
						toolName: 'bash',
						isError: false,
						content: [{ type: 'text', text: 'q'.repeat(20000) }],
						timestamp: Date.now(),
					},
				},
				{
					id: 'f3',
					type: 'message',
					message: {
						role: 'toolResult',
						toolCallId: 'c3',
						toolName: 'bash',
						isError: false,
						content: [{ type: 'text', text: 'q'.repeat(20000) }],
						timestamp: Date.now(),
					},
				},
				{
					id: 'img1',
					type: 'message',
					message: {
						role: 'user',
						content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
						timestamp: Date.now(),
					},
				},
				{
					id: 'th1',
					type: 'message',
					message: {
						role: 'assistant',
						content: [
							{ type: 'thinking', thinking: 'r'.repeat(500) },
							{ type: 'text', text: 'ok' },
						],
						timestamp: Date.now(),
					},
				},
				{ id: 'e9', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
			];
			const edits: string[] = [];
			const notifs: string[] = [];
			const selected: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async (title: string, opts: string[]) => {
						selected.push(title, ...opts);
						return 'thinking';
					},
				},
				sessionManager: {
					getBranch: () => branch,
					appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
						edits.push(targetId);
						branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
						return `ce-${edits.length}`;
					},
				},
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'dry-run');
			expect(edits).toHaveLength(0); // nothing applied
			// popup was shown with the three bare scope words
			expect(selected).toEqual(['Shake dry-run', 'elide', 'thinking', 'images']);
			const lastNotif = notifs[notifs.length - 1];
			expect(lastNotif.includes('[dry-run]')).toBe(true);
			expect(lastNotif.includes('Dropped 1 thinking block (~125 tokens)')).toBe(true);
			expect(lastNotif.includes('would elide')).toBe(false); // not all three anymore
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('bare dry-run cancelled popup notifies and applies nothing', async () => {
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			const branch: any[] = [
				{ id: 'e9', type: 'message', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
			];
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => undefined, // Esc / cancel
				},
				sessionManager: { getBranch: () => branch },
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'dry-run');
			expect(notifs[notifs.length - 1]).toContain('Preview cancelled.');
			expect(notifs.some((n) => n.includes('Shook'))).toBe(false);
			expect(notifs.some((n) => n.includes('Dropped'))).toBe(false);
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('undo restores everything, all scopes, in one command', async () => {
		const branch: any[] = [
			{
				id: 'img1',
				type: 'message',
				message: {
					role: 'user',
					content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'thk1',
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'r'.repeat(100) },
						{ type: 'text', text: 'ok' },
					],
					timestamp: Date.now(),
				},
			},
			{
				id: 't1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 't2',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c2',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e2', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: (customType: string, data: unknown) => {
				branch.push({ id: `log-${edits.length}`, type: 'custom', customType, data });
			},
		} as any;
		shakeExtension(pi);

		// strip all three scopes
		await runCommand(handler!, ctx, 'elide');
		await runCommand(handler!, ctx, 'images');
		await runCommand(handler!, ctx, 'thinking');
		expect(edits).toEqual(['t1', 'img1', 'thk1']);

		// one bare undo restores everything (order irrelevant — set semantics)
		await runCommand(handler!, ctx, 'undo');
		expect([...edits].toSorted()).toEqual(['img1', 'img1', 't1', 't1', 'thk1', 'thk1']);
		expect(notifs[notifs.length - 1].includes('Undid 3 context edits')).toBe(true);

		// repeat undo is a no-op (idempotent)
		await runCommand(handler!, ctx, 'undo');
		expect(edits).toHaveLength(6);
		expect(notifs[notifs.length - 1]).toContain('Nothing to undo.');
	});

	test('undo rejects any argument', async () => {
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
		} as any;
		shakeExtension(pi);
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => undefined,
		};
		await runCommand(handler!, ctx, 'undo bogus');
		expect(notifs[0]).toContain('Unknown /shake undo argument');
	});

	test('profile popup writes the project settings.json, preserving other keys', async () => {
		const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			// Project file exists with other settings → popup must MERGE into it.
			const projectFile = join(project, 'settings.json');
			writeFileSync(projectFile, JSON.stringify({ theme: 'dark' }));

			const branch: any[] = [];
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => 'aggressive:     tail 2,000 tokens · blocks ≥ ~200 tokens',
				},
				sessionManager: { getBranch: () => branch },
				getContextUsage: () => ({ tokens: 5000, contextWindow: 200000, percent: 2.5 }),
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'profile');
			expect(notifs.some((n) => n.includes('wrote project settings.json'))).toBe(true);

			const written = JSON.parse(readFileSync(projectFile, 'utf-8')) as {
				theme?: string;
				shake?: { profile?: string };
			};
			expect(written.theme).toBe('dark'); // preserved
			expect(written.shake?.profile).toBe('aggressive');

			await runCommand(handler!, ctx, 'status');
			expect(notifs.some((n) => n.includes('profile:  aggressive (settings.json (project))'))).toBe(true);
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('profile popup falls back to agent-directory settings.json when no project file', async () => {
		const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			const branch: any[] = [];
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => 'conservative:   tail 8,000 tokens · blocks ≥ ~800 tokens',
				},
				sessionManager: { getBranch: () => branch },
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'profile');
			expect(notifs.some((n) => n.includes('wrote agent-directory settings.json'))).toBe(true);
			const agentFile = join(agent, 'settings.json');
			expect(existsSync(agentFile)).toBe(true);
			const written = JSON.parse(readFileSync(agentFile, 'utf-8')) as {
				shake?: { profile?: string };
			};
			expect(written.shake?.profile).toBe('conservative');

			await runCommand(handler!, ctx, 'status');
			expect(notifs.some((n) => n.includes('profile:  conservative (settings.json (agent-directory))'))).toBe(true);
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('never clobbers an unparseable settings file (fail-fast at the boundary)', async () => {
		const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			const projectFile = join(project, 'settings.json');
			const corrupt = '{ THIS IS NOT VALID JSON !!! }\n';
			writeFileSync(projectFile, corrupt);

			const branch: any[] = [];
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: {
					notify: (m: string) => notifs.push(m),
					select: async () => 'aggressive:     tail 2,000 tokens · blocks ≥ ~200 tokens',
				},
				sessionManager: { getBranch: () => branch },
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'profile');
			expect(notifs.some((n) => n.includes('Could not write settings.json. Profile not saved.'))).toBe(true);
			expect(readFileSync(projectFile, 'utf-8')).toBe(corrupt); // untouched
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});
});

const makeShakeSpec = (branch: any[]) => {
	let spec: any = null;
	const pi: any = {
		registerCommand: (_n: string, opts: any) => (spec = opts),
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ id: `log-${branch.length}`, type: 'custom', customType, data });
		},
	};
	shakeExtension(pi);
	return { spec, pi };
};

describe('elide scope + scoped autocomplete', () => {
	test('bare undo restores elide + thinking edits together', async () => {
		const branch: any[] = [
			{
				id: 't1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 'th1',
				type: 'message',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: 'r'.repeat(100) },
						{ type: 'text', text: 'ok' },
					],
					timestamp: Date.now(),
				},
			},
			{
				id: 't2',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c2',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		const { spec } = makeShakeSpec(branch);
		const h = spec.handler.bind(spec);

		await h('elide', ctx); // elides t1 (t2 sits in the protect window)
		await h('thinking', ctx); // strips th1
		expect(edits).toEqual(['t1', 'th1']);

		await h('undo', ctx);
		expect(edits).toEqual(['t1', 'th1', 't1', 'th1']); // both restored by bare undo
		expect(notifs[notifs.length - 1].includes('Undid 2 context edits')).toBe(true);

		await h('undo elide', ctx);
		expect(edits).toHaveLength(4); // no new edits
		expect(notifs[notifs.length - 1]).toContain('Unknown /shake undo argument');
	});

	test('autocomplete is the plain flat list everywhere — no scoped logic', () => {
		const { spec } = makeShakeSpec([]);
		const comp = (p: string) => spec.getArgumentCompletions(p)?.map((c: any) => c.value) ?? null;
		expect(comp('')).toEqual(['elide', 'images', 'thinking', 'undo', 'status', 'profile', 'dry-run']);
		expect(comp('im')).toEqual(['images']);
		expect(comp('images ')).toBeNull(); // completed mode is terminal
		expect(comp('dry-run ')).toBeNull();
		expect(comp('undo ')).toBeNull();
	});

	test('F1: a mid-apply throw strands nothing: survivors logged, skipped reported', async () => {
		const branch: any[] = [
			{
				id: 't1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 't2',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c2',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 't3',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c3',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				// Simulate pi rejecting t2 mid-apply.
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					if (targetId === 't2') throw new Error('not editable');
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const logTargets: string[][] = [];
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: (customType: string, data: any) => {
				if (customType === 'shake') logTargets.push(data.targets);
				branch.push({ id: `log-${branch.length}`, type: 'custom', customType, data });
			},
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, '');

		// t1 applied, t2 skipped (t3 sits inside the protect window, never planned).
		expect(edits).toEqual(['t1']);
		// The log contains only what applied, so undo can reach it.
		expect(logTargets).toEqual([['t1']]);
		expect(notifs.some((n) => n.includes('Shook 1 tool result'))).toBe(true);
		expect(notifs.some((n) => n.includes('1 skipped (not editable)'))).toBe(true);

		await runCommand(handler!, ctx, 'undo');
		expect(edits).toEqual(['t1', 't1']); // the survivor is restored
	});

	test('F3: dry-run is rejected for undo and profile', async () => {
		const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			const branch: any[] = [
				{ id: 'e9', type: 'message', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
			];
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: { notify: (m: string) => notifs.push(m) },
				sessionManager: { getBranch: () => branch },
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'undo dry-run');
			expect(notifs[0]).toContain('dry-run applies only to elide, thinking, or images');
			await runCommand(handler!, ctx, 'profile dry-run');
			expect(notifs[1]).toContain('dry-run applies only to elide, thinking, or images');
			expect(existsSync(join(agent, 'settings.json'))).toBe(false); // nothing written
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('F9: undo reports targets with no stored content', async () => {
		const branch: any[] = [
			{ id: 'ghost', type: 'message' }, // no message content at all
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
		];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: () => 'ce-1',
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: (customType: string, data: any) => {
				branch.push({ id: `log-${branch.length}`, type: 'custom', customType, data });
			},
		} as any;
		shakeExtension(pi);

		// Put 'ghost' in the wall directly (simulates a past shake of a then-contentful entry).
		const logs: any[] = [];
		pi.appendEntry = (customType: string, data: any) => {
			logs.push({ customType, data });
			branch.push({ id: `log-${branch.length}`, type: 'custom', customType, data });
		};
		await runCommand(handler!, ctx, ''); // smoke: no crash on empty plan
		pi.appendEntry('shake', { action: 'shake', mode: 'elide', targets: ['ghost'], freed: 300, at: Date.now() });

		await runCommand(handler!, ctx, 'undo');
		expect(notifs[notifs.length - 1]).toContain('1 entry with no stored content');
	});

	test('F4: corrupt settings file is surfaced, not silently ignored', async () => {
		const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			writeFileSync(join(project, 'settings.json'), '{ NOT VALID }');
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: { notify: (m: string) => notifs.push(m) },
				sessionManager: { getBranch: () => [] },
				getContextUsage: () => undefined,
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'status');
			expect(notifs[notifs.length - 1]).toContain('is not parseable JSON');
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});
});

describe('N-series regression fixes', () => {
	test('N1: status prints unknown when usage is null (right after compaction)', async () => {
		const { mkdtempSync, rmSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const project = mkdtempSync(join(tmpdir(), 'shake-proj-'));
		const agent = mkdtempSync(join(tmpdir(), 'shake-agent-'));
		setSettingsRoots(project, agent);
		try {
			const notifs: string[] = [];
			const ctx = {
				isIdle: () => true,
				ui: { notify: (m: string) => notifs.push(m) },
				sessionManager: { getBranch: () => [] },
				getContextUsage: () => ({ tokens: null, contextWindow: 200000, percent: null }),
			};
			let handler: ((a: string, c: any) => Promise<void>) | null = null;
			const pi = {
				registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
					handler = opts.handler;
				},
				appendEntry: () => undefined,
			} as any;
			shakeExtension(pi);

			await runCommand(handler!, ctx, 'status');
			const status = notifs[notifs.length - 1];
			expect(status).toContain('context:  unknown');
			expect(status).not.toContain('0%');
		} finally {
			clearSettingsRoots();
			rmSync(project, { recursive: true, force: true });
			rmSync(agent, { recursive: true, force: true });
		}
	});

	test('N6: undo reports wall targets missing from the branch', async () => {
		const branch: any[] = [
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'hi', timestamp: Date.now() } },
		];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: () => 'ce-1',
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: (customType: string, data: any) => {
				branch.push({ id: `log-${branch.length}`, type: 'custom', customType, data });
			},
		} as any;
		shakeExtension(pi);

		pi.appendEntry('shake', { action: 'shake', mode: 'elide', targets: ['gone-entry'], freed: 300, at: Date.now() });
		await runCommand(handler!, ctx, 'undo');
		expect(notifs[notifs.length - 1]).toContain('Nothing to undo (1 entry on the wall missing from this branch)');
	});

	test('N7: all-fail run reads Nothing applied, not empty grammar', async () => {
		const branch: any[] = [
			{
				id: 't1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{
				id: 't2',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c2',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: () => {
					throw new Error('not editable');
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: () => undefined,
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, '');
		expect(notifs[notifs.length - 1]).toContain('Nothing applied (1 skipped, not editable)');
	});

	test('N8: trailing junk after a mode is rejected before any mutation', async () => {
		const branch: any[] = [
			{
				id: 't1',
				type: 'message',
				message: {
					role: 'toolResult',
					toolCallId: 'c',
					toolName: 'bash',
					isError: false,
					content: [{ type: 'text', text: 'q'.repeat(20000) }],
					timestamp: Date.now(),
				},
			},
			{ id: 'e9', type: 'message', message: { role: 'user', content: 'tail', timestamp: Date.now() } },
		];
		const edits: string[] = [];
		const notifs: string[] = [];
		const ctx = {
			isIdle: () => true,
			ui: { notify: (m: string) => notifs.push(m) },
			sessionManager: {
				getBranch: () => branch,
				appendContextEdit: (targetId: string, replacement: { content: unknown }) => {
					edits.push(targetId);
					branch.push({ id: `ce-${edits.length}`, type: 'context_edit', targetId, replacement });
					return `ce-${edits.length}`;
				},
			},
			getContextUsage: () => undefined,
		};
		let handler: ((a: string, c: any) => Promise<void>) | null = null;
		const pi = {
			registerCommand: (_n: string, opts: { handler: (a: string, c: any) => Promise<void> }) => {
				handler = opts.handler;
			},
			appendEntry: () => undefined,
		} as any;
		shakeExtension(pi);

		await runCommand(handler!, ctx, 'thinking bogus');
		expect(notifs[0]).toContain('Unknown /shake argument "bogus" after thinking');
		expect(edits).toHaveLength(0); // nothing mutated
	});
});
