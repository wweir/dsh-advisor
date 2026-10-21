/**
 * The page-facing status route behind the web client's Advisor tab.
 *
 * `/advisor status` answers the person who types it in one session; the tab has
 * to answer for the session the page is showing, which the browser knows only
 * as an id. This route is that projection: the same {@link AdvisorStatus}, as
 * JSON, registered on the Connection service's exact Fetch channel — so the
 * Host/Origin fence and the browser session cookie apply exactly as they do to
 * the built-in `/api` routes, and this plugin adds no second authentication
 * path of its own.
 *
 * @module dsh-advisor/host/status-route
 */

import { ReviewCapacityError } from "../policy/budget.ts";
import { describeConfig, parseConfigPatch, type AdvisorConfigPatch } from "../policy/overrides.ts";
import type { AdvisorConfig } from "../policy/config.ts";
import type { AdvisorStatus } from "./status.ts";

/** Exact path of the status route, below the Connection service's `/api` channel. */
export const ADVISOR_STATUS_PATH = "/api/advisor/status";

/** Exact path of the compiled-prompt route (the reviewer's own view of the work). */
export const ADVISOR_CONTEXT_PATH = "/api/advisor/context";

/** Exact path of the page's configuration editor (write side of the status view). */
export const ADVISOR_CONFIG_PATH = "/api/advisor/config";

/** Exact path of the page's "resume now" action: clears a failure pause, nothing else. */
export const ADVISOR_RESUME_PATH = "/api/advisor/resume";

/**
 * The slice of the Connection service this route registers against. Typed
 * structurally so the plugin does not depend on the client-connection package
 * being the one that provides it.
 */
export interface ConnectionFetchHost {
	readonly fetch: {
		register(route: {
			readonly path: string;
			readonly methods: readonly ("GET" | "POST")[];
			readonly requestBody: "buffered";
			readonly fetch: (request: Request) => Promise<Response>;
		}): () => Promise<void>;
	};
}

export interface AdvisorStatusRouteDeps {
	/** Resolves one session's status; undefined when this Host is not running it. */
	readonly describeSession: (sessionId: string) => Promise<AdvisorStatus | undefined>;
	/** The compiled prompt of the session's last review, when still in this process. */
	readonly readContext: (sessionId: string) => string | undefined;
	/** Applies one page-supplied patch; rejects what the loader schema would. */
	readonly configure: (patch: AdvisorConfigPatch) => Promise<AdvisorConfig>;
	/** Clears the failure pause of one session; false when this Host no longer runs it. */
	readonly resumeSession: (sessionId: string) => Promise<boolean>;
	/** Host log for failure detail; the response body keeps only a stable message. */
	readonly logWarn: (message: string) => void;
}

/**
 * Session ids are the only input this route accepts. The shape check is loose on
 * purpose: the session store mints ids like `session-1`, so a length floor would
 * reject legitimate sessions the page is showing. The id is only ever looked up
 * in the agent registry, never joined into a path, so the shape adds no security
 * beyond rejecting obvious junk.
 */
const SESSION_ID = /^session-[A-Za-z0-9-]+$/;

/**
 * The session id a route was addressed to, or the 400 response to return instead.
 * Three routes accept that one input and each must reject junk the same way.
 */
function sessionIdOf(request: Request): string | Response {
	const sessionId = new URL(request.url).searchParams.get("sessionId");
	if (sessionId === null) return json(400, { error: "sessionId is required" });
	if (!SESSION_ID.test(sessionId)) return json(400, { error: "sessionId is invalid" });
	return sessionId;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			// A live status must never be answered from a cache.
			"cache-control": "no-store",
		},
	});
}

/**
 * Registers the status route on one Connection service.
 *
 * @param connection - the profile's Connection service.
 * @param deps - status lookup, owned by the session observer.
 * @returns the route's async disposer.
 */
export function registerAdvisorStatusRoute(
	connection: ConnectionFetchHost,
	deps: AdvisorStatusRouteDeps,
): () => Promise<void> {
	const statusRoute = connection.fetch.register({
		path: ADVISOR_STATUS_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		async fetch(request: Request): Promise<Response> {
			const sessionId = sessionIdOf(request);
			if (sessionId instanceof Response) return sessionId;
			try {
				const status = await deps.describeSession(sessionId);
				return json(200, { status: status ?? null });
			} catch (error) {
				// The tab is a diagnostic surface, so the body says that the lookup failed
				// while the detail (which can name host paths) stays in the host log.
				deps.logWarn(`status lookup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				return json(500, { error: "status lookup failed" });
			}
		},
	});
	const contextRoute = connection.fetch.register({
		path: ADVISOR_CONTEXT_PATH,
		methods: ["GET"],
		requestBody: "buffered",
		fetch(request: Request): Promise<Response> {
			const sessionId = sessionIdOf(request);
			if (sessionId instanceof Response) return Promise.resolve(sessionId);
			// The full prompt is served on demand and never cached: it can be large,
			// and it names the exact material the reviewer judged this review.
			return Promise.resolve(json(200, { prompt: deps.readContext(sessionId) ?? null }));
		},
	});
	const configRoute = connection.fetch.register({
		path: ADVISOR_CONFIG_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		async fetch(request: Request): Promise<Response> {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return json(400, { error: "body must be JSON" });
			}
			const parsed = parseConfigPatch(body);
			if (parsed.kind === "invalid") return json(400, { error: parsed.error });
			try {
				const config = await deps.configure(parsed.patch);
				return json(200, { config: describeConfig(config) });
			} catch (error) {
				// A configuration the reviewer route cannot hold is the operator's input
				// problem, not a host failure: its message carries the numbers, and the
				// form shows it in place of a generic write error.
				if (error instanceof ReviewCapacityError) return json(400, { error: error.message });
				deps.logWarn(`configuration write failed: ${error instanceof Error ? error.message : String(error)}`);
				return json(500, { error: "configuration write failed" });
			}
		},
	});
	const resumeRoute = connection.fetch.register({
		path: ADVISOR_RESUME_PATH,
		methods: ["POST"],
		requestBody: "buffered",
		async fetch(request: Request): Promise<Response> {
			const sessionId = sessionIdOf(request);
			if (sessionId instanceof Response) return sessionId;
			try {
				// Idempotent by design: resuming a session that is not paused is a
				// no-op, not an error, because the page's button can be pressed at any
				// time and a held-open tab may be one poll behind.
				const resumed = await deps.resumeSession(sessionId);
				return json(200, { resumed });
			} catch (error) {
				deps.logWarn(`resume failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
				return json(500, { error: "resume failed" });
			}
		},
	});
	return async () => {
		await resumeRoute();
		await configRoute();
		await contextRoute();
		await statusRoute();
	};
}
