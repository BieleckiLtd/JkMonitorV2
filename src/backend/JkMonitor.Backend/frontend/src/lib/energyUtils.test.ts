import { describe, it, expect } from 'vitest';
import { computeEnergyData, computeEnergyGradientStops, formatEnergyValue, getIntervalHours } from './energyUtils';

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
  it('charging (positive current) produces positive signedPowerKw', () => {
    const data = [{ powerWatts: 500, currentAmps: 2, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBe(0.5);
  });

  it('discharging (negative current) produces negative signedPowerKw', () => {
    const data = [{ powerWatts: 1000, currentAmps: -5, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    expect(result.energyData[0].signedPowerKw).toBe(-1.0);
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

    expect(result.energyData[0].signedPowerKw).toBe(0.5);
    expect(result.energyData[0].displayPowerKw).toBe(0.5);
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

    // signedKw = +0.3  →  dMax = 0.3, dMin = 0
    // yMin = min(0, -0.5) = -0.5,  yMax = max(0.3, 0.5) = 0.5
    expect(result.yDomain[0]).toBeLessThanOrEqual(-0.5);
    expect(result.yDomain[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('preserves ±0.5 margin when all data is on the discharge side', () => {
    const data = [{ powerWatts: 200, currentAmps: -1, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = -0.2,  dMin = -0.2
    // yMin = min(-0.2, -0.5) = -0.5,  yMax = max(0, 0.5) = 0.5
    expect(result.yDomain[0]).toBeLessThanOrEqual(-0.5);
    expect(result.yDomain[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('expands beyond ±0.5 for larger values', () => {
    const data = [{ powerWatts: 3000, currentAmps: -10, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = -3.0 → yMin should be -3.0
    expect(result.yDomain[0]).toBe(-3.0);
    expect(result.yDomain[1]).toBeGreaterThanOrEqual(0.5);
  });

  it('returns default ±0.5 for empty data', () => {
    const result = computeEnergyData([], '1m');
    expect(result.yDomain).toEqual([-0.5, 0.5]);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyData — zeroOffset for gradient
// ---------------------------------------------------------------------------
describe('computeEnergyData zeroOffset (bbox-based)', () => {
  it('is 0.5 when discharge and charge magnitudes are equal', () => {
    const data = [
      { powerWatts: 1000, currentAmps: -5, time: '12:00' },  // -1kW discharge
      { powerWatts: 1000, currentAmps: 5, time: '12:01' },   // +1kW charge
    ];
    const result = computeEnergyData(data, '1m');

    // dMax=1, dMin=-1, bboxRange=2, zeroOffset = 1/2 = 0.5
    expect(result.zeroOffset).toBeCloseTo(0.5, 2);
  });

  it('is 1 when all data is charge (zero at bottom of bbox)', () => {
    const data = [{ powerWatts: 600, currentAmps: 3, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = +0.6, dMax = 0.6, dMin = 0
    // bboxRange = 0.6, zeroOffset = 0.6 / 0.6 = 1
    expect(result.zeroOffset).toBe(1);
  });

  it('is 0 when all data is discharge (zero at top of bbox)', () => {
    const data = [{ powerWatts: 800, currentAmps: -4, time: '12:00' }];
    const result = computeEnergyData(data, '1m');

    // signedKw = -0.8, dMax = 0, dMin = -0.8
    // bboxRange = 0.8, zeroOffset = 0 / 0.8 = 0
    expect(result.zeroOffset).toBe(0);
  });

  it('reflects actual data ratio, not padded yDomain', () => {
    const data = [
      { powerWatts: 300, currentAmps: -2, time: '12:00' },  // -0.3 kW discharge
      { powerWatts: 600, currentAmps: 3, time: '12:01' },   // +0.6 kW charge
    ];
    const result = computeEnergyData(data, '1m');

    // dMax = 0.6, dMin = -0.3, bboxRange = 0.9
    expect(result.zeroOffset).toBeCloseTo(0.6 / 0.9, 4);
  });

  it('is 0.5 for empty data', () => {
    const result = computeEnergyData([], '1m');
    expect(result.zeroOffset).toBe(0.5);
  });

  it('is 0.5 when all data is zero power', () => {
    const data = [{ powerWatts: 0, currentAmps: 0, time: '12:00' }];
    const result = computeEnergyData(data, '1m');
    expect(result.zeroOffset).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeEnergyGradientStops
// ---------------------------------------------------------------------------
describe('computeEnergyGradientStops', () => {
  it('returns 4 stops for mixed data with green above / red below baseline', () => {
    const stops = computeEnergyGradientStops(0.5);
    expect(stops).toHaveLength(4);
    expect(stops[0]).toEqual({ offset: '0%', opacity: 0.45, color: '#34d399' });
    expect(stops[1]).toEqual({ offset: '50.0%', opacity: 0.09, color: '#34d399' });
    expect(stops[2]).toEqual({ offset: '50.0%', opacity: 0.09, color: '#f87171' });
    expect(stops[3]).toEqual({ offset: '100%', opacity: 0.45, color: '#f87171' });
  });

  it('returns 2 stops when zero at top (only discharge, red)', () => {
    const stops = computeEnergyGradientStops(0);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({ offset: '0%', opacity: 0.09, color: '#f87171' });
    expect(stops[1]).toEqual({ offset: '100%', opacity: 0.45, color: '#f87171' });
  });

  it('returns 2 stops when zero at bottom (only charge, green)', () => {
    const stops = computeEnergyGradientStops(1);
    expect(stops).toHaveLength(2);
    expect(stops[0]).toEqual({ offset: '0%', opacity: 0.45, color: '#34d399' });
    expect(stops[1]).toEqual({ offset: '100%', opacity: 0.09, color: '#34d399' });
  });

  it('baseline opacity is minOpacity (20% of max) for mixed data', () => {
    for (const z of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const stops = computeEnergyGradientStops(z);
      const zPct = `${(z * 100).toFixed(1)}%`;
      const baselineStops = stops.filter(s => s.offset === zPct);
      expect(baselineStops).toHaveLength(2); // green + red at the boundary
      baselineStops.forEach(s => expect(s.opacity).toBe(0.09));
    }
  });

  it('extremes always have maxOpacity', () => {
    for (const z of [0.1, 0.5, 0.9]) {
      const stops = computeEnergyGradientStops(z, 0.6);
      expect(stops[0].opacity).toBe(0.6);
      expect(stops[stops.length - 1].opacity).toBe(0.6);
    }
  });

  it('respects custom maxOpacity and minOpacity', () => {
    const stops = computeEnergyGradientStops(0.5, 0.8, 0.08);
    expect(stops[0].opacity).toBe(0.8);
    expect(stops[3].opacity).toBe(0.8);
    expect(stops[1].opacity).toBe(0.08);
    expect(stops[2].opacity).toBe(0.08);
  });

  it('uses custom colors', () => {
    const stops = computeEnergyGradientStops(0.5, 0.45, 0.09, '#00ff00', '#ff0000');
    expect(stops[0].color).toBe('#00ff00');
    expect(stops[1].color).toBe('#00ff00');
    expect(stops[2].color).toBe('#ff0000');
    expect(stops[3].color).toBe('#ff0000');
  });

  it('clamps zeroOffset to [0, 1]', () => {
    const stopsNeg = computeEnergyGradientStops(-0.5);
    expect(stopsNeg).toHaveLength(2); // treated as zero at top
    expect(stopsNeg[0].opacity).toBe(0.09);

    const stopsOver = computeEnergyGradientStops(1.5);
    expect(stopsOver).toHaveLength(2); // treated as zero at bottom
    expect(stopsOver[0].opacity).toBe(0.45);
    expect(stopsOver[1].opacity).toBe(0.09);
  });

  it('asymmetric offset positions baseline stops correctly', () => {
    // charge 0.6, discharge 0.3 → zeroOffset ≈ 0.667
    const z = 0.6 / 0.9;
    const stops = computeEnergyGradientStops(z);
    expect(stops).toHaveLength(4);
    const zPct = `${(z * 100).toFixed(1)}%`;
    expect(stops[1].offset).toBe(zPct);
    expect(stops[1].opacity).toBe(0.09);
    expect(stops[1].color).toBe('#34d399');
    expect(stops[2].offset).toBe(zPct);
    expect(stops[2].opacity).toBe(0.09);
    expect(stops[2].color).toBe('#f87171');
  });
});

// ---------------------------------------------------------------------------
// formatEnergyValue — absolute values with labels
// ---------------------------------------------------------------------------
describe('formatEnergyValue', () => {
  it('shows "Charged" for positive values (above baseline)', () => {
    const result = formatEnergyValue(2.3);
    expect(result.text).toBe('2.3 kW');
    expect(result.label).toBe('Charged');
    expect(result.isZero).toBe(false);
  });

  it('shows "Discharged" for negative values (below baseline)', () => {
    const result = formatEnergyValue(-4.7);
    expect(result.text).toBe('4.7 kW');
    expect(result.label).toBe('Discharged');
    expect(result.isZero).toBe(false);
  });

  it('shows "Idle" label for exactly zero and marks isZero', () => {
    const result = formatEnergyValue(0);
    expect(result.text).toBe('0.0 kW');
    expect(result.label).toBe('Idle');
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
