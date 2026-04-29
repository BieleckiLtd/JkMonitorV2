import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviceDefinition, DeviceDefinitionSummary } from '../types/deviceDefinition';

/** In-memory cache for loaded definitions (survives re-renders, cleared on page reload). */
const definitionCache = new Map<string, DeviceDefinition>();

function getDefinitionCacheKey(definitionId: string, deviceId?: string | null) {
  return deviceId ? `${definitionId}::${deviceId}` : definitionId;
}

/**
 * Fetches and caches a device definition by its id.
 * Returns null while loading or if no definitionId is provided.
 */
export function useDeviceDefinition(definitionId: string | null | undefined, deviceId?: string | null) {
  const [definition, setDefinition] = useState<DeviceDefinition | null>(
    definitionId ? definitionCache.get(getDefinitionCacheKey(definitionId, deviceId)) ?? null : null
  );

  useEffect(() => {
    if (!definitionId) {
      setDefinition(null);
      return;
    }

    const cacheKey = getDefinitionCacheKey(definitionId, deviceId);

    const cached = definitionCache.get(cacheKey);
    if (cached) {
      setDefinition(cached);
    } else {
      setDefinition(null);
    }

    let cancelled = false;

    const load = async () => {
      try {
        const query = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : '';
        const resp = await fetch(`/api/definitions/${encodeURIComponent(definitionId)}${query}`, { cache: 'no-store' });
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as DeviceDefinition;
        definitionCache.set(cacheKey, data);
        if (!cancelled) setDefinition(data);
      } catch {
        // Silently fail — the page will just render with the legacy layout
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [definitionId, deviceId]);

  return definition;
}

/**
 * Fetches the list of all available device definition summaries.
 * Returns { definitions, refresh } where refresh reloads from the server.
 */
export function useDeviceDefinitions() {
  const [definitions, setDefinitions] = useState<DeviceDefinitionSummary[]>([]);
  const loaded = useRef(false);

  const load = useCallback(async (options?: { includeRemote?: boolean }) => {
    try {
      const params = new URLSearchParams();
      if (options?.includeRemote) {
        params.set('includeRemote', 'true');
      }

      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      const resp = await fetch(`/api/definitions${suffix}`);
      if (!resp.ok) return;
      const data = (await resp.json()) as DeviceDefinitionSummary[];
      setDefinitions(data);
      loaded.current = true;
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (loaded.current) return;
    void load();
  }, [load]);

  return { definitions, refresh: load };
}
