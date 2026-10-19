// Replacement commands for intercepted bash calls. They carry a marker comment with the
// original command, so the transcript can show it even after a restart.

const MARKER = "# pi-monitor:";

export interface Interception {
	id: string;
	command: string;
}

/** Quote any string for bash. */
export function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

function marker(info: Interception): string {
	return `${MARKER} ${JSON.stringify(info)}`;
}

/** Read the marker back from a rewritten command. */
export function readMarker(command: string): Interception | undefined {
	const line = command.split("\n").find((l) => l.startsWith(MARKER));
	if (!line) return undefined;
	try {
		const data = JSON.parse(line.slice(MARKER.length)) as Partial<Interception>;
		return typeof data.id === "string" && typeof data.command === "string"
			? { id: data.id, command: data.command }
			: undefined;
	} catch {
		return undefined;
	}
}

/** A harmless command that prints `text` and succeeds. */
export function printfCommand(text: string, info: Interception): string {
	return `printf '%s\\n' ${shellQuote(text)}\n${marker(info)}`;
}

export interface WaitScript {
	statusPath: string;
	outputPath: string;
	/** Give up if the extension never writes a status, e.g. because Pi crashed. */
	maxWaitSeconds: number;
	movedText: string;
	timeoutSeconds?: number;
}

/** Most the wait script prints. The bash tool truncates further, like for any command. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * Wait for the safety net to decide. The status file holds `exit:<code>`, `bg` or `timeout`.
 * Exit: print the captured output and exit with the real code. bg: print the output so far and
 * the "moved to background" note, exit 0.
 */
export function waitScript(script: WaitScript, info: Interception): string {
	const status = shellQuote(script.statusPath);
	const output = shellQuote(script.outputPath);
	const ticks = Math.ceil(script.maxWaitSeconds * 5);
	const timeout = script.timeoutSeconds ? `Command timed out after ${script.timeoutSeconds}s.` : "Command timed out.";
	return [
		`s=${status}; o=${output}; n=0`,
		`while [ ! -s "$s" ]; do sleep 0.2; n=$((n+1)); if [ $n -gt ${ticks} ]; then echo ${shellQuote(`pi-monitor lost track of ${info.id}.`)}; exit 1; fi; done`,
		`r=$(cat "$s")`,
		`case "$r" in`,
		`  bg) tail -n 30 "$o"; printf '%s\\n' ${shellQuote(script.movedText)}; exit 0;;`,
		`  timeout) tail -c ${MAX_OUTPUT_BYTES} "$o"; printf '%s\\n' ${shellQuote(timeout)}; exit 124;;`,
		`  *) tail -c ${MAX_OUTPUT_BYTES} "$o"; exit "\${r#exit:}";;`,
		`esac`,
		marker(info),
	].join("\n");
}
