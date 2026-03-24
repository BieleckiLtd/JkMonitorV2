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
    if (power == null || current == null) return { ...p, signedPowerKw: null, displayPowerKw: null };

    const signedKw = current >= 0 ? -power / 1000 : power / 1000;
    const normalKw = signedKw || 0; // normalise -0 to 0
    if (normalKw > dMax) dMax = normalKw;
    if (normalKw < dMin) dMin = normalKw;
    if (current < 0) discharged += power * intervalHours;
    else charged += power * intervalHours;
    return { ...p, signedPowerKw: normalKw === 0 ? null : normalKw, displayPowerKw: normalKw };
  });

  // Ensure at least ±0.5 kW margin around the zero baseline for the chart axis
  const yMin = Math.min(dMin, -0.5);
  const yMax = Math.max(dMax, 0.5);

  // zeroOffset for the gradient: where y=0 sits within the Area element's
  // bounding box (SVG objectBoundingBox).  The bbox spans from max(0, dMax)
  // at the top to min(0, dMin) at the bottom — NOT the padded yDomain.
  const bboxRange = dMax - dMin;  // dMax >= 0, dMin <= 0
  const zeroOffset = bboxRange > 0 ? dMax / bboxRange : 0.5;

  return {
    energyData: processed,
    dischargedKwh: discharged / 1000,
    chargedKwh: charged / 1000,
    yDomain: [yMin, yMax],
    zeroOffset,
  };
}

/**
 * Format a signed-power value for display. Always shows absolute magnitude
 * with a "Charged" / "Discharged" label so users never see confusing negatives.
 */
export function formatEnergyValue(kw: number | null): { text: string; label: string; isZero: boolean } {
  if (kw == null) return { text: 'N/D', label: '', isZero: false };
  const abs = Math.abs(kw);
  if (kw > 0) return { text: `${abs.toFixed(1)} kW`, label: 'Discharged', isZero: false };
  if (kw < 0) return { text: `${abs.toFixed(1)} kW`, label: 'Charged', isZero: false };
  return { text: '0.0 kW', label: 'Discharged', isZero: true };
}

export interface GradientStop {
  offset: string;
  opacity: number;
}

/**
 * Compute SVG linearGradient stops for the energy area chart.
 *
 * The gradient maps to the Area element's objectBoundingBox (SVG default),
 * so `zeroOffset` must represent where y=0 sits within that bbox (0 = top, 1 = bottom).
 *
 * The result is a simple V-shaped opacity profile: transparent at the zero line,
 * linearly increasing to `maxOpacity` at the extremes (top / bottom of bbox).
 */
export function computeEnergyGradientStops(
  zeroOffset: number,
  maxOpacity = 0.45,
): GradientStop[] {
  const z = Math.max(0, Math.min(1, zeroOffset));

  if (z <= 0.005) {
    // Zero at top – only charge data visible
    return [
      { offset: '0%', opacity: 0 },
      { offset: '100%', opacity: maxOpacity },
    ];
  }
  if (z >= 0.995) {
    // Zero at bottom – only discharge data visible
    return [
      { offset: '0%', opacity: maxOpacity },
      { offset: '100%', opacity: 0 },
    ];
  }

  return [
    { offset: '0%', opacity: maxOpacity },
    { offset: `${(z * 100).toFixed(1)}%`, opacity: 0 },
    { offset: '100%', opacity: maxOpacity },
  ];
}
