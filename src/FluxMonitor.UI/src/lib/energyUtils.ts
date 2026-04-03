export type Resolution = '1s' | '1h' | `${number}m`;

export function normalizeResolution(resolution: string, fallback: Resolution = '1m'): Resolution {
  const trimmed = resolution.trim();
  if (trimmed === '1s' || trimmed === '1h') {
    return trimmed;
  }

  if (/^\d+m$/.test(trimmed)) {
    const minutes = Number.parseInt(trimmed.slice(0, -1), 10);
    if (minutes > 0) {
      return `${minutes}m` as Resolution;
    }
  }

  return fallback;
}

export function getResolutionMinutes(resolution: Resolution): number | null {
  if (resolution === '1s') {
    return null;
  }

  if (resolution === '1h') {
    return 60;
  }

  return Number.parseInt(resolution.slice(0, -1), 10);
}

export function getIntervalHours(resolution: Resolution): number {
  if (resolution === '1s') {
    return 1 / 3600;
  }

  const minutes = getResolutionMinutes(resolution);
  if (minutes != null) {
    return minutes / 60;
  }

  return 1 / 60;
}

export function getIntervalMilliseconds(resolution: Resolution): number {
  return getIntervalHours(resolution) * 3_600_000;
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
 * Sign convention (flipped for intuitive display):
 *   positive current → battery is charging  → signedPowerKw is **positive** (above baseline)
 *   negative current → battery is discharging → signedPowerKw is **negative** (below baseline)
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

    const signedKw = current >= 0 ? power / 1000 : -power / 1000;
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
  if (kw > 0) return { text: `${abs.toFixed(1)} kW`, label: 'Charged', isZero: false };
  if (kw < 0) return { text: `${abs.toFixed(1)} kW`, label: 'Discharged', isZero: false };
  return { text: '0.0 kW', label: 'Idle', isZero: true };
}

export interface GradientStop {
  offset: string;
  opacity: number;
  color: string;
}

/**
 * Compute SVG linearGradient stops for the energy area chart.
 *
 * The gradient maps to the Area element's objectBoundingBox (SVG default),
 * so `zeroOffset` must represent where y=0 sits within that bbox (0 = top, 1 = bottom).
 *
 * Above baseline: `positiveColor` (green by default — charging).
 * Below baseline: `negativeColor` (red by default — discharging).
 *
 * Opacity: V-shaped profile with `minOpacity` at the zero line ramping
 * to `maxOpacity` at the extremes.
 */
export function computeEnergyGradientStops(
  zeroOffset: number,
  maxOpacity = 0.45,
  minOpacity = 0.09,
  positiveColor = '#34d399',
  negativeColor = '#f87171',
): GradientStop[] {
  const z = Math.max(0, Math.min(1, zeroOffset));

  if (z <= 0.005) {
    // Zero at top – only data below baseline visible
    return [
      { offset: '0%', opacity: minOpacity, color: negativeColor },
      { offset: '100%', opacity: maxOpacity, color: negativeColor },
    ];
  }
  if (z >= 0.995) {
    // Zero at bottom – only data above baseline visible
    return [
      { offset: '0%', opacity: maxOpacity, color: positiveColor },
      { offset: '100%', opacity: minOpacity, color: positiveColor },
    ];
  }

  const zPct = `${(z * 100).toFixed(1)}%`;
  return [
    { offset: '0%', opacity: maxOpacity, color: positiveColor },
    { offset: zPct, opacity: minOpacity, color: positiveColor },
    { offset: zPct, opacity: minOpacity, color: negativeColor },
    { offset: '100%', opacity: maxOpacity, color: negativeColor },
  ];
}
