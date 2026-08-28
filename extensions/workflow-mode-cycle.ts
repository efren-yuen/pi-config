import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

const MODES = ["plan", "implement", "review"] as const;
const MODE_PREFIX = /^\/(plan|implement|review)(?=\s|$)/;

type Mode = (typeof MODES)[number];

export default function workflowModeCycle(pi: ExtensionAPI): void {
	pi.registerShortcut(Key.shift("tab"), {
		description: "Cycle workflow mode prefix",
		handler: async (ctx) => {
			const text = ctx.ui.getEditorText();
			const match = text.match(MODE_PREFIX);
			const currentMode = match ? (match[1] as Mode) : undefined;
			const nextMode = currentMode
				? MODES[(MODES.indexOf(currentMode) + 1) % MODES.length]
				: MODES[0];
			const taskText = currentMode ? text.slice(match[0].length) : text;
			const separator = taskText && !/^\s/.test(taskText) ? " " : "";

			ctx.ui.setEditorText(`/${nextMode}${taskText ? `${separator}${taskText}` : ""}`);
		},
	});
}
