import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HistoryCharts } from './HistoryCharts';
import type { DeviceDefinition } from '../types/deviceDefinition';

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

vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Noop = () => null;

  return {
    ResponsiveContainer: Passthrough,
    LineChart: Passthrough,
    Line: Noop,
    AreaChart: Passthrough,
    Area: ({ dataKey, fill, stroke, name }: { dataKey?: string; fill?: string; stroke?: string; name?: string }) => (
      <span data-testid='soc-area' data-key={dataKey} data-fill={fill} data-stroke={stroke} data-name={name} />
    ),
    XAxis: Noop,
    YAxis: ({ orientation, domain }: { orientation?: string; domain?: [number, number] }) => (
      <span data-testid='y-axis' data-orientation={orientation} data-domain={JSON.stringify(domain)} />
    ),
    Tooltip: Noop,
    CartesianGrid: Noop,
    Legend: Noop,
    ReferenceDot: Noop,
  };
});

const historyResponse = {
  deviceId: 'inv-1',
  resolution: '5m',
  from: '2026-04-18T00:00:00.000Z',
  to: '2026-04-18T23:59:59.999Z',
  entities: ['state_of_charge'],
  points: [
    { timestamp: '2026-04-18T12:00:00.000Z', values: { state_of_charge: 76 } },
    { timestamp: '2026-04-18T12:05:00.000Z', values: { state_of_charge: 78 } },
  ],
};

describe('StateOfChargeChartSection', () => {
  it('renders inverter SOC as a green area chart with a fixed 0-100 domain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(historyResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const definition = {
      version: '1',
      device: {
        id: 'anenji-inverter-rs232',
        name: 'Anenji Inverter',
        manufacturer: 'Anenji',
        model: 'ANJ-HHS-11000W-48V',
        category: 'inverter',
        icon: 'zap',
      },
      connection: {
        transport: { type: 'serial', defaults: {} },
        protocol: { type: 'modbus-rtu', settings: {} },
      },
      dataSources: [],
      pollGroups: {},
      entities: [
        {
          id: 'state_of_charge',
          type: 'sensor',
          name: 'State of Charge',
          category: 'Battery',
          role: 'state-of-charge',
          source: { bank: 'history', byteOffset: 0, unit: '%' },
        },
      ],
      computedEntities: [],
      ui: {
        pages: {
          history: {
            charts: [
              {
                title: 'State of Charge',
                type: 'line-chart',
                traces: [
                  { entity: 'state_of_charge', label: 'SOC', color: 'green' },
                ],
              },
            ],
          },
        },
      },
    } satisfies DeviceDefinition;

    render(
      <HistoryCharts
        deviceId='inv-1'
        precision={{ voltage: 1, cellVoltage: 3, current: 1, power: 0, temperature: 1, soc: 0, deltaVoltage: 3 }}
        definition={definition}
      />
    );

    expect(await screen.findByText('State of Charge')).toBeInTheDocument();
    expect(screen.getByTestId('soc-area')).toHaveAttribute('data-key', 'state_of_charge');
    expect(screen.getByTestId('soc-area')).toHaveAttribute('data-stroke', '#34d399');
    expect(screen.getByTestId('soc-area').getAttribute('data-fill')).toMatch(/^url\(#.+\)$/);

    const yAxis = screen.getByTestId('y-axis');
    expect(yAxis).toHaveAttribute('data-orientation', 'right');
    expect(yAxis).toHaveAttribute('data-domain', '[0,100]');
  });
});
