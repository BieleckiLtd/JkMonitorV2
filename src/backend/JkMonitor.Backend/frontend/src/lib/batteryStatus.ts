export type BatteryState = 'CHARGING' | 'DISCHARGING' | 'IDLE';

export interface BatteryStatusResult {
  state: BatteryState;
  ratePerHour: number | null;
  label: string;
}

/**
 * Compute the current battery state and SoC change rate from recent telemetry.
 *
 * Uses the last data point's current to determine state (positive = charging,
 * negative = discharging, ~0 = idle) and computes rate from SoC delta over
 * a trailing window of data points.
 *
 * @param data Array of telemetry points with `currentAmps` and `stateOfChargePercent`
 * @param resolution The current time resolution for rate calculation
 * @returns Battery state, rate (%/h), and a formatted label string
 */
export function computeBatteryStatus(
  data: Record<string, unknown>[],
): BatteryStatusResult {
  // Find the last point with valid current
  let lastCurrent: number | null = null;
  for (let i = data.length - 1; i >= 0; i--) {
    const c = data[i].currentAmps;
    if (typeof c === 'number' && isFinite(c)) {
      lastCurrent = c;
      break;
    }
  }

  if (lastCurrent == null) {
    return { state: 'IDLE', ratePerHour: null, label: 'IDLE' };
  }

  // Determine state from current (positive = charging for JK BMS)
  const idleThreshold = 0.1; // amps
  let state: BatteryState;
  if (Math.abs(lastCurrent) < idleThreshold) {
    state = 'IDLE';
  } else if (lastCurrent > 0) {
    state = 'CHARGING';
  } else {
    state = 'DISCHARGING';
  }

  // Compute rate: find two points with valid SoC and timestamps far enough apart
  const rate = computeSocRate(data);

  if (state === 'IDLE') {
    return { state, ratePerHour: null, label: 'IDLE' };
  }

  if (rate != null) {
    const sign = rate >= 0 ? '+' : '';
    return {
      state,
      ratePerHour: rate,
      label: `${state} ${sign}${rate.toFixed(1)} %/h`,
    };
  }

  return { state, ratePerHour: null, label: state };
}

function computeSocRate(data: Record<string, unknown>[]): number | null {
  // Walk backwards to find the latest and an earlier point with SoC + timestamp
  let latestSoc: number | null = null;
  let latestTs: number | null = null;
  let earlierSoc: number | null = null;
  let earlierTs: number | null = null;

  for (let i = data.length - 1; i >= 0; i--) {
    const soc = data[i].stateOfChargePercent;
    const ts = data[i].timestamp;
    if (typeof soc !== 'number' || !isFinite(soc)) continue;
    if (typeof ts !== 'string') continue;
    const time = new Date(ts).getTime();
    if (isNaN(time)) continue;

    if (latestSoc == null) {
      latestSoc = soc;
      latestTs = time;
      continue;
    }

    // Need at least 2 minutes of separation for a meaningful rate
    if (latestTs! - time >= 120_000) {
      earlierSoc = soc;
      earlierTs = time;
      break;
    }
  }

  if (latestSoc == null || earlierSoc == null || latestTs == null || earlierTs == null) {
    return null;
  }

  const deltaHours = (latestTs - earlierTs) / 3_600_000;
  if (deltaHours <= 0) return null;

  return (latestSoc - earlierSoc) / deltaHours;
}
