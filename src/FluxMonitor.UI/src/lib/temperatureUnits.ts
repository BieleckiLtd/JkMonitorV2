export type TemperatureUnit = 'c' | 'f';

export function isCelsiusUnit(unit?: string | null): boolean {
  if (!unit) {
    return false;
  }

  const normalized = unit.trim().toLowerCase();
  return normalized === '°c' || normalized === 'c';
}

export function convertTemperatureValue(
  value: number | null | undefined,
  temperatureUnit: TemperatureUnit,
): number | null | undefined {
  if (value == null || !Number.isFinite(value) || temperatureUnit === 'c') {
    return value;
  }

  return (value * 9 / 5) + 32;
}

export function getTemperatureDisplayUnit(
  sourceUnit: string | null | undefined,
  temperatureUnit: TemperatureUnit,
): string | null | undefined {
  if (!isCelsiusUnit(sourceUnit)) {
    return sourceUnit;
  }

  return temperatureUnit === 'f' ? '°F' : '°C';
}
