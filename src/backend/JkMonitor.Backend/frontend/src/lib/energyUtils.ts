export type Resolution = '1s' | '1m' | '5m' | '1h';

export function getIntervalHours(resolution: Resolution): number {
  switch (resolution) {
    case '1s': return 1 / 3600;
    case '1m': return 1 / 60;
    case '5m': return 5 / 60;
    case '1h': return 1;
  }
}

export interface EnergyComputationResult {
  energyData: Record<string, unknown>[];
  dischargedKwh: number;
  chargedKwh: number;
  yDomain: [number, number];
  zeroOffset: number;
}

/**
 * Compute signed-power series and running energy totals from raw telemetry.
 *
 * Sign convention (matches JK BMS):
 *   positive current → battery is charging  → signedPowerKw is **negative** (below baseline)
 *   negative current → battery is discharging → signedPowerKw is **positive** (above baseline)
 *
 * The returned yDomain always keeps at least ±0.5 kW around the zero baseline
 * so the reference line is visible even when all readings are on one side.
 */
export function computeEnergyData(
  data: Record<string, unknown>[],
  resolution: Resolution,
): EnergyComputationResult {
  const intervalHours = getIntervalHours(resolution);
  let discharged = 0;
  let charged = 0;
  let dMax = 0;
  let dMin = 0;

  const processed = data.map((p) => {
    const power = typeof p.powerWatts === 'number' ? p.powerWatts : null;
    const current = typeof p.currentAmps === 'number' ? p.currentAmps : null;
    if (power == null || current == null) return { ...p, signedPowerKw: null };

    const signedKw = current >= 0 ? -power / 1000 : power / 1000;
    if (signedKw > dMax) dMax = signedKw;
    if (signedKw < dMin) dMin = signedKw;
    if (current < 0) discharged += power * intervalHours;
    else charged += power * intervalHours;
    return { ...p, signedPowerKw: signedKw };
  });

  // Ensure at least ±0.5 kW margin around the zero baseline
  const yMin = Math.min(dMin, -0.5);
  const yMax = Math.max(dMax, 0.5);
  const range = yMax - yMin || 1;

  return {
    energyData: processed,
    dischargedKwh: discharged / 1000,
    chargedKwh: charged / 1000,
    yDomain: [yMin, yMax],
    zeroOffset: Math.max(0, Math.min(1, yMax / range)),
  };
}

/**
 * Format a signed-power value for display. Always shows absolute magnitude
 * with a "Charged" / "Discharged" label so users never see confusing negatives.
 */
export function formatEnergyValue(kw: number | null): { text: string; label: string } {
  if (kw == null) return { text: 'N/D', label: '' };
  const abs = Math.abs(kw);
  if (kw > 0) return { text: `${abs.toFixed(1)} kW`, label: 'Discharged' };
  if (kw < 0) return { text: `${abs.toFixed(1)} kW`, label: 'Charged' };
  return { text: '0.0 kW', label: '' };
}
