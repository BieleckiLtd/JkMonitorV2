import { useEffect, useRef, useState } from 'react';
import type { DeviceDefinition, DeviceDefinitionSummary } from '../types/deviceDefinition';

/** In-memory cache for loaded definitions (survives re-renders, cleared on page reload). */
const definitionCache = new Map<string, DeviceDefinition>();

/**
 * Fetches and caches a device definition by its id.
 * Returns null while loading or if no definitionId is provided.
 */
export function useDeviceDefinition(definitionId: string | null | undefined) {
  const [definition, setDefinition] = useState<DeviceDefinition | null>(
    definitionId ? definitionCache.get(definitionId) ?? null : null
  );

  useEffect(() => {
    if (!definitionId) {
      setDefinition(null);
      return;
    }

    const cached = definitionCache.get(definitionId);
    if (cached) {
      setDefinition(cached);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const resp = await fetch(`/api/definitions/${encodeURIComponent(definitionId)}`);
        if (!resp.ok || cancelled) return;
        const data = (await resp.json()) as DeviceDefinition;
        definitionCache.set(definitionId, data);
        if (!cancelled) setDefinition(data);
      } catch {
        // Silently fail — the page will just render with the legacy layout
      }
    };

    void load();
    return () => { cancelled = true; };
  }, [definitionId]);

  return definition;
}

/**
 * Fetches the list of all available device definition summaries.
 */
export function useDeviceDefinitions() {
  const [definitions, setDefinitions] = useState<DeviceDefinitionSummary[]>([]);
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    const load = async () => {
      try {
        const resp = await fetch('/api/definitions');
        if (!resp.ok) return;
        const data = (await resp.json()) as DeviceDefinitionSummary[];
        setDefinitions(data);
      } catch { /* ignore */ }
    };

    void load();
  }, []);

  return definitions;
}
