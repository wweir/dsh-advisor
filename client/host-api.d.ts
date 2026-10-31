/**
 * Declarations for the hand-written web half. Nothing browser-side is
 * installed: React arrives through the host's module loader, the slot/locale
 * context is handed to `apply`, and the wire bodies are the routes under
 * `src/host`. The bundle stays a script with no build step, so this file is the
 * whole type surface and it is checked by `tsconfig.client.json`.
 */

/** One node the injected React accepted. */
type AdvisorChild = AdvisorElement | string | number | boolean | null | undefined;

/** Props are opaque to typing on purpose: a string element's props are DOM's, not ours. */
interface AdvisorProps {
	readonly [key: string]: unknown;
}

/** What `React.createElement` returns here; enough to nest and to hand back to the host. */
interface AdvisorElement {
	readonly type: unknown;
	readonly props: AdvisorProps;
	readonly children: readonly AdvisorChild[];
}

/** The React surface this bundle uses. The host injects React; nothing is bundled. */
interface AdvisorReact {
	createElement(type: string, props?: AdvisorProps | null, ...children: unknown[]): AdvisorElement;
	/** A component element: props must satisfy the component's own parameter type. */
	createElement<P extends object>(
		type: (props: P) => unknown,
		props: P & { readonly key?: string | number },
		...children: unknown[]
	): AdvisorElement;
	useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void;
	useId(): string;
	useRef<T>(initial: T): { current: T };
	useState<T>(initial: T | (() => T)): readonly [T, (next: T | ((previous: T) => T)) => void];
}

/** What `locale.bind` returns; every render helper takes it. */
type AdvisorTranslator = (key: string) => string;

/** What `apply` receives from the host's client runtime. */
interface AdvisorClientContext {
	readonly locale: {
		bind(namespace: string): AdvisorTranslator;
		register(
			namespace: string,
			dictionaries: { readonly zh: Record<string, string>; readonly en: Record<string, string> },
		): () => void;
	};
	readonly slots: {
		inject(slot: string, install: () => () => void): () => void;
		register(
			descriptor: {
				readonly name: string;
				readonly id: string;
				readonly order: number;
				readonly locale: string;
				readonly label: () => string;
			},
			component: (props: { readonly sessionId: string }) => unknown,
		): () => void;
	};
	effect(callback: () => unknown, label: string): void;
}

/** The module the loader receives from the factory. */
interface AdvisorClientModule {
	inject: readonly string[];
	apply(ctx: AdvisorClientContext): void;
}

interface Window {
	__ModuleLoader__: {
		load(entry: { readonly id: string; readonly factory: (require: (id: string) => unknown) => unknown }): void;
	};
}

/*
 * Wire bodies, taken from the host modules that produce them, so a renamed
 * field fails here instead of rendering as undefined in the tab.
 */
type AdvisorStatusBody = import("../src/host/status.ts").AdvisorStatus;
type AdvisorCatalogProvider = import("../src/host/catalog.ts").AdvisorCatalogProvider;
type AdvisorCatalogModel = import("../src/host/catalog.ts").AdvisorCatalogModel;
type AdvisorConfigView = import("../src/policy/overrides.ts").AdvisorConfigView;
type AdvisorReviewRecord = import("../src/policy/stats.ts").ReviewRecord;
type AdvisorStats = import("../src/policy/stats.ts").AdvisorStats;
type AdvisorReviewContextMeta = import("../src/policy/stats.ts").ReviewContextMeta;
type AdvisorLastOutcome = import("../src/host/status.ts").AdvisorStatus["lastOutcome"];
