/**
 * The model catalog route behind the config form's provider/model dropdowns.
 *
 * The page's provider and model fields used to be free text, which made typos
 * silent configuration errors. This route projects the live LLM registry
 * (the same source the GUI model picker reads) into the small shape the form
 * needs: providers with their models and, per model, the selectable reasoning
 * efforts. Registered on the same Connection Fetch channel as the other
 * advisor routes, so the browser session cookie and the Host/Origin fence
 * apply exactly as they do to `/api`.
 *
 * @module dsh-advisor/host/catalog
 */

import type { ConnectionFetchHost } from "./status-route.ts";
import { ADVISOR_EFFORTS, type AdvisorEffort } from "../policy/config.ts";

/** Exact path of the model catalog route. */
export const ADVISOR_CATALOG_PATH = "/api/advisor/catalog";

/** One selectable model on the wire: display name plus optional effort metadata. */
export interface AdvisorCatalogModel {
	id: string;
	name: string;
	/** Efforts the model advertises, least to greatest; absent = unknown, form falls back to the static list. */
	readonly efforts?: readonly AdvisorEffort[];
	/** Adapter-preferred effort for this model, when advertised. */
	readonly defaultEffort?: AdvisorEffort;
	/**
	 * Maximum combined request and response context the route advertises. The
	 * review budget is derived from it, so the form can say what a route can hold
	 * instead of letting an operator discover it through an overflow.
	 */
	readonly contextWindow?: number;
}

/** One provider group on the wire. */
export interface AdvisorCatalogProvider {
	id: string;
	name: string;
	models: AdvisorCatalogModel[];
}

/** The catalog body the config form renders its dropdowns from. */
export interface AdvisorCatalog {
	providers: AdvisorCatalogProvider[];
}

/**
 * The slice of the host LLM registry this route reads. Typed structurally so
 * the plugin does not depend on dsh-llm being the one that provides it.
 */
export interface LlmCatalogHost {
	listProviders(): readonly { id: string; name: string }[];
	listModels(provider: string): Promise<readonly { id: string; name: string }[]>;
	resolveModelInfo(
		provider: string,
		model: string,
	): Promise<{
		context?: { contextWindow: number };
		defaultMaxTokens?: number;
		reasoning?: {
			efforts: readonly { id: string }[];
			defaultEffort?: string;
		};
	}>;
}

export interface AdvisorCatalogRouteDeps {
	/** Host log for failure detail; the response body keeps only the stable shape. */
	readonly logWarn: (message: string) => void;
}

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// Registry entries can appear or vanish with credential changes.
			"cache-control": "no-store",
		},
	});
}

function asEffort(value: string): AdvisorEffort | undefined {
	return (ADVISOR_EFFORTS as readonly string[]).includes(value) ? (value as AdvisorEffort) : undefined;
}

/**
 * Registers the catalog route on one Connection service.
 *
 * @param connection - the profile's Connection service.
 * @param llm - the host LLM registry.
 * @param deps - host log sink.
 * @returns the route's async disposer.
 */
export function registerAdvisorCatalogRoute(
	connection: ConnectionFetchHost,
	llm: LlmCatalogHost,
	deps: AdvisorCatalogRouteDeps,
): () => Promise<void> {
	const route = connection.fetch.register({
		path: ADVISOR_CATALOG_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		async fetch(): Promise<Response> {
			// A provider that fails to list drops out instead of failing the whole
			// catalog, so one broken adapter cannot blank every other provider's
			// dropdown — the GUI's own catalog build draws the same line. It stops
			// there, though: the GUI fails the whole provider when one of its models
			// refuses to resolve, while here the model stays listed and only its
			// reasoning metadata is dropped, because a dropdown that silently loses a
			// selectable model is worse than one that offers it without levels.
			let listed: readonly { id: string; name: string }[];
			try {
				listed = llm.listProviders();
			} catch (error) {
				// The registry itself refusing to enumerate is the same class of
				// failure as one provider failing below: the form falls back to free
				// text rather than the route rejecting with a non-JSON shape.
				deps.logWarn(
					`catalog: provider list unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				listed = [];
			}
			const providers = await Promise.all(
				listed.map(async (provider) => {
					try {
						const models = await llm.listModels(provider.id);
						const entries: AdvisorCatalogModel[] = await Promise.all(
							models.map(async (model) => {
								const efforts: AdvisorEffort[] = [];
								let advertised = false;
								let defaultEffort: AdvisorEffort | undefined;
								let contextWindow: number | undefined;
								try {
									const resolved = await llm.resolveModelInfo(provider.id, model.id);
									advertised = resolved.reasoning !== undefined;
									contextWindow = resolved.context?.contextWindow;
									for (const effort of resolved.reasoning?.efforts ?? []) {
										const id = asEffort(effort.id);
										if (id !== undefined) efforts.push(id);
									}
									defaultEffort = asEffort(resolved.reasoning?.defaultEffort ?? "");
								} catch {
									// Metadata that will not resolve leaves the model listed with
									// no level information: the form then offers its static list,
									// which is the same answer it gives a model that exposes none.
								}
								return {
									id: model.id,
									name: model.name,
									// `efforts` present and empty means the adapter advertises levels
									// this plugin cannot offer — distinct from an absent `efforts`
									// ("no metadata at all"). The form offers only "default" for the
									// former instead of guessing from its static list, which would
									// let a level be saved that the adapter silently drops.
									...(advertised ? { efforts } : {}),
									...(defaultEffort === undefined ? {} : { defaultEffort }),
									...(contextWindow === undefined ? {} : { contextWindow }),
								};
							}),
						);
						return { id: provider.id, name: provider.name, models: entries };
					} catch (error) {
						deps.logWarn(
							`catalog: provider ${provider.id} skipped: ${error instanceof Error ? error.message : String(error)}`,
						);
						return undefined;
					}
				}),
			);
			const body: AdvisorCatalog = {
				providers: providers.filter(
					(provider): provider is AdvisorCatalogProvider =>
						provider !== undefined && provider.models.length > 0,
				),
			};
			return json(body);
		},
	});
	return route;
}
