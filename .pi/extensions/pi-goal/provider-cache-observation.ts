import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
	version: 1;
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

/** Register the durable provider-cache observation Interface. */
export function registerProviderCacheObservation(_pi: ExtensionAPI): void {
	// Contract seed. The lane writer supplies the implementation.
}
