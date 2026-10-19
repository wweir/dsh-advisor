/**
 * The UI-editable slice of the advisor configuration.
 *
 * The row in `cordis.patch.yml` stays the authoritative default: the page can
 * only patch the fields an operator tunes day to day, and those patches are
 * persisted next to the sidecars so they survive a restart without rewriting the
 * profile. Validation mirrors the loader schema in the plugin entry, which the
 * route cannot reach (the page sends raw JSON).
 *
 * @module dsh-advisor/policy/overrides
 */

import type {
	ActiveIdleSeverity,
	AdvisorConfig,
	AdvisorEffort,
	AdvisorModelConfig,
	AdvisorReviewConfig,
} from "./config.ts";
import { ADVISOR_EFFORTS } from "./config.ts";

/**
 * Model route as the page submits it. `reasoningEffort: null` means "inherit
 * the row's effort"; omitting the field means "keep the effective effort". The
 * two are distinct because otherwise a page can never clear a value it once set.
 */
export interface AdvisorModelPatch {
	provider: string;
	model: string;
	reasoningEffort?: AdvisorEffort | null;
}

/** Fields the page may change; everything else stays row-owned. */
export interface AdvisorConfigPatch {
	enabled?: boolean;
	model?: AdvisorModelPatch;
	instructions?: string;
	review?: Partial<AdvisorReviewConfig>;
	delivery?: { activeIdleSeverities?: readonly ActiveIdleSeverity[] };
}

/** Projection of the effective configuration the page renders as a form. */
export interface AdvisorConfigView {
	enabled: boolean;
	model?: AdvisorModelConfig;
	instructions: string;
	review: AdvisorReviewConfig;
	delivery: { activeIdleSeverities: readonly ActiveIdleSeverity[] };
}

export type ConfigPatchParse =
	| { readonly kind: "ok"; readonly patch: AdvisorConfigPatch }
	| { readonly kind: "invalid"; readonly error: string };

const SEVERITIES: readonly ActiveIdleSeverity[] = ["concern", "blocker"];
const EFFORTS: readonly AdvisorEffort[] = ADVISOR_EFFORTS;

/**
 * Bounds on page-submitted values. They exist because this patch is persisted
 * and then re-rendered in every status poll: unbounded text would turn the
 * polling surface into a copy of the whole configuration.
 */
const LIMITS = {
	providerCharacters: 200,
	modelCharacters: 200,
	instructionsCharacters: 20_000,
	everyTurns: 1_000,
	timeoutMs: 3_600_000,
	maxContextTokens: 1_000_000,
	maxAdviceChars: 100_000,
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Same integer shape the loader schema applies, plus the page's upper bound. */
function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximum;
}

function isBoundedNonEmptyString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function invalid(error: string): ConfigPatchParse {
	return { kind: "invalid", error };
}

/**
 * Validates one page-supplied patch. Unknown keys are rejected rather than
 * ignored: a form field the host forgot would otherwise silently do nothing.
 */
export function parseConfigPatch(value: unknown): ConfigPatchParse {
	if (!isRecord(value)) return invalid("patch must be a JSON object");
	const known = new Set(["enabled", "model", "instructions", "review", "delivery"]);
	for (const key of Object.keys(value)) {
		if (!known.has(key)) return invalid(`unknown field: ${key}`);
	}
	const patch: AdvisorConfigPatch = {};
	if (value["enabled"] !== undefined) {
		if (typeof value["enabled"] !== "boolean") return invalid("enabled must be a boolean");
		patch.enabled = value["enabled"];
	}
	if (value["model"] !== undefined) {
		const model = value["model"];
		if (!isRecord(model)) return invalid("model must be an object");
		for (const key of Object.keys(model)) {
			if (key !== "provider" && key !== "model" && key !== "reasoningEffort") {
				return invalid(`unknown field: model.${key}`);
			}
		}
		const provider = model["provider"];
		const name = model["model"];
		const effort = model["reasoningEffort"];
		if (!isBoundedNonEmptyString(provider, LIMITS.providerCharacters)) {
			return invalid(`model.provider must be a non-empty string of at most ${LIMITS.providerCharacters}`);
		}
		if (!isBoundedNonEmptyString(name, LIMITS.modelCharacters)) {
			return invalid(`model.model must be a non-empty string of at most ${LIMITS.modelCharacters}`);
		}
		if (effort !== undefined && effort !== null && !EFFORTS.includes(effort as AdvisorEffort)) {
			return invalid(`model.reasoningEffort must be one of ${EFFORTS.join("|")} or null`);
		}
		patch.model = {
			provider,
			model: name,
			...(effort === undefined ? {} : { reasoningEffort: effort as AdvisorEffort | null }),
		};
	}
	if (value["instructions"] !== undefined) {
		const instructions = value["instructions"];
		if (typeof instructions !== "string" || instructions.length > LIMITS.instructionsCharacters) {
			return invalid(
				`instructions must be a string of at most ${LIMITS.instructionsCharacters} characters`,
			);
		}
		patch.instructions = instructions;
	}
	if (value["review"] !== undefined) {
		const review = value["review"];
		if (!isRecord(review)) return invalid("review must be an object");
		const bounds = {
			everyTurns: LIMITS.everyTurns,
			timeoutMs: LIMITS.timeoutMs,
			maxContextTokens: LIMITS.maxContextTokens,
			maxAdviceChars: LIMITS.maxAdviceChars,
		} as const;
		const fields = Object.keys(bounds) as (keyof typeof bounds)[];
		const next: Partial<AdvisorReviewConfig> = {};
		for (const field of fields) {
			const raw = review[field];
			if (raw === undefined) continue;
			if (!isBoundedPositiveInteger(raw, bounds[field])) {
				return invalid(`review.${field} must be an integer between 1 and ${bounds[field]}`);
			}
			next[field] = raw;
		}
		for (const key of Object.keys(review)) {
			if (!(fields as readonly string[]).includes(key)) return invalid(`unknown field: review.${key}`);
		}
		patch.review = next;
	}
	if (value["delivery"] !== undefined) {
		const delivery = value["delivery"];
		if (!isRecord(delivery)) return invalid("delivery must be an object");
		const severities = delivery["activeIdleSeverities"];
		if (severities !== undefined) {
			if (!Array.isArray(severities)) return invalid("delivery.activeIdleSeverities must be an array");
			// The list is persisted and re-rendered on every status poll, so it is
			// bounded by its own vocabulary: an unbounded array would turn the
			// polling surface into a copy of whatever the caller sent.
			if (severities.length > SEVERITIES.length) {
				return invalid(`delivery.activeIdleSeverities must hold at most ${SEVERITIES.length} entries`);
			}
			for (const severity of severities) {
				if (!SEVERITIES.includes(severity as ActiveIdleSeverity)) {
					return invalid(`delivery.activeIdleSeverities entries must be ${SEVERITIES.join("|")}`);
				}
			}
			patch.delivery = { activeIdleSeverities: [...new Set(severities as ActiveIdleSeverity[])] };
		}
		for (const key of Object.keys(delivery)) {
			if (key !== "activeIdleSeverities") return invalid(`unknown field: delivery.${key}`);
		}
	}
	return { kind: "ok", patch };
}

/** Applies one validated patch over the effective configuration. */
export function applyConfigPatch(base: AdvisorConfig, patch: AdvisorConfigPatch): AdvisorConfig {	// An effort the patch does not name is inherited, not erased: replacing the
	// whole model here silently downgraded a row-configured effort on every save.
	// An explicit `null` is the page asking for that inheritance on purpose.
	let model: AdvisorModelConfig | undefined = base.model;
	if (patch.model !== undefined) {
		const effort =
			patch.model.reasoningEffort === undefined
				? base.model?.reasoningEffort
				: patch.model.reasoningEffort ?? undefined;
		model = {
			provider: patch.model.provider,
			model: patch.model.model,
			...(effort === undefined ? {} : { reasoningEffort: effort }),
		};
	}
	return {
		enabled: patch.enabled ?? base.enabled,
		...(model === undefined ? {} : { model }),
		instructions: patch.instructions ?? base.instructions,
		review: { ...base.review, ...(patch.review ?? {}) },
		delivery: {
			activeIdleSeverities: patch.delivery?.activeIdleSeverities ?? base.delivery.activeIdleSeverities,
		},
		// Protected paths are a security floor owned by the row, never by the page.
		security: base.security,
	};
}

/**
 * The full page-owned projection of one configuration.
 *
 * The store persists this, not the patch the caller happened to send: a partial
 * patch saved as-is would make every field it omitted revert to the row value on
 * the next load, so the settings the page shows would silently change on restart.
 */
export function toConfigPatch(config: AdvisorConfig): AdvisorConfigPatch {
	return {
		enabled: config.enabled,
		...(config.model === undefined
			? {}
			: {
					model: {
						provider: config.model.provider,
						model: config.model.model,
						reasoningEffort: config.model.reasoningEffort ?? null,
					},
				}),
		instructions: config.instructions,
		review: {
			everyTurns: config.review.everyTurns,
			timeoutMs: config.review.timeoutMs,
			maxContextTokens: config.review.maxContextTokens,
			maxAdviceChars: config.review.maxAdviceChars,
		},
		delivery: { activeIdleSeverities: [...config.delivery.activeIdleSeverities] },
	};
}

/**
 * Whether the store can read back what {@link toConfigPatch} produced.
 *
 * The projection copies the effective configuration, so a row value that the
 * page's bounds reject (a row has no upper bound) would otherwise be persisted
 * as a file `parseConfigPatch` refuses on the next load — dropping the whole
 * override layer, including the settings the page did save. Checked before the
 * write so the refusal is reported instead of silently losing the file.
 */
export function canPersistConfigPatch(config: AdvisorConfig): boolean {
	return parseConfigPatch(toConfigPatch(config)).kind === "ok";
}

/** The form-shaped view of the effective configuration. */
export function describeConfig(config: AdvisorConfig): AdvisorConfigView {
	return {
		enabled: config.enabled,
		...(config.model === undefined ? {} : { model: config.model }),
		instructions: config.instructions,
		review: { ...config.review },
		delivery: { activeIdleSeverities: [...config.delivery.activeIdleSeverities] },
	};
}
