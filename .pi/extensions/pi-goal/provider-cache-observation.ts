import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const OBSERVATION_TYPE = "pi-goal-observation";
const OBSERVATION_VERSION = 1 as const;
const SEGMENT_NAMES = ["instructions", "tools", "input"] as const;
type SegmentName = (typeof SEGMENT_NAMES)[number];

type SegmentFingerprint =
	| { available: false }
	| {
		available: true;
		bytes: number;
		sha256: string;
		lcpBytes: number | null;
		comparedToRequestId: string | null;
	};

type ProviderCacheObservation = {
	version: typeof OBSERVATION_VERSION;
	kind: "provider_cache";
	observationId: string;
	requestId: string;
	timestamp: number;
	provider: string | null;
	model: string | null;
	usage: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
	};
	segments: {
		instructions: SegmentFingerprint;
		tools: SegmentFingerprint;
		input: SegmentFingerprint;
	};
};

type SerializedSegment = {
	bytes: Uint8Array;
	sha256: string;
};

type SegmentState = Record<SegmentName, SerializedSegment | null>;

type PendingRequest = {
	requestId: string;
	provider: string | null;
	model: string | null;
	segments: SegmentState;
};

type PreviousRequest = {
	requestId: string;
	segments: SegmentState;
};

type Usage = ProviderCacheObservation["usage"];
type WarningKind = "request" | "usage" | "durability";

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function normalizeIdentity(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function comparisonKey(provider: string | null, model: string | null): string {
	return JSON.stringify([provider, model]);
}

function mint(prefix: string, sequence: number): string {
	return `${prefix}-${sequence}-${Math.random().toString(36).slice(2, 10)}`;
}

function serializeSegment(payload: unknown, name: SegmentName): SerializedSegment | null {
	if (!isObject(payload) || !Object.prototype.hasOwnProperty.call(payload, name)) return null;
	const serialized = JSON.stringify(payload[name]);
	if (typeof serialized !== "string") throw new Error("segment is not JSON serializable");
	const bytes = Buffer.from(serialized, "utf8");
	return {
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

function captureSegments(payload: unknown): SegmentState {
	const segments = {} as SegmentState;
	for (const name of SEGMENT_NAMES) segments[name] = serializeSegment(payload, name);
	return segments;
}

function commonPrefixBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.length, right.length);
	let index = 0;
	while (index < length && left[index] === right[index]) index += 1;
	return index;
}

function fingerprint(current: SerializedSegment | null, previous: PreviousRequest | undefined, name: SegmentName): SegmentFingerprint {
	if (!current) return { available: false };
	const previousSegment = previous?.segments[name];
	return {
		available: true,
		bytes: current.bytes.length,
		sha256: current.sha256,
		lcpBytes: previousSegment ? commonPrefixBytes(previousSegment.bytes, current.bytes) : null,
		comparedToRequestId: previousSegment ? previous?.requestId ?? null : null,
	};
}

function normalizeTokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeUsage(message: Record<string, unknown>): Usage | null {
	const raw = message.usage;
	if (!isObject(raw) || Array.isArray(raw)) return null;
	const input = normalizeTokenCount(raw.input);
	const cacheRead = normalizeTokenCount(raw.cacheRead);
	const cacheWrite = normalizeTokenCount(raw.cacheWrite);
	if (input === null || cacheRead === null || cacheWrite === null) return null;
	return { input, cacheRead, cacheWrite };
}

function modelIdentity(ctx: ExtensionContext): { provider: string | null; model: string | null } {
	const model = ctx.model;
	return {
		provider: normalizeIdentity(model?.provider),
		model: normalizeIdentity(model?.id),
	};
}

/** Register the durable provider-cache observation Interface. */
export function registerProviderCacheObservation(pi: ExtensionAPI): void {
	let pending: PendingRequest | null = null;
	const previousByModel = new Map<string, PreviousRequest>();
	const warnings = new Set<WarningKind>();
	let requestSequence = 0;
	let observationSequence = 0;

	function warn(ctx: ExtensionContext, kind: WarningKind): void {
		if (warnings.has(kind)) return;
		warnings.add(kind);
		const message =
			kind === "request"
				? "Provider cache observation skipped: a payload segment could not be serialized."
				: kind === "usage"
					? "Provider cache observation skipped: provider usage was unavailable or invalid."
					: "Provider cache observation was not durable; continuing without metadata.";
		try {
			ctx.ui.notify(message, "warning");
		} catch {
			// Observation diagnostics must never become a host failure.
		}
	}

	pi.on("before_provider_request", (event, ctx) => {
		// A new request disowns any earlier request that did not reach message_end.
		pending = null;
		try {
			const identity = modelIdentity(ctx);
			const segments = captureSegments(event.payload);
			requestSequence += 1;
			pending = {
				requestId: mint("request", requestSequence),
				provider: identity.provider,
				model: identity.model,
				segments,
			};
		} catch {
			warn(ctx, "request");
		}
		// This module only observes the payload; it never replaces or mutates it.
	});

	pi.on("message_end", (event, ctx) => {
		const request = pending;
		pending = null;
		if (!request) return;
		try {
			const message = event.message;
			if (!isObject(message) || Array.isArray(message) || message.role !== "assistant") return;
			const usage = normalizeUsage(message);
			if (!usage) {
				warn(ctx, "usage");
				return;
			}

			const messageProvider = normalizeIdentity(message.provider);
			const messageModel = normalizeIdentity(message.model);
			if (request.provider !== null && messageProvider !== null && request.provider !== messageProvider) return;
			if (request.model !== null && messageModel !== null && request.model !== messageModel) return;

			const provider = request.provider ?? messageProvider;
			const model = request.model ?? messageModel;
			const previous = previousByModel.get(comparisonKey(provider, model));
			const observation: ProviderCacheObservation = {
				version: OBSERVATION_VERSION,
				kind: "provider_cache",
				observationId: mint("observation", ++observationSequence),
				requestId: request.requestId,
				timestamp: Date.now(),
				provider,
				model,
				usage,
				segments: {
					instructions: fingerprint(request.segments.instructions, previous, "instructions"),
					tools: fingerprint(request.segments.tools, previous, "tools"),
					input: fingerprint(request.segments.input, previous, "input"),
				},
			};

			try {
				pi.appendEntry(OBSERVATION_TYPE, observation);
			} catch {
				warn(ctx, "durability");
				return;
			}
			previousByModel.set(comparisonKey(provider, model), {
				requestId: request.requestId,
				segments: request.segments,
			});
		} catch {
			// Malformed host messages are isolated just like malformed usage.
			warn(ctx, "usage");
		}
	});

	pi.on("session_start", () => {
		pending = null;
		previousByModel.clear();
		warnings.clear();
	});
}
