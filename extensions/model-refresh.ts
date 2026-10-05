export interface IdentifiedModel {
	readonly id: string;
}

/**
 * Merge a refreshed catalog over the configured and cached model definitions.
 *
 * Normal refreshes keep the cached catalog as a fallback. This matters for
 * models selected as a user's default: a gateway can return a temporarily
 * incomplete catalog without making that model disappear from the next
 * session. Fresh catalog entries are applied last so their metadata wins.
 *
 * A forced refresh can opt out of the cache fallback when the caller wants the
 * remote catalog to be authoritative.
 */
export function mergeModelRefresh<T extends IdentifiedModel>(
	configured: readonly T[],
	cached: readonly T[],
	refreshed: readonly T[],
	preserveCached = true,
): T[] {
	const sources = preserveCached ? [configured, cached, refreshed] : [configured, refreshed];
	const models = new Map<string, T>();
	for (const source of sources) {
		for (const model of source) models.set(model.id, model);
	}
	return [...models.values()];
}
