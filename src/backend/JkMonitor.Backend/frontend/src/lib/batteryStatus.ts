export type BatteryState = 'CHARGING' | 'DISCHARGING' | 'IDLE';

export interface BatteryStatusResult {
  state: BatteryState;
  ratePerHour: number | null;
  label: string;
}

/** Threshold (absolute %/h) below which SoC change is considered idle. */
const RATE_IDLE_THRESHOLD = 0.3;

/** Current (A) threshold for the fallback when SoC rate is unavailable. */
const CURRENT_IDLE_THRESHOLD = 0.2;

/**
 * Compute the current battery state and SoC change rate from recent telemetry.
 *
 * State detection priority:
 *   1. SoC rate (primary): if we have enough data to compute a meaningful rate,
 *      use it — |rate| < 0.3 %/h is IDLE, positive is CHARGING, negative is DISCHARGING.
 *   2. Instantaneous current (fallback): used only when rate cannot be computed.
 *      |current| < 0.5A → IDLE, positive → CHARGING, negative → DISCHARGING.
 */
export function computeBatteryStatus(
  data: Record<string, unknown>[],
  capacityAh?: number | null,
): BatteryStatusResult {
  // Find the last point with valid current (for fallback / display)
  let lastCurrent: number | null = null;
  for (let i = data.length - 1; i >= 0; i--) {
    const c = data[i].currentAmps;
    if (typeof c === 'number' && isFinite(c)) {
      lastCurrent = c;
      break;
    }
  }

  // Primary: compute rate from current / capacity when available — this is the most
  // accurate method because SoC delta over short windows is quantised and noisy.
  if (capacityAh != null && capacityAh > 0 && lastCurrent != null) {
    const rate = (lastCurrent / capacityAh) * 100;
    let state: BatteryState;
    if (Math.abs(lastCurrent) < CURRENT_IDLE_THRESHOLD) {
      state = 'IDLE';
    } else if (lastCurrent > 0) {
      state = 'CHARGING';
    } else {
      state = 'DISCHARGING';
    }
    if (state === 'IDLE') {
      return { state, ratePerHour: rate, label: 'IDLE' };
    }
    const sign = rate >= 0 ? '+' : '';
    return { state, ratePerHour: rate, label: `${state} ${sign}${rate.toFixed(1)} %/h` };
  }

  // Fallback: SoC delta-based rate when capacity is unavailable
  const rate = computeSocRate(data);

  if (rate != null) {
    let state: BatteryState;
    if (Math.abs(rate) < RATE_IDLE_THRESHOLD) {
      state = 'IDLE';
    } else if (rate > 0) {
      state = 'CHARGING';
    } else {
      state = 'DISCHARGING';
    }
    if (state === 'IDLE') {
      return { state, ratePerHour: rate, label: 'IDLE' };
    }
    const sign = rate >= 0 ? '+' : '';
    return { state, ratePerHour: rate, label: `${state} ${sign}${rate.toFixed(1)} %/h` };
  }

  // Fallback: determine state from instantaneous current
  if (lastCurrent == null) {
    return { state: 'IDLE', ratePerHour: null, label: 'IDLE' };
  }

  let state: BatteryState;
  if (Math.abs(lastCurrent) < CURRENT_IDLE_THRESHOLD) {
    state = 'IDLE';
  } else if (lastCurrent > 0) {
    state = 'CHARGING';
  } else {
    state = 'DISCHARGING';
  }

  return { state, ratePerHour: null, label: state };
}

/**
 * Determine battery state from a single current reading (for real-time tiles).
 * Uses the same sign convention: positive = charging, negative = discharging.
 */
export function getBatteryStateFromCurrent(currentAmps: number | null | undefined): BatteryState {
  if (currentAmps == null || !isFinite(currentAmps)) return 'IDLE';
  if (Math.abs(currentAmps) < CURRENT_IDLE_THRESHOLD) return 'IDLE';
  return currentAmps > 0 ? 'CHARGING' : 'DISCHARGING';
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
