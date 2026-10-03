import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { CHARS_PER_TOKEN, PROTECTED_TOOL_PREFIXES } from './constants.ts';
import type { Block, BlockRange, Entry, Msg } from './types.ts';

const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

/** Conservative: unterminated fences/tags yield nothing; XML suppressed inside fences. */
export function scanTextForBlockRanges(text: string): BlockRange[] {
	const ranges: BlockRange[] = [];
	let inFence = false;
	let fenceDelim = '';
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;

	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== '\n') continue;
		// Strip a trailing \r so CRLF text matches the same line grammar.
		const line = text.slice(lineStart, i).replace(/\r$/, '');
		const lineEnd = i;
		const trimmedStart = line.trimStart();

		if (inFence) {
			// Closing must match the opening delimiter.
			if (trimmedStart.startsWith(fenceDelim)) {
				inFence = false;
				ranges.push({ start: fenceStart, end: lineEnd, kind: 'fence' });
				fenceStart = -1;
				fenceDelim = '';
			}
			lineStart = i + 1;
			continue;
		}

		// A fence-like line opens a fence only at top level; inside a top-level
		// XML span it is content, not a fence.
		if (tagStack.length === 0 && (trimmedStart.startsWith('```') || trimmedStart.startsWith('~~~'))) {
			inFence = true;
			fenceDelim = trimmedStart.slice(0, 3);
			fenceStart = lineStart;
			lineStart = i + 1;
			continue;
		}

		const openMatch = xmlOpenMatch(trimmedStart, line);
		if (openMatch) {
			if (tagStack.length === 0) xmlStart = lineStart;
			tagStack.push(openMatch[1]);
		} else {
			const closingMatch = CLOSING_XML.exec(trimmedStart);
			if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
				tagStack.pop();
				if (tagStack.length === 0 && xmlStart >= 0) {
					ranges.push({ start: xmlStart, end: lineEnd, kind: 'xml' });
					xmlStart = -1;
				}
			}
		}

		lineStart = i + 1;
	}

	return mergeRanges(ranges);
}

function mergeRanges(ranges: BlockRange[]): BlockRange[] {
	if (ranges.length <= 1) return ranges;
	const sorted = ranges.toSorted((a, b) => a.start - b.start);
	const kept: BlockRange[] = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

export function textTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function fmtTokens(n: number): string {
	return n.toLocaleString('en-US');
}

export function entryTokens(entry: Entry): number {
	if (entry.type === 'message' && entry.message) {
		const content = entry.message.content;
		const message =
			typeof content === 'string' ? { ...entry.message, content: [{ type: 'text', text: content }] } : entry.message;
		return estimateTokens(message as never);
	}
	if (entry.type === 'custom_message' && entry.content !== undefined) {
		// pi's estimator weighs images in custom content (4,800 chars each).
		return estimateTokens({ role: 'custom', content: entry.content } as never);
	}
	return 0;
}

function isProtectedTool(toolName: string): boolean {
	return PROTECTED_TOOL_PREFIXES.some((prefix) => toolName.toLowerCase().startsWith(prefix));
}

/**
 * Opening-tag line: column 0, not self-closing, not a void element (so `<br
 * />`, `<hr>`, `<img>` never open a span). Returns the match for the name.
 */
function xmlOpenMatch(trimmedStart: string, line: string): RegExpExecArray | null {
	if (line.length !== trimmedStart.length || trimmedStart.endsWith('/>')) return null;
	const match = OPENING_XML.exec(trimmedStart);
	if (!match || VOID_TAGS.has(match[1])) return null;
	return match;
}

const VOID_TAGS = new Set([
	'area',
	'base',
	'br',
	'col',
	'embed',
	'hr',
	'img',
	'input',
	'link',
	'meta',
	'param',
	'source',
	'track',
	'wbr',
]);

function toolResultText(message: Msg): { originalText: string; tokens: number } | undefined {
	const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
	const fragments: string[] = [];
	for (const block of blocks) {
		if (block.type === 'text' && block.text.length > 0) fragments.push(block.text);
	}
	if (fragments.length === 0) return undefined;
	const originalText = fragments.join('\n');
	return { originalText, tokens: textTokens(originalText) };
}

/** "omitted" reads as deliberate length-cut, not error/silence; never mentions mechanism. */
export function newPlaceholder(kind: 'fence' | 'xml', chars: number): string {
	const tokens = Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
	const label = kind === 'fence' ? 'code block' : 'XML block';
	return `[${label} omitted (~${fmtTokens(tokens)} tokens)]`;
}

export function contentTokens(entry: Entry, content: string | Block[]): number {
	// Normalize string content to blocks: pi's estimator scores assistant
	// strings as 0 tokens, which would zero freed math for legacy rows.
	const normalized: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
	if (entry.type === 'custom_message') {
		return estimateTokens({ role: 'custom', content: normalized } as never);
	}
	return estimateTokens({ role: entry.message?.role ?? 'user', content: normalized } as never);
}

export { isProtectedTool, toolResultText };
