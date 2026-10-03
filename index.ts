import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createShakeCommandSpec } from './src/cli.ts';

export default function shakeExtension(pi: ExtensionAPI): void {
	pi.registerCommand('shake', createShakeCommandSpec(pi));
}
