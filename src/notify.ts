import { spawn } from "node:child_process";

// eslint-disable-next-line no-control-regex -- control characters would end the escape sequence early
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f;]/g, " ").slice(0, 200);

/**
 * Desktop notification through the terminal: OSC 99 for kitty, OSC 9 for iTerm2,
 * OSC 777 for Ghostty, WezTerm, foot and most others. Terminals without support ignore it.
 */
export function desktopNotification(title: string, body: string, write = (s: string) => process.stdout.write(s)): void {
	const t = clean(title);
	const b = clean(body);
	if (process.env.KITTY_WINDOW_ID) {
		write(`\x1b]99;i=1:d=0;${t}\x1b\\`);
		write(`\x1b]99;i=1:p=body;${b}\x1b\\`);
	} else if (process.env.TERM_PROGRAM === "iTerm.app") {
		write(`\x1b]9;${t}: ${b}\x07`);
	} else {
		write(`\x1b]777;notify;${t};${b}\x07`);
	}
}

/** Open a URL or file with the system opener. Errors are ignored. */
export function openExternal(target: string): void {
	const [command, args] =
		process.platform === "darwin"
			? ["open", [target]]
			: process.platform === "win32"
				? ["cmd", ["/c", "start", "", target]]
				: ["xdg-open", [target]];
	try {
		const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// nothing to do
	}
}
