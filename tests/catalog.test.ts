import { describe, expect, it } from "vitest";

import {
	ADVISOR_CATALOG_PATH,
	registerAdvisorCatalogRoute,
	type LlmCatalogHost,
} from "../src/host/catalog.ts";
import type { ConnectionFetchHost } from "../src/host/status-route.ts";

/**
 * The catalog route is what turns the config form's provider/model fields from
 * free text into dropdowns. These cases pin the projection rules the form then
 * relies on: a provider that cannot be listed drops out alone, a model that
 * advertises no reasoning metadata still appears (the form falls back to the
 * static effort list), and an advertised effort outside the plugin's accepted
 * set is never offered.
 */

/** A Connection stand-in that captures the one route the catalog registers. */
function captureRoute(): {
	connection: ConnectionFetchHost;
	call: () => Promise<Response>;
} {
	let handler: ((request: Request) => Promise<Response>) | undefined;
	const connection: ConnectionFetchHost = {
		fetch: {
			register(route) {
				handler = route.fetch;
				return async () => {};
			},
		},
	};
	return {
		connection,
		call: () => {
			if (handler === undefined) throw new Error("no route registered");
			return handler(new Request(`http://host${ADVISOR_CATALOG_PATH}`));
		},
	};
}

function llm(overrides: Partial<LlmCatalogHost> = {}): LlmCatalogHost {
	return {
		listProviders: () => [{ id: "p1", name: "Provider One" }],
		listModels: async () => [{ id: "m1", name: "Model One" }],
		resolveModelInfo: async () => ({
			reasoning: { efforts: [{ id: "low" }, { id: "high" }], defaultEffort: "high" },
		}),
		...overrides,
	};
}

async function catalogBody(host: LlmCatalogHost): Promise<{
	providers: { id: string; name: string; models: { id: string; efforts?: string[]; defaultEffort?: string }[] }[];
}> {
	const captured = captureRoute();
	registerAdvisorCatalogRoute(captured.connection, host, { logWarn: () => {} });
	const response = await captured.call();
	return (await response.json()) as never;
}

describe("registerAdvisorCatalogRoute", () => {
	it("projects providers with their models and advertised efforts", async () => {
		expect(await catalogBody(llm())).toEqual({
			providers: [
				{
					id: "p1",
					name: "Provider One",
					models: [{ id: "m1", name: "Model One", efforts: ["low", "high"], defaultEffort: "high" }],
				},
			],
		});
	});

	it("keeps a model that advertises no reasoning metadata", async () => {
		const body = await catalogBody(llm({ resolveModelInfo: async () => ({}) }));
		expect(body.providers[0]?.models).toEqual([{ id: "m1", name: "Model One" }]);
	});

	it("drops an advertised effort the plugin does not accept", async () => {
		const body = await catalogBody(
			llm({
				resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "low" }, { id: "turbo" }] } }),
			}),
		);
		expect(body.providers[0]?.models[0]?.efforts).toEqual(["low"]);
	});

	it("marks an advertised set it cannot offer as an explicit empty list", async () => {
		// Absent `efforts` means "no metadata"; present-and-empty means "the adapter
		// advertises levels, none of which this plugin can offer". The form shows
		// only "default" for the latter instead of guessing from its static list.
		const body = await catalogBody(
			llm({ resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "turbo" }] } }) }),
		);
		expect(body.providers[0]?.models[0]).toEqual({ id: "m1", name: "Model One", efforts: [] });
	});

	it("isolates a provider that cannot be listed", async () => {
		const host = llm({
			listProviders: () => [
				{ id: "broken", name: "Broken" },
				{ id: "p1", name: "Provider One" },
			],
			listModels: async (provider) => {
				if (provider === "broken") throw new Error("adapter offline");
				return [{ id: "m1", name: "Model One" }];
			},
		});
		const body = await catalogBody(host);
		expect(body.providers.map((provider) => provider.id)).toEqual(["p1"]);
	});

	it("keeps resolving a model whose reasoning metadata fails", async () => {
		const body = await catalogBody(
			llm({
				resolveModelInfo: async () => {
					throw new Error("metadata unavailable");
				},
			}),
		);
		expect(body.providers[0]?.models).toEqual([{ id: "m1", name: "Model One" }]);
	});

	it("reports an empty catalog rather than failing when a provider has no models", async () => {
		const body = await catalogBody(llm({ listModels: async () => [] }));
		expect(body.providers).toEqual([]);
	});
});
