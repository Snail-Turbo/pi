import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Text } from "../../tui/src/components/text.ts";
import { VStack } from "../../tui/src/components/v-stack.ts";
import { renderLayoutFrame } from "../../tui/src/layout.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function buildLongDiff(lines: number): string {
	return Array.from({ length: lines }, (_, i) => `+ line ${i}`).join("\n");
}

const VIEWPORT_WIDTH = 80;
const VIEWPORT_HEIGHT = 25;
const DOCK_VIEWPORT_HEIGHT = 30;
const NARROW_VIEWPORT_WIDTH = 20;
const DIFF_LINES = 150;
const DOCK_DIFF_LINES = 200;

describe("ExtensionSelectorComponent scrollable title", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("scrolls the diff and keeps option navigation intact", () => {
		let selected: string | undefined;
		let cancelled = false;
		const selector = new ExtensionSelectorComponent(
			`Review this change\n${buildLongDiff(DIFF_LINES)}`,
			["Yes", "No"],
			(v) => {
				selected = v;
			},
			() => {
				cancelled = true;
			},
		);

		// scrollBy is a no-op until the ScrollView has been laid out.
		renderLayoutFrame(selector, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});

		for (let i = 0; i < DIFF_LINES; i++) selector.handleInput("]");

		const frame = renderLayoutFrame(selector, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});
		const joined = frame.lines.map((line) => stripAnsi(line ?? "")).join("\n");
		expect(joined).toContain(`+ line ${DIFF_LINES - 1}`);
		expect(joined).toContain("Yes");
		expect(joined).toContain("No");
		expect(cancelled).toBe(false);

		selector.handleInput("j");
		selector.handleInput("\n");
		expect(selected).toBe("No");
	});

	it("keyboard hint advertises scroll bindings", () => {
		const selector = new ExtensionSelectorComponent(
			"title",
			["Yes", "No"],
			() => {},
			() => {},
		);
		const rendered = stripAnsi(selector.render(VIEWPORT_WIDTH).join("\n"));
		expect(rendered).toContain("[ ]");
	});

	it("keeps Yes/No visible when the diff exceeds the viewport height", () => {
		const selector = new ExtensionSelectorComponent(
			`Review this change\n${buildLongDiff(DIFF_LINES)}`,
			["Yes", "No"],
			() => {},
			() => {},
		);
		const frame = renderLayoutFrame(selector, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});
		const joined = frame.lines.map((line) => stripAnsi(line ?? "")).join("\n");
		expect(joined).toContain("Yes");
		expect(joined).toContain("No");
	});

	it("keeps Yes/No visible inside the dock layout (transcript + editor)", () => {
		const selector = new ExtensionSelectorComponent(
			`Review this change\n${buildLongDiff(DOCK_DIFF_LINES)}`,
			["Yes", "No"],
			() => {},
			() => {},
		);

		// Selector hosted in a VStack so tall children get a constrained height and can scroll.
		const editorContainer = new VStack([{ component: selector, shrink: 1, minSize: 0 }]);
		const dock = new VStack([
			{ component: editorContainer, shrink: 1, minSize: 3 },
			{ component: new Text("footer", 0, 0), shrink: 1, minSize: 1 },
		]);
		const root = new VStack([
			{ component: new Text("transcript", 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		const frame = renderLayoutFrame(root, VIEWPORT_WIDTH, DOCK_VIEWPORT_HEIGHT, () => {});
		const joined = frame.lines.map((line) => stripAnsi(line ?? "")).join("\n");
		expect(joined).toContain("Yes");
		expect(joined).toContain("No");
		expect(joined).toContain("transcript");
	});

	it("keeps Yes/No visible in a narrow viewport", () => {
		const selector = new ExtensionSelectorComponent(
			`Review this change\n${buildLongDiff(DIFF_LINES)}`,
			["Yes", "No"],
			() => {},
			() => {},
		);
		const frame = renderLayoutFrame(selector, NARROW_VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});
		const joined = frame.lines.map((line) => stripAnsi(line ?? "")).join("\n");
		expect(joined).toContain("Yes");
		expect(joined).toContain("No");
	});

	it("clamps scrolling at the top and bottom", () => {
		const selector = new ExtensionSelectorComponent(
			`Review this change\n${buildLongDiff(DIFF_LINES)}`,
			["Yes", "No"],
			() => {},
			() => {},
		);
		renderLayoutFrame(selector, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});
		for (let i = 0; i < DIFF_LINES; i++) selector.handleInput("[");
		for (let i = 0; i < DIFF_LINES * 2; i++) selector.handleInput("]");
		const frame = renderLayoutFrame(selector, VIEWPORT_WIDTH, VIEWPORT_HEIGHT, () => {});
		const joined = frame.lines.map((line) => stripAnsi(line ?? "")).join("\n");
		expect(joined).toContain("Yes");
		expect(joined).toContain("No");
	});
});
