/**
 * Cordis plugin entry. Declares the config schema, takes the single-reviewer
 * claim, and owns the session observer.
 *
 * @module dsh-advisor
 */

import z from "@deepseek-ai/schemastery";

import type { Context } from "@deepseek-ai/cordis";

import type { ReviewModelWindow } from "./policy/budget.ts";

import {
	DEFAULT_ADVISOR_CONFIG,
	type ActiveIdleSeverity,
	type AdvisorConfig,
	type AdvisorEffort,
} from "./policy/config.ts";
import { SessionObserver } from "./host/subscription.ts";
import { resolveAdvisorStateRoot } from "./host/paths.ts";
import { ConfigOverridesStore } from "./host/config-store.ts";
import { applyConfigPatch, type AdvisorConfigPatch } from "./policy/overrides.ts";
import {
	registerAdvisorCatalogRoute,
	type AdvisorCatalogRouteDeps,
	type LlmCatalogHost,
} from "./host/catalog.ts";
import { registerAdvisorStatusRoute, type ConnectionFetchHost } from "./host/status-route.ts";

export const name = "@wweir/dsh-advisor";

/** Services this plugin consumes; the row only loads once all are available. */
export const inject = ["agents", "fs", "workingDirectory"];

/**
 * Loader schema. Only values a user would plausibly tune are declared here;
 * everything else is a module constant in the policy layer.
 *
 * `model` is optional at the schema level because "disabled" is the default and a
 * disabled row legitimately has no route; `apply` rejects `enabled` without one.
 */
export const Config = z.object({
	enabled: z.boolean().default(DEFAULT_ADVISOR_CONFIG.enabled),
	model: z.object({
		provider: z.string(),
		model: z.string(),
		reasoningEffort: z.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
	}),
	instructions: z.string().default(DEFAULT_ADVISOR_CONFIG.instructions),
	review: z.object({
		// `0` keeps its v0.3 meaning: no automatic review. It is accepted so an
		// override file written with it still loads after the round cadence is gone.
		everySteps: z.number().step(1).min(0).default(DEFAULT_ADVISOR_CONFIG.review.everySteps),
		timeoutMs: z.number().step(1).min(1).default(DEFAULT_ADVISOR_CONFIG.review.timeoutMs),
		// Upper bound on the whole review prompt. It is a cap, not a target: the
		// effective budget is the smaller of this and what the reviewer model's
		// window leaves after its preamble and output reserve.
		maxContextTokens: z
			.number()
			.step(1)
			.min(1)
			.default(DEFAULT_ADVISOR_CONFIG.review.maxContextTokens),
		maxAdviceChars: z
			.number()
			.step(1)
			.min(1)
			.default(DEFAULT_ADVISOR_CONFIG.review.maxAdviceChars),
		maxPending: z.number().step(1).min(1).default(DEFAULT_ADVISOR_CONFIG.review.maxPending),
	}),
	delivery: z.object({
		activeIdleSeverities: z
			.array(z.union(["concern", "blocker"]))
			.default([...DEFAULT_ADVISOR_CONFIG.delivery.activeIdleSeverities]),
	}),
	prompt: z.object({
		// System-prompt sections the review child must not carry. Empty by
		// default: the advisor does not guess another plugin's internals, so a
		// deployment names the sections its reviewer should not inherit.
		shadowedSections: z.array(z.string()).default([...DEFAULT_ADVISOR_CONFIG.prompt.shadowedSections]),
	}),
	security: z.object({ additionalProtectedPaths: z.array(z.string()).default([]) }),
});

export interface AdvisorPluginConfig {
	enabled: boolean;
	/**
	 * The loader resolves an absent `model` block to `{}`, so both names are
	 * optional here and a blank route is treated as "no route" by `apply`.
	 */
	model?: { provider?: string; model?: string; reasoningEffort?: string } & Record<string, unknown>;
	instructions: string;
	review: {
		everySteps: number;
		timeoutMs: number;
		maxContextTokens: number;
		maxAdviceChars: number;
		maxPending: number;
	};
	delivery: { activeIdleSeverities: readonly string[] };
	prompt: { shadowedSections: readonly string[] };
	security: { additionalProtectedPaths: readonly string[] };
}

/**
 * The host composes several fibers of one plugin row, and `session/event` is a
 * global subscription: without a claim, N fibers would review the same session
 * N times per turn. The first fiber to claim owns the observer; the flag lives
 * on `globalThis` so it survives module-copy divergence.
 *
 * The claim carries a token rather than a boolean: a fiber that stops owning the
 * row releases only its own claim, so an owner unloading after a reload has
 * already re-claimed cannot silently disarm the row.
 *
 * The value left by a previous release is deliberately not trusted to be
 * `undefined`: an instance loaded before this token existed releases by writing
 * `false`, and a hot reload runs the new module in the same process. Presence is
 * therefore judged by type — only a live symbol owns the row — which is what
 * keeps a reloaded row from mistaking its predecessor's tombstone for an owner.
 */
const REVIEWER_KEY = "__dshAdvisorReviewer__";

function claimReviewer(): symbol | undefined {
	const global = globalThis as Record<string, unknown>;
	if (typeof global[REVIEWER_KEY] === "symbol") return undefined;
	const token = Symbol("dsh-advisor-reviewer");
	global[REVIEWER_KEY] = token;
	return token;
}

function releaseReviewer(token: symbol): void {
	const global = globalThis as Record<string, unknown>;
	if (global[REVIEWER_KEY] === token) global[REVIEWER_KEY] = undefined;
}

export function apply(ctx: Context, config: AdvisorPluginConfig): void {
	const logger = ctx.logger("dsh-advisor");
	const advisorConfig = toAdvisorConfig(config);
	const stateRoot = resolveAdvisorStateRoot();

	// Saved page overrides are part of the effective configuration, so a row that
	// disabled reviewing can still be turned back on from the page that shows it.
	const overrides = new ConfigOverridesStore(stateRoot);
	const loaded = overrides.load();
	if (loaded.kind === "unreadable") {
		logger.warn(`configuration overrides ignored: ${loaded.reason}`);
	}
	const effective =
		loaded.kind === "present" ? applyConfigPatch(advisorConfig, loaded.patch) : advisorConfig;
	// Checked on the merged configuration, not only on the row: an override layer
	// that enabled reviewing without a route would otherwise leave a permanently
	// inert row that is loud nowhere. A disabled row legitimately stays model-less.
	if (effective.enabled && effective.model === undefined) {
		throw new Error("dsh-advisor: `enabled: true` requires model.provider and model.model");
	}
	// The row's Config schema already enforced the types, the lower bounds and both
	// enums; the route/enabled invariant was checked just above. The page's maxima
	// are page-side bounds, deliberately not added to the loader schema.
	const reviewerToken = claimReviewer();
	if (reviewerToken === undefined) {
		// The row is composed of several fibers and only one owns the observer. The
		// others must say so: a silent return here is indistinguishable from a row
		// that loaded without a working reviewer.
		logger.warn("another fiber of this row already owns the reviewer; this one is inactive");
		return;
	}
	try {
		// `ctx.effect` collects the disposer and runs it when the fiber unloads. The
		// whole setup is guarded so a throw after the claim cannot leave the row
		// claimed forever: every later fiber of the row would return silently.
		// Filled by the catalog fiber below; read lazily by every review budget.
		const reviewer: {
			resolveModelInfo?: (provider: string, model: string) => Promise<ReviewModelWindow | undefined>;
		} = {};
		ctx.effect(() => {
			const observer = new SessionObserver({
				ctx,
				config: effective,
				stateRoot,
				// The reviewer window is read through this slot, which the catalog
				// fiber below fills: the LLM registry is optional (a headless host may
				// have none) and a plugin fiber cannot await it. The resolver stays
				// lazy so a fiber that has not run yet leaves the configured cap in
				// force rather than blocking review.
				resolveModelInfo: (provider, model) =>
					reviewer.resolveModelInfo?.(provider, model) ?? Promise.resolve(undefined),
			});
			// The page tab asks this route for the status of the session it shows. The
			// connection surface is web-only, so a headless or TUI host simply never
			// runs this fiber; the advisor itself does not depend on it.
			const statusRoute = ctx.inject(["connection"], (connectionCtx) =>
				// Returning the disposer itself (not a wrapper that drops its promise)
				// matters: the routes must be gone before a re-run of this fiber
				// registers the same exact paths again, and duplicate registration
				// throws inside the fiber.
				registerAdvisorStatusRoute(connectionCtx.get("connection") as ConnectionFetchHost, {
					describeSession: (sessionId) => observer.describeSession(sessionId),
					readContext: (sessionId) => observer.describeContext(sessionId),
					configure: (patch: AdvisorConfigPatch) => observer.configure(patch),
					resumeSession: (sessionId) => observer.resumeSession(sessionId),
					logWarn: (message) => logger.warn(message),
				}),
			);
			// The config form's provider/model dropdowns read the live LLM registry
			// through this route, so this fiber waits for the registry too: a host
			// without one keeps every other route and simply serves no catalog, and
			// the form falls back to free-text inputs.
			const catalogRoute = ctx.inject(["connection", "llm"], (connectionCtx) => {
				const deps: AdvisorCatalogRouteDeps = {
					logWarn: (message) => logger.warn(message),
				};
				const llm = connectionCtx.get("llm") as LlmCatalogHost;
				reviewer.resolveModelInfo = async (provider, model) => {
					const info = await llm.resolveModelInfo(provider, model);
					return {
						...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
						...(info.defaultMaxTokens === undefined
							? {}
							: { defaultMaxTokens: info.defaultMaxTokens }),
					};
				};
				return registerAdvisorCatalogRoute(connectionCtx.get("connection") as ConnectionFetchHost, llm, deps);
			});
			return async () => {
				try {
					// Both routes have to be unregistered before a re-run of this fiber
					// registers the same exact paths again (duplicate registration throws
					// inside the fiber), so one failing disposer must not skip the other.
					await Promise.allSettled([catalogRoute.dispose(), statusRoute.dispose()]);
				} finally {
					// The reviewer claim is process-global: releasing it must not depend
					// on either route disposer resolving. A rejected disposer would
					// otherwise leave the row claimed, and every later fiber would return
					// silently at the claim above.
					try {
						observer.dispose();
					} finally {
						releaseReviewer(reviewerToken);
					}
				}
			};
		});
	} catch (error) {
		releaseReviewer(reviewerToken);
		throw error;
	}
}

function toAdvisorConfig(config: AdvisorPluginConfig): AdvisorConfig {
	const provider = config.model?.provider;
	const name = config.model?.model;
	const hasRoute =
		typeof provider === "string" &&
		provider.trim().length > 0 &&
		typeof name === "string" &&
		name.trim().length > 0;
	const model = hasRoute
		? {
				provider: provider.trim(),
				model: name.trim(),
				...(config.model?.reasoningEffort === undefined
					? {}
					: { reasoningEffort: config.model.reasoningEffort as AdvisorEffort }),
			}
		: undefined;
	return {
		enabled: config.enabled,
		...(model === undefined ? {} : { model }),
		instructions: config.instructions,
		review: { ...config.review },
		delivery: {
			activeIdleSeverities: [...config.delivery.activeIdleSeverities] as ActiveIdleSeverity[],
		},
		prompt: { shadowedSections: [...config.prompt.shadowedSections] },
		security: { additionalProtectedPaths: [...config.security.additionalProtectedPaths] },
	};
}
