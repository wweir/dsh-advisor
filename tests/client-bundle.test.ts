import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it } from "vitest";

import type { ReviewKind } from "../src/policy/stats.ts";
import type { LastReviewOutcome } from "../src/state.ts";

/**
 * The loader-facing contract of the hand-written web half: the ids it registers
 * under, the module it exports, the slot it installs, and that its two
 * dictionaries carry the same keys and cover every value the host can report.
 * The injected React runtime is stubbed, so this is a contract test, not a UI
 * test: one shallow render proves the wiring produces a tab region.
 */
const BUNDLE = readFileSync(fileURLToPath(new URL("../client/index.js", import.meta.url)), "utf8");

interface StubEntry {
	readonly id: string;
	readonly factory: (require: (id: string) => unknown) => AdvisorClientModule;
}

interface StubElement {
	readonly type: unknown;
	readonly props: Readonly<Record<string, unknown>>;
}

/** A recording `React.createElement` plus inert hooks: enough to run one render. */
function stubReact(): AdvisorReact {
	let ids = 0;
	return {
		createElement: ((type: unknown, props?: unknown) => ({ type, props: (props ?? {}) as Record<string, unknown> })) as
			AdvisorReact["createElement"],
		useEffect: () => {},
		useId: () => `id-${String(++ids)}`,
		useRef: <T,>(initial: T) => ({ current: initial }),
		useState: <T,>(initial: T | (() => T)) =>
			[typeof initial === "function" ? (initial as () => T)() : initial, () => {}] as const,
	};
}

function loadBundle(): StubEntry[] {
	const entries: StubEntry[] = [];
	const context = createContext({
		window: { __ModuleLoader__: { load: (entry: StubEntry) => entries.push(entry) } },
		document: {
			hidden: false,
			getElementById: () => null,
			createElement: () => ({ dataset: {}, style: {}, textContent: "" }),
			head: { appendChild: () => {} },
			addEventListener: () => {},
			removeEventListener: () => {},
		},
	});
	runInContext(BUNDLE, context, { filename: "client/index.js" });
	return entries;
}

describe("the web bundle's loader contract", () => {
	it("registers the published id and the pre-rename alias with one factory", () => {
		const entries = loadBundle();
		expect(entries.map((entry) => entry.id)).toEqual(["@wweir/dsh-advisor", "dsh-advisor"]);
		expect(entries[1]?.factory).toBe(entries[0]?.factory);
	});

	it("exports the slot/locale injection and installs the Advisor tab once applied", () => {
		const [published] = loadBundle();
		expect(published).toBeDefined();
		const bundle = published?.factory((id) => {
			expect(id).toBe("react");
			return stubReact();
		});
		expect(bundle?.inject).toEqual(["slots", "locale"]);

		const slots: { descriptor: Record<string, unknown>; component: (props: { sessionId: string }) => unknown }[] = [];
		let bound = "";
		let dictionaries: { zh: Record<string, string>; en: Record<string, string> } | undefined;
		bundle?.apply({
			locale: {
				bind: (namespace) => {
					bound = namespace;
					return (key) => `T:${key}`;
				},
				register: (_namespace, registered) => {
					dictionaries = registered;
					return () => {};
				},
			},
			slots: {
				inject: (_slot, install) => {
					install();
					return () => {};
				},
				register: (descriptor, component) => {
					slots.push({ descriptor: descriptor as unknown as Record<string, unknown>, component });
					return () => {};
				},
			},
			effect: (callback) => {
				callback();
			},
		});

		expect(bound).toBe("advisor");
		expect(slots).toHaveLength(1);
		expect(slots[0]?.descriptor).toMatchObject({
			name: "conversation.view",
			id: "conv-advisor",
			order: 21,
			locale: "advisor",
		});

		// Both dictionaries must translate the same keys, or one locale silently
		// renders a raw key where the other renders a sentence.
		expect(dictionaries).toBeDefined();
		expect(Object.keys(dictionaries?.zh ?? {}).sort()).toEqual(Object.keys(dictionaries?.en ?? {}).sort());

		// Every value the host can report needs a label: `kind` comes from a wire
		// union, so a kind added on the host side renders as the bare token here
		// until both dictionaries (and `outcomeText`) learn about it.
		const reviewKinds: readonly ReviewKind[] = ["silent", "finding", "failed", "cancelled", "unavailable"];
		for (const kind of reviewKinds) {
			expect(dictionaries?.zh[`kind.${kind}`], `zh kind.${kind}`).toBeTruthy();
			expect(dictionaries?.en[`kind.${kind}`], `en kind.${kind}`).toBeTruthy();
		}
		const outcomeKinds: readonly LastReviewOutcome["kind"][] = [
			"silent",
			"finding",
			"suppressed",
			"failed",
			"cancelled",
			"unavailable",
		];
		for (const kind of outcomeKinds) {
			const key = `outcome${(kind[0] ?? "").toUpperCase()}${kind.slice(1)}`;
			expect(dictionaries?.zh[key], `zh ${key}`).toBeTruthy();
			expect(dictionaries?.en[key], `en ${key}`).toBeTruthy();
		}
		for (const severity of ["nit", "concern", "blocker"]) {
			expect(dictionaries?.zh[`severity.${severity}`], `zh severity.${severity}`).toBeTruthy();
			expect(dictionaries?.en[`severity.${severity}`], `en severity.${severity}`).toBeTruthy();
		}
		expect((slots[0]?.descriptor.label as () => string)()).toBe("T:tab.title");

		// The slot installs an element for the tab component. Rendering it through
		// the stubbed hooks must land on the tab region; the tab starts on its
		// loading panel, so function components are resolved until a host element
		// appears (the stubbed hooks never fire an effect that would change state).
		let node = slots[0]?.component({ sessionId: "session-1" }) as StubElement | undefined;
		for (let depth = 0; depth < 5 && typeof node?.type === "function"; depth++) {
			node = (node.type as (props: unknown) => unknown)(node.props) as StubElement;
		}
		expect(node?.type).toBe("div");
		expect(node?.props["data-advisor-tab"]).toBe(true);
	});
});
