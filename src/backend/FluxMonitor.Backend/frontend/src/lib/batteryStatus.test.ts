import { describe, it, expect } from 'vitest';
import { computeBatteryStatus, getBatteryStateFromCurrent } from './batteryStatus';

describe('computeBatteryStatus', () => {
  describe('rate-based state detection (primary)', () => {
    it('returns CHARGING when SoC rate is significantly positive', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 5, stateOfChargePercent: 55, timestamp: '2026-03-23T13:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('CHARGING');
      expect(result.ratePerHour).toBeCloseTo(5, 0);
    });

    it('returns DISCHARGING when SoC rate is significantly negative', () => {
      const data = [
        { currentAmps: -3, stateOfChargePercent: 80, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: -3, stateOfChargePercent: 77, timestamp: '2026-03-23T13:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('DISCHARGING');
      expect(result.ratePerHour).toBeCloseTo(-3, 0);
    });

    it('returns IDLE when SoC rate is near zero even with nonzero current', () => {
      // Key fix: small current but SoC flat → IDLE
      const data = [
        { currentAmps: -0.3, stateOfChargePercent: 98, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: -0.3, stateOfChargePercent: 98, timestamp: '2026-03-23T13:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('IDLE');
      expect(result.label).toBe('IDLE');
    });

    it('rate threshold: |rate| < 0.3 is IDLE', () => {
      const data = [
        { currentAmps: 2, stateOfChargePercent: 50.0, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 2, stateOfChargePercent: 50.05, timestamp: '2026-03-23T12:10:00Z' },
      ];
      // rate = 0.05 / (10/60) = 0.3 %/h — exactly at threshold, but < check, so IDLE
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('IDLE');
    });

    it('calculates ~20 %/h for 2% gain over 6 minutes', () => {
      const data = [
        { currentAmps: 10, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 10, stateOfChargePercent: 52, timestamp: '2026-03-23T12:06:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.ratePerHour).toBeCloseTo(20, 0);
      expect(result.state).toBe('CHARGING');
    });
  });

  describe('current-based state detection (fallback)', () => {
    it('falls back to current when no rate (single data point)', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('CHARGING');
      expect(result.ratePerHour).toBeNull();
    });

    it('returns DISCHARGING from current fallback', () => {
      const data = [
        { currentAmps: -3, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('DISCHARGING');
    });

    it('returns IDLE when |current| < 0.2A (fallback threshold)', () => {
      const data = [
        { currentAmps: 0.15, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('IDLE');
    });

    it('returns IDLE for empty data', () => {
      expect(computeBatteryStatus([]).state).toBe('IDLE');
      expect(computeBatteryStatus([]).label).toBe('IDLE');
    });

    it('returns IDLE when no valid current exists', () => {
      const data = [{ currentAmps: null, stateOfChargePercent: 50 }];
      expect(computeBatteryStatus(data).state).toBe('IDLE');
    });

    it('returns null rate when not enough time span (< 2 min)', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 5, stateOfChargePercent: 51, timestamp: '2026-03-23T12:01:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.ratePerHour).toBeNull();
    });
  });

  describe('label formatting', () => {
    it('formats CHARGING with positive rate', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 5, stateOfChargePercent: 55, timestamp: '2026-03-23T13:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.label).toContain('CHARGING');
      expect(result.label).toContain('+');
      expect(result.label).toContain('%/h');
    });

    it('formats DISCHARGING with negative rate', () => {
      const data = [
        { currentAmps: -3, stateOfChargePercent: 80, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: -3, stateOfChargePercent: 77, timestamp: '2026-03-23T13:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.label).toContain('DISCHARGING');
      expect(result.label).toContain('-');
      expect(result.label).toContain('%/h');
    });

    it('formats IDLE without rate info', () => {
      const data = [
        { currentAmps: 0, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).label).toBe('IDLE');
    });

    it('shows state name (no rate) when fallback to current', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).label).toBe('CHARGING');
    });
  });
});

describe('getBatteryStateFromCurrent', () => {
  it('returns IDLE for null', () => {
    expect(getBatteryStateFromCurrent(null)).toBe('IDLE');
    expect(getBatteryStateFromCurrent(undefined)).toBe('IDLE');
  });

  it('returns IDLE for small current', () => {
    expect(getBatteryStateFromCurrent(0.1)).toBe('IDLE');
    expect(getBatteryStateFromCurrent(-0.15)).toBe('IDLE');
  });

  it('returns CHARGING for positive current above threshold', () => {
    expect(getBatteryStateFromCurrent(1.0)).toBe('CHARGING');
  });

  it('returns DISCHARGING for negative current below threshold', () => {
    expect(getBatteryStateFromCurrent(-1.0)).toBe('DISCHARGING');
  });
});
