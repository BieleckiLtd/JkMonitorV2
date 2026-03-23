import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EnergyChartSection } from './HistoryCharts';

// ---------------------------------------------------------------------------
// jsdom stubs – Recharts needs ResizeObserver and element sizing
// ---------------------------------------------------------------------------
beforeAll(() => {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
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
    YAxis: ({ orientation }: { orientation?: string }) => (
      <span data-testid='y-axis' data-orientation={orientation} />
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
    render(<EnergyChartSection data={[]} resolution='1m' />);
    expect(screen.getByText('Energy')).toBeInTheDocument();
  });

  it('renders discharged and charged kWh labels', () => {
    const data = [
      makePoint('12:00', isoAt(0), 600, -3), // discharging
      makePoint('12:01', isoAt(1), 400, 2),   // charging
    ];
    const { container } = render(<EnergyChartSection data={data} resolution='1m' />);

    expect(container.textContent).toContain('Discharged:');
    expect(container.textContent).toContain('Charged:');
  });

  describe('pill (active value badge)', () => {
    it('has whitespace-nowrap to prevent line wrapping', () => {
      const data = [makePoint('12:00', isoAt(0), 600, -3)];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' />);

      const pill = container.querySelector('.whitespace-nowrap');
      expect(pill).not.toBeNull();
      expect(pill!.textContent).toContain('kW');
    });

    it('shows "0.0 kW Discharged" greyed out for zero values', () => {
      const data = [makePoint('12:00', isoAt(0), 0, 0)];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' />);

      const pill = container.querySelector('.whitespace-nowrap');
      expect(pill).not.toBeNull();
      expect(pill!.textContent).toContain('0.0 kW Discharged');
      // Should use muted foreground (grey) instead of foreground (white)
      expect(pill!.className).toContain('text-muted-foreground');
      expect(pill!.className).not.toContain('text-foreground');
    });

    it('shows normal styling for non-zero values', () => {
      const data = [makePoint('12:00', isoAt(0), 600, -3)];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' />);

      const pill = container.querySelector('.whitespace-nowrap');
      expect(pill).not.toBeNull();
      expect(pill!.textContent).toContain('kW');
      expect(pill!.className).toContain('text-foreground');
    });
  });

  describe('hour boundary markers', () => {
    it('renders ReferenceDot for hour boundaries', () => {
      // Create data spanning 12:00 → 14:00 at 5-min resolution (hour change at 13:00, 14:00)
      const data = Array.from({ length: 25 }, (_, i) => {
        const ts = isoAt(i * 5);
        const d = new Date(ts);
        const time = `${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}`;
        return makePoint(time, ts, 100, -1);
      });
      render(<EnergyChartSection data={data} resolution='5m' />);

      const dots = screen.getAllByTestId('ref-dot');
      expect(dots.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Y-axis', () => {
    it('is positioned on the right', () => {
      const data = [makePoint('12:00', isoAt(0), 600, -3)];
      const { container } = render(<EnergyChartSection data={data} resolution='1m' />);

      const yAxes = container.querySelectorAll('[data-testid="y-axis"]');
      expect(yAxes.length).toBeGreaterThanOrEqual(1);
      expect(yAxes[0].getAttribute('data-orientation')).toBe('right');
    });
  });
});
