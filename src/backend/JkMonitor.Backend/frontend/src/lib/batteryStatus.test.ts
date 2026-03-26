import { describe, it, expect } from 'vitest';
import { computeBatteryStatus, type BatteryState } from './batteryStatus';

describe('computeBatteryStatus', () => {
  describe('state detection from current', () => {
    it('returns CHARGING when last current is positive', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('CHARGING');
    });

    it('returns DISCHARGING when last current is negative', () => {
      const data = [
        { currentAmps: -3, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('DISCHARGING');
    });

    it('returns IDLE when current is near zero', () => {
      const data = [
        { currentAmps: 0.05, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('IDLE');
    });

    it('returns IDLE when current is exactly zero', () => {
      const data = [
        { currentAmps: 0, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
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

    it('uses the LAST data point current for state', () => {
      const data = [
        { currentAmps: 10, stateOfChargePercent: 40, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: -5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:10:00Z' },
      ];
      expect(computeBatteryStatus(data).state).toBe('DISCHARGING');
    });
  });

  describe('rate calculation', () => {
    it('computes positive rate when SoC is increasing (charging)', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 5, stateOfChargePercent: 51, timestamp: '2026-03-23T12:03:00Z' },
        { currentAmps: 5, stateOfChargePercent: 52, timestamp: '2026-03-23T12:06:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('CHARGING');
      expect(result.ratePerHour).not.toBeNull();
      expect(result.ratePerHour!).toBeGreaterThan(0);
    });

    it('computes negative rate when SoC is decreasing (discharging)', () => {
      const data = [
        { currentAmps: -3, stateOfChargePercent: 80, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: -3, stateOfChargePercent: 79, timestamp: '2026-03-23T12:03:00Z' },
        { currentAmps: -3, stateOfChargePercent: 78, timestamp: '2026-03-23T12:06:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('DISCHARGING');
      expect(result.ratePerHour).not.toBeNull();
      expect(result.ratePerHour!).toBeLessThan(0);
    });

    it('returns null rate for IDLE state', () => {
      const data = [
        { currentAmps: 0.01, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('IDLE');
      expect(result.ratePerHour).toBeNull();
    });

    it('returns null rate when not enough time span', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 5, stateOfChargePercent: 51, timestamp: '2026-03-23T12:01:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.state).toBe('CHARGING');
      expect(result.ratePerHour).toBeNull();
    });

    it('calculates ~20 %/h for 2% gain over 6 minutes', () => {
      const data = [
        { currentAmps: 10, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
        { currentAmps: 10, stateOfChargePercent: 52, timestamp: '2026-03-23T12:06:00Z' },
      ];
      const result = computeBatteryStatus(data);
      expect(result.ratePerHour).toBeCloseTo(20, 0);
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

    it('formats IDLE without rate', () => {
      const data = [
        { currentAmps: 0, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).label).toBe('IDLE');
    });

    it('shows state name without rate when not enough data', () => {
      const data = [
        { currentAmps: 5, stateOfChargePercent: 50, timestamp: '2026-03-23T12:00:00Z' },
      ];
      expect(computeBatteryStatus(data).label).toBe('CHARGING');
    });
  });
});
