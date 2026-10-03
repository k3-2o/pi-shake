/** Structural views of pi's session-entry shapes, kept untyped to compose with what pi hands us. */

export interface TextBlock {
	type: 'text';
	text: string;
}
export interface ImageBlock {
	type: 'image';
	data: string;
	mimeType: string;
}
export interface ThinkingBlock {
	type: 'thinking';
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
}
export interface ToolCallBlock {
	type: 'toolCall';
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
export type Block = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;

export interface Msg {
	role: string;
	content: string | Block[];
	[k: string]: unknown;
}

export interface Entry {
	id: string;
	type: string;
	message?: Msg;
	content?: string | (TextBlock | ImageBlock)[];
	customType?: string;
	targetId?: string;
	data?: unknown;
}

export interface PlanEdit {
	targetId: string;
	kind: 'toolResult' | 'block' | 'image' | 'thinking';
	label: string;
	content: string | Block[];
	freed: number;
	/** Count of dropped items for reporting. */
	count: number;
}

export interface ShakeConfig {
	protectTokens: number;
	fenceMinChars: number;
}

export interface BlockRange {
	start: number;
	end: number;
	kind: 'fence' | 'xml';
}
