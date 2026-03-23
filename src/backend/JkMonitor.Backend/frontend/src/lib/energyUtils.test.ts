import { describe, it, expect } from 'vitest';
import { computeEnergyData, formatEnergyValue, getIntervalHours } from './energyUtils';

// ---------------------------------------------------------------------------
// getIntervalHours
// ---------------------------------------------------------------------------
describe('getIntervalHours', () => {
  it('returns correct fractions for each resolution', () => {
    expect(getIntervalHours('1s')).toBeCloseTo(1 / 3600);
    expect(getIntervalHours('1m')).toBeCloseTo(1 / 60);
    expect(getIntervalHours('5m')).toBeCloseTo(5 / 60);
    expect(getIntervalHours('1h')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyData — sign convention
// ---------------------------------------------------------------------------
describe('computeEnergyData sign convention', () => {
  it('charging (positive current) produces negative signedPowerKw', () => {
    const data = [{ powerWatts: 500, currentAmps: 2, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBe(-0.5);
  });

  it('discharging (negative current) produces positive signedPowerKw', () => {
    const data = [{ powerWatts: 1000, currentAmps: -5, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBe(1.0);
  });

  it('null power or current results in null signedPowerKw and displayPowerKw', () => {
    const data = [
      { powerWatts: null, currentAmps: 2, time: '12:00' },
      { powerWatts: 500, currentAmps: null, time: '12:01' },
    ];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBeNull();
    expect(result.energyData[0].displayPowerKw).toBeNull();
    expect(result.energyData[1].signedPowerKw).toBeNull();
    expect(result.energyData[1].displayPowerKw).toBeNull();
  });

  it('zero power sets signedPowerKw to null but preserves displayPowerKw as 0', () => {
    const data = [{ powerWatts: 0, currentAmps: 0, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBeNull();
    expect(result.energyData[0].displayPowerKw).toBe(0);
  });

  it('non-zero values have matching signedPowerKw and displayPowerKw', () => {
    const data = [{ powerWatts: 500, currentAmps: 2, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBe(-0.5);
    expect(result.energyData[0].displayPowerKw).toBe(-0.5);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyData — energy accumulation
// ---------------------------------------------------------------------------
describe('computeEnergyData energy totals', () => {
  it('accumulates charged kWh when current is positive', () => {
    // 60 data points at 1-minute intervals, all charging at 600W
    const data = Array.from({ length: 60 }, (_, i) => ({
      powerWatts: 600,
      currentAmps: 3,
      time: `12:${String(i).padStart(2, '0')}`,
    }));
    const result = computeEnergyData(data, '1m');

    // 600W × 60 × (1/60 h) = 600 Wh = 0.6 kWh
    expect(result.chargedKwh).toBeCloseTo(0.6, 2);
    expect(result.dischargedKwh).toBe(0);
  });

  it('accumulates discharged kWh when current is negative', () => {
    const data = Array.from({ length: 60 }, (_, i) => ({
      powerWatts: 1200,
      currentAmps: -5,
      time: `12:${String(i).padStart(2, '0')}`,
    }));
    const result = computeEnergyData(data, '1m');

    // 1200W × 60 × (1/60 h) = 1200 Wh = 1.2 kWh
    expect(result.dischargedKwh).toBeCloseTo(1.2, 2);
    expect(result.chargedKwh).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyData — yDomain always includes ±0.5 around zero
// ---------------------------------------------------------------------------
describe('computeEnergyData yDomain', () => {
  it('preserves ±0.5 margin when all data is on the charge side', () => {
    const data = [{ powerWatts: 300, currentAmps: 1.5, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = -0.3  →  dMin = -0.3, dMax = 0
    // yMin = min(-0.3, -0.5) = -0.5,  yMax = max(0, 0.5) = 0.5
    expect(result.yDomain[0]).toBeLessThanOrEqual(-0.5);
    expect(result.yDomain[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('preserves ±0.5 margin when all data is on the discharge side', () => {
    const data = [{ powerWatts: 200, currentAmps: -1, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = +0.2,  dMax = 0.2
    // yMin = min(0, -0.5) = -0.5,  yMax = max(0.2, 0.5) = 0.5
    expect(result.yDomain[0]).toBeLessThanOrEqual(-0.5);
    expect(result.yDomain[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('expands beyond ±0.5 for larger values', () => {
    const data = [{ powerWatts: 3000, currentAmps: -10, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = +3.0 → yMax should be 3.0 (> 0.5)
    expect(result.yDomain[1]).toBe(3.0);
    expect(result.yDomain[0]).toBeLessThanOrEqual(-0.5);
  });

  it('returns default ±0.5 for empty data', () => {
    const result = computeEnergyData([], '1m');
    expect(result.yDomain).toEqual([-0.5, 0.5]);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyData — zeroOffset for gradient
// ---------------------------------------------------------------------------
describe('computeEnergyData zeroOffset', () => {
  it('is 0.5 when range is symmetric around zero', () => {
    const data = [
      { powerWatts: 1000, currentAmps: -5, time: '12:00' },  // +1kW discharge
      { powerWatts: 1000, currentAmps: 5, time: '12:01' },   // -1kW charge
    ];
    const result = computeEnergyData(data, '1m');

    // dMax=1, dMin=-1, yMax=1, yMin=-1, range=2, offset = 1/2 = 0.5
    expect(result.zeroOffset).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// formatEnergyValue — absolute values with labels
// ---------------------------------------------------------------------------
describe('formatEnergyValue', () => {
  it('shows "Discharged" for positive values with isZero false', () => {
    const result = formatEnergyValue(2.3);
    expect(result.text).toBe('2.3 kW');
    expect(result.label).toBe('Discharged');
    expect(result.isZero).toBe(false);
  });

  it('shows "Charged" for negative values with absolute magnitude', () => {
    const result = formatEnergyValue(-4.7);
    expect(result.text).toBe('4.7 kW');
    expect(result.label).toBe('Charged');
    expect(result.isZero).toBe(false);
  });

  it('shows "Discharged" label for exactly zero and marks isZero', () => {
    const result = formatEnergyValue(0);
    expect(result.text).toBe('0.0 kW');
    expect(result.label).toBe('Discharged');
    expect(result.isZero).toBe(true);
  });

  it('isZero is false for non-zero values', () => {
    expect(formatEnergyValue(1.0).isZero).toBe(false);
    expect(formatEnergyValue(-1.0).isZero).toBe(false);
    expect(formatEnergyValue(null).isZero).toBe(false);
  });

  it('shows N/D for null', () => {
    const result = formatEnergyValue(null);
    expect(result.text).toBe('N/D');
    expect(result.label).toBe('');
  });

  it('never shows negative numbers', () => {
    for (const kw of [-0.1, -5.5, -100.0]) {
      const result = formatEnergyValue(kw);
      expect(result.text).not.toContain('-');
    }
  });
});
