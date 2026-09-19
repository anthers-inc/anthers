// SPDX-License-Identifier: Apache-2.0
/**
 * Reading from a person at a terminal, for the scripts that need a credential typed rather than
 * passed as a flag, where it would sit in the shell history.
 */

/**
 * Read a password from the terminal without echoing it, and without keeping it anywhere.
 *
 * Raw mode rather than a readline interface, because readline echoes by default and the
 * usual way to stop it — overriding an internal write method — is a private API that has
 * broken before. Reading bytes is longer and does exactly one thing.
 */
export async function promptHidden(label: string): Promise<string> {
	const stdin = process.stdin;
	process.stdout.write(label);
	stdin.setRawMode(true);
	stdin.resume();
	let entered = "";
	try {
		for await (const chunk of stdin) {
			for (const byte of chunk as Buffer) {
				if (byte === 3) {
					// Ctrl-C. Restore the terminal before leaving, or the shell is left in raw
					// mode with no echo and the next thing typed vanishes.
					process.stdout.write("\n");
					stdin.setRawMode(false);
					process.exit(130);
				}
				if (byte === 13 || byte === 10) {
					process.stdout.write("\n");
					return entered;
				}
				if (byte === 127 || byte === 8) {
					entered = entered.slice(0, -1);
					continue;
				}
				entered += String.fromCharCode(byte);
			}
		}
	} finally {
		stdin.setRawMode(false);
		stdin.pause();
	}
	return entered;
}
