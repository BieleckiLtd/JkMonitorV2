import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { EnergyChartSection } from './HistoryCharts';

// ---------------------------------------------------------------------------
// jsdom stubs – Recharts needs ResizeObserver and element sizing
// ---------------------------------------------------------------------------
beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    constructor(_callback: ResizeObserverCallback) {
      void _callback;
    }

    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
});

// Mock Recharts so we don't need real SVG layout in jsdom.
// We only need to verify the DOM *around* the chart (pill, labels, markers).
vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Noop = () => null;
  return {
    ResponsiveContainer: Passthrough,
    AreaChart: Passthrough,
    Area: Noop,
    ReferenceLine: Noop,
    ReferenceDot: ({ x, r }: { x?: string; r?: number }) => (
      <span data-testid='ref-dot' data-x={x} data-r={r} />
    ),
    XAxis: Noop,
    YAxis: ({ orientation, ticks, tickFormatter }: {
      orientation?: string;
      ticks?: number[];
      tickFormatter?: (value: number) => string;
    }) => (
      <span
        data-testid='y-axis'
        data-orientation={orientation}
        data-ticks={JSON.stringify(ticks ?? [])}
        data-labels={JSON.stringify((ticks ?? []).map((tick) => tickFormatter ? tickFormatter(tick) : String(tick)))}
      />
    ),
    Tooltip: Noop,
    CartesianGrid: Noop,
  };
});

// ---------------------------------------------------------------------------
// Helpers – build minimal telemetry data recognised by computeEnergyData
// ---------------------------------------------------------------------------
function makePoint(
  time: string,
  timestamp: string,
  powerWatts: number | null,
  currentAmps: number | null,
) {
  return { time, timestamp, powerWatts, currentAmps };
}

const baseTimestamp = '2026-03-23T12:00:00Z';

function isoAt(minutesOffset: number) {
  const d = new Date(baseTimestamp);
  d.setMinutes(d.getMinutes() + minutesOffset);
  return d.toISOString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EnergyChartSection', () => {
  it('renders without crashing with empty data', () => {
    render(<EnergyChartSection data={[]} resolution='1m' displayMode='1h' />);
    expect(screen.getByText('Energy')).toBeInTheDocument();
  });

  it('renders charged and discharged kWh labels', () => {
    const data = [
      makePoint('12:00', isoAt(0), 600, -3), // discharging
      makePoint('12:01', isoAt(1), 400, 2),   // charging
    ];
    const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);

    expect(container.textContent).toContain('Charged:');
    expect(container.textContent).toContain('Discharged:');
  });

  it('keeps power in the title row metadata and groups energy totals below it', () => {
    const data = [
      makePoint('12:00', isoAt(0), 600, -3), // discharging
      makePoint('12:01', isoAt(1), 400, 2),   // charging
    ];
    const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);

    const powerLegend = within(container).getByTestId('energy-power-legend');
    const totalsLegend = within(container).getByTestId('energy-totals-legend');

    expect(powerLegend).toHaveTextContent('Power');
    expect(totalsLegend).toHaveTextContent('Charged:');
    expect(totalsLegend).toHaveTextContent('Discharged:');
    expect(totalsLegend).not.toContainElement(powerLegend);
  });

  it('shows charged label with ↑ arrow (above baseline)', () => {
    const data = [
      makePoint('12:00', isoAt(0), 400, 2), // charging
    ];
    const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);
    // The ↑ arrow is before the Charged label
    expect(container.textContent).toContain('↑');
    expect(container.textContent).toContain('Charged:');
  });

  it('shows discharged label with ↓ arrow (below baseline)', () => {
    const data = [
      makePoint('12:00', isoAt(0), 600, -3), // discharging
    ];
    const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);
    expect(container.textContent).toContain('↓');
    expect(container.textContent).toContain('Discharged:');
  });

  describe('baseline markers by resolution', () => {
    it('renders dots for 5m resolution (24h mode - every hour)', () => {
      // Create data spanning 12:00 → 14:00 at 5-min resolution
      const data = Array.from({ length: 25 }, (_, i) => {
        const ts = isoAt(i * 5);
        const d = new Date(ts);
        const time = `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
        return makePoint(time, ts, 100, -1);
      });
      render(<EnergyChartSection data={data} resolution='5m' displayMode='24h' />);

      const dots = screen.getAllByTestId('ref-dot');
      expect(dots.length).toBeGreaterThanOrEqual(1);
    });

    it('renders dots for 1s resolution (10-min mode - every minute)', () => {
      // Create data for 3 minutes with 1s resolution
      const data = Array.from({ length: 180 }, (_, i) => {
        const ts = isoAt(i / 60); // every second
        const d = new Date(ts);
        const time = `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}:${d.getUTCSeconds().toString().padStart(2, '0')}`;
        return makePoint(time, ts, 100, -1);
      });
      render(<EnergyChartSection data={data} resolution='1s' displayMode='10m' />);

      const dots = screen.getAllByTestId('ref-dot');
      // Should have dots for each minute boundary
      expect(dots.length).toBeGreaterThanOrEqual(1);
    });

    it('renders dots for 1m resolution (1h mode - every 10 minutes)', () => {
      // Create data for 30 minutes at 1-min resolution
      const data = Array.from({ length: 30 }, (_, i) => {
        const ts = isoAt(i);
        const d = new Date(ts);
        const time = `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
        return makePoint(time, ts, 100, -1);
      });
      render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);

      const dots = screen.getAllByTestId('ref-dot');
      // Should have roughly 3 dots (one per 10-min slot: :00, :10, :20)
      expect(dots.length).toBeGreaterThanOrEqual(2);
    });

    it('renders major (larger) dots at 6h boundaries for 1h resolution', () => {
      // Create data spanning multiple 6h boundaries
      const data = Array.from({ length: 13 }, (_, i) => {
        const ts = new Date('2026-03-23T00:00:00Z');
        ts.setHours(i);
        const time = `${ts.getUTCHours().toString().padStart(2, '0')}:00`;
        return makePoint(time, ts.toISOString(), 100, -1);
      });
      render(<EnergyChartSection data={data} resolution='1h' displayMode='7d' />);

      const dots = screen.getAllByTestId('ref-dot');
      // 6h boundaries at 0:00, 6:00, 12:00 should be larger (r=3)
      const majorDots = dots.filter(d => d.getAttribute('data-r') === '3');
      expect(majorDots.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Y-axis', () => {
    it('is positioned on the right', () => {
      const data = [makePoint('12:00', isoAt(0), 600, -3)];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);

      const yAxes = container.querySelectorAll('[data-testid="y-axis"]');
      expect(yAxes.length).toBeGreaterThanOrEqual(1);
      expect(yAxes[0].getAttribute('data-orientation')).toBe('right');
    });

    it('uses watt labels rounded to 50 W when the scale is below 1 kW', () => {
      const data = [
        makePoint('12:00', isoAt(0), 50, 1),
        makePoint('12:01', isoAt(1), 100, 1),
        makePoint('12:02', isoAt(2), 150, 1),
        makePoint('12:03', isoAt(3), 200, 1),
      ];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' displayMode='1h' />);

      const yAxis = within(container).getByTestId('y-axis');
      const labels = JSON.parse(yAxis.getAttribute('data-labels') ?? '[]') as string[];

      expect(labels).toEqual(['0', '50', '100', '150', '200']);
    });

    it('uses one decimal place for kW scale labels', () => {
      const data = [
        makePoint('12:00', isoAt(0), 1200, 1),
      ];
      const { container } = render(
        <EnergyChartSection
          data={data}
          resolution='1m'
          displayMode='1h'
          axisUnit='W'
          axisDisplay={{ precision: 1, smallValueThreshold: 1000, smallValueTickStep: 50, smallValuePrecision: 0 }}
        />,
      );

      const yAxis = within(container).getByTestId('y-axis');
      const labels = JSON.parse(yAxis.getAttribute('data-labels') ?? '[]') as string[];

      expect(labels).toContain('1.2');
      expect(labels.every((label) => /^\d+\.\d$/.test(label))).toBe(true);
    });

    it('honors configured watt tick steps from the chart axis display settings', () => {
      const data = [
        makePoint('12:00', isoAt(0), 25, 1),
        makePoint('12:01', isoAt(1), 50, 1),
        makePoint('12:02', isoAt(2), 75, 1),
        makePoint('12:03', isoAt(3), 100, 1),
      ];
      const { container } = render(
        <EnergyChartSection
          data={data}
          resolution='1m'
          displayMode='1h'
          axisUnit='W'
          axisDisplay={{ precision: 1, smallValueThreshold: 1000, smallValueTickStep: 25, smallValuePrecision: 0 }}
        />,
      );

      const yAxis = within(container).getByTestId('y-axis');
      const labels = JSON.parse(yAxis.getAttribute('data-labels') ?? '[]') as string[];

      expect(labels).toEqual(['0', '25', '50', '75', '100']);
    });
  });
});
