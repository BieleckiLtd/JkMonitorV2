import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Binary, Cable, LoaderCircle, PlugZap, RefreshCcw, ScanSearch } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { decodeSelection, getSelectionSummary, type ModbusDecodeMode } from '../../lib/modbusScanner';
import { cn } from '../../lib/utils';
import type {
  ModbusScannerReadRequest,
  ModbusScannerReadResult,
  SystemInterfacesResponse,
} from './types';

const baudRateOptions = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200'];
const parityOptions = ['None', 'Even', 'Odd'];
const dataBitsOptions = ['7', '8'];
const stopBitsOptions = ['1', '2'];
const registerKindOptions: ModbusScannerReadRequest['registerKind'][] = ['holding', 'input'];
const decodeModes: { value: ModbusDecodeMode; label: string }[] = [
  { value: 'ascii', label: 'ASCII' },
  { value: 'signed-int', label: 'Signed int' },
  { value: 'unsigned-int', label: 'Unsigned int' },
  { value: 'hex', label: 'Hex' },
  { value: 'binary', label: 'Binary' },
  { value: 'float', label: 'Float' },
];

type ModbusScannerFormState = {
  portName: string;
  slaveAddress: string;
  baudRate: string;
  parity: string;
  dataBits: string;
  stopBits: string;
  responseTimeoutMs: string;
  retryCount: string;
  autoPollMs: string;
  startRegister: string;
  registerCount: string;
  registersPerRequest: string;
  registerKind: ModbusScannerReadRequest['registerKind'];
};

type ModbusScannerSectionProps = {
  interfaces: SystemInterfacesResponse | null;
};

export function ModbusScannerSection({ interfaces }: ModbusScannerSectionProps) {
  const [form, setForm] = useState<ModbusScannerFormState>({
    portName: '',
    slaveAddress: '1',
    baudRate: '9600',
    parity: 'None',
    dataBits: '8',
    stopBits: '1',
    responseTimeoutMs: '1000',
    retryCount: '1',
    autoPollMs: '0',
    startRegister: '0',
    registerCount: '24',
    registersPerRequest: '12',
    registerKind: 'holding',
  });
  const [scanResult, setScanResult] = useState<ModbusScannerReadResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [detailView, setDetailView] = useState<'raw' | 'decoded'>('decoded');
  const [decodeMode, setDecodeMode] = useState<ModbusDecodeMode>('float');

  useEffect(() => {
    if (!form.portName && interfaces?.serialPorts.length) {
      setForm((current) => ({ ...current, portName: interfaces.serialPorts[0]?.name ?? '' }));
    }
  }, [form.portName, interfaces]);

  const selection = useMemo(
    () => getSelectionSummary(scanResult, selectionStart, selectionEnd),
    [scanResult, selectionEnd, selectionStart],
  );
  const decodedValues = useMemo(() => decodeSelection(selection, decodeMode), [decodeMode, selection]);

  const runScan = useCallback(async (connecting: boolean) => {
    let request: ModbusScannerReadRequest;

    try {
      request = buildRequest(form);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Enter valid Modbus settings before scanning.',
        isError: true,
      });
      return;
    }

    setIsLoading(true);
    setFeedback(null);

    try {
      const response = await fetch('/api/system/modbus-scanner/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json() as ModbusScannerReadResult | { error?: string };
      if (!response.ok) {
        throw new Error('error' in body && body.error ? body.error : 'Unable to read Modbus registers.');
      }

      const result = body as ModbusScannerReadResult;
      setScanResult(result);
      setIsConnected(true);
      setFeedback({
        message: connecting
          ? `Connected to ${result.portName} and read ${result.registerCount} ${result.registerKind} registers.`
          : `Read ${result.registerCount} ${result.registerKind} registers from ${result.portName}.`,
        isError: false,
      });

      const firstRegister = result.registers[0]?.address ?? null;
      const lastRegister = result.registers[result.registers.length - 1]?.address ?? null;
      if (firstRegister == null || lastRegister == null) {
        setSelectionStart(null);
        setSelectionEnd(null);
      } else if (
        selectionStart == null
        || selectionEnd == null
        || selectionStart < firstRegister
        || selectionEnd > lastRegister
      ) {
        setSelectionStart(firstRegister);
        setSelectionEnd(firstRegister);
      }
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to read Modbus registers.',
        isError: true,
      });

      if (connecting) {
        setIsConnected(false);
      }
    } finally {
      setIsLoading(false);
    }
  }, [form, selectionEnd, selectionStart]);

  useEffect(() => {
    if (!isConnected) {
      return;
    }

    const autoPollMs = Number.parseInt(form.autoPollMs, 10);
    if (!Number.isFinite(autoPollMs) || autoPollMs <= 0) {
      return;
    }

    const timerId = window.setInterval(() => {
      void runScan(false);
    }, autoPollMs);

    return () => {
      window.clearInterval(timerId);
    };
  }, [form.autoPollMs, isConnected, runScan]);

  function disconnect() {
    setIsConnected(false);
    setFeedback({
      message: 'Scanner disconnected. Existing register data remains available until the next scan.',
      isError: false,
    });
  }

  function handleRegisterClick(address: number, extendSelection: boolean) {
    if (!extendSelection || selectionStart == null) {
      setSelectionStart(address);
      setSelectionEnd(address);
      return;
    }

    setSelectionEnd(address);
  }

  return (
    <Card className='system-section-card'>
      <PanelHeader
        title='Modbus Scanner'
        description='Probe RTU devices, inspect raw register bytes, and decode selected register ranges without leaving the original matrix view.'
        aside={(
          <div className='rounded-xl border border-border/70 bg-background/75 px-3 py-2 text-right'>
            <div className='text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Status</div>
            <div className='mt-1 font-mono text-xs text-foreground'>{isConnected ? 'CONNECTED' : 'IDLE'}</div>
          </div>
        )}
      />
      <CardContent className='space-y-5 pt-5'>
        <div className='grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]'>
          <div className='space-y-5'>
            <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
              <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
                <Field label='COM port'>
                  <Select value={form.portName} onValueChange={(value) => setForm((current) => ({ ...current, portName: value ?? '' }))}>
                    <SelectTrigger aria-label='COM port' className='w-full'>
                      <SelectValue placeholder={interfaces ? 'Select port' : 'Loading ports'} />
                    </SelectTrigger>
                    <SelectContent>
                      {(interfaces?.serialPorts ?? []).map((port) => (
                        <SelectItem key={port.name} value={port.name}>{port.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {interfaces?.serialPorts.length === 0 ? (
                    <div className='text-[11px] text-muted-foreground'>No serial ports detected.</div>
                  ) : null}
                </Field>

                <Field label='Register type'>
                  <Select value={form.registerKind} onValueChange={(value) => setForm((current) => ({ ...current, registerKind: (value ?? 'holding') as ModbusScannerReadRequest['registerKind'] }))}>
                    <SelectTrigger aria-label='Register type' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {registerKindOptions.map((value) => (
                        <SelectItem key={value} value={value}>{value === 'holding' ? 'Holding (0x03)' : 'Input (0x04)'}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='Slave address'>
                  <Input aria-label='Slave address' value={form.slaveAddress} onChange={(event) => updateForm('slaveAddress', event.target.value)} />
                </Field>

                <Field label='Baud rate'>
                  <Select value={form.baudRate} onValueChange={(value) => updateForm('baudRate', value ?? form.baudRate)}>
                    <SelectTrigger aria-label='Baud rate' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {baudRateOptions.map((value) => (
                        <SelectItem key={value} value={value}>{value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='Parity'>
                  <Select value={form.parity} onValueChange={(value) => updateForm('parity', value ?? form.parity)}>
                    <SelectTrigger aria-label='Parity' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {parityOptions.map((value) => (
                        <SelectItem key={value} value={value}>{value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='Data bits'>
                  <Select value={form.dataBits} onValueChange={(value) => updateForm('dataBits', value ?? form.dataBits)}>
                    <SelectTrigger aria-label='Data bits' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {dataBitsOptions.map((value) => (
                        <SelectItem key={value} value={value}>{value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='Stop bits'>
                  <Select value={form.stopBits} onValueChange={(value) => updateForm('stopBits', value ?? form.stopBits)}>
                    <SelectTrigger aria-label='Stop bits' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {stopBitsOptions.map((value) => (
                        <SelectItem key={value} value={value}>{value}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>

                <Field label='Response timeout (ms)'>
                  <Input aria-label='Response timeout' value={form.responseTimeoutMs} onChange={(event) => updateForm('responseTimeoutMs', event.target.value)} />
                </Field>

                <Field label='Retry count'>
                  <Input aria-label='Retry count' value={form.retryCount} onChange={(event) => updateForm('retryCount', event.target.value)} />
                </Field>

                <Field label='Auto-poll interval (ms)'>
                  <Input aria-label='Auto-poll interval' value={form.autoPollMs} onChange={(event) => updateForm('autoPollMs', event.target.value)} />
                </Field>

                <Field label='Start register'>
                  <Input aria-label='Start register' value={form.startRegister} onChange={(event) => updateForm('startRegister', event.target.value)} />
                </Field>

                <Field label='Register count'>
                  <Input aria-label='Register count' value={form.registerCount} onChange={(event) => updateForm('registerCount', event.target.value)} />
                </Field>

                <Field label='Registers per request'>
                  <Input aria-label='Registers per request' value={form.registersPerRequest} onChange={(event) => updateForm('registersPerRequest', event.target.value)} />
                </Field>
              </div>

              <div className='mt-4 flex flex-wrap items-center gap-2'>
                <Button onClick={() => void runScan(true)} disabled={isLoading}>
                  {isLoading ? <LoaderCircle className='animate-spin' /> : <PlugZap />}
                  Connect & scan
                </Button>
                <Button variant='outline' onClick={() => void runScan(false)} disabled={isLoading}>
                  {isLoading ? <LoaderCircle className='animate-spin' /> : <RefreshCcw />}
                  Refresh
                </Button>
                <Button variant='ghost' onClick={disconnect} disabled={!isConnected || isLoading}>
                  Disconnect
                </Button>
              </div>

              {feedback ? (
                <div className={cn(
                  'mt-4 rounded-2xl border px-3 py-2 text-sm',
                  feedback.isError ? 'border-rose-500/25 bg-rose-500/10 text-rose-200' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200',
                )}>
                  {feedback.message}
                </div>
              ) : null}
            </div>

            <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Raw register matrix</div>
                  <div className='mt-1 text-sm text-muted-foreground'>Addresses run vertically. Each row shows the two bytes returned for that register.</div>
                </div>
                {scanResult ? (
                  <div className='rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-right'>
                    <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>Requests</div>
                    <div className='font-mono text-xs text-foreground'>{scanResult.totalRequests}</div>
                  </div>
                ) : null}
              </div>

              {scanResult ? (
                <div className='mt-4 overflow-x-auto'>
                  <div className='min-w-[36rem]'>
                    <div className='grid grid-cols-[8rem_1fr_1fr_1.25fr] gap-2 px-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground'>
                      <div>Address</div>
                      <div>Byte 0</div>
                      <div>Byte 1</div>
                      <div>Word</div>
                    </div>
                    <div className='mt-2 space-y-1'>
                      {scanResult.registers.map((register) => {
                        const inSelection = selection != null && register.address >= selection.startAddress && register.address <= selection.endAddress;

                        return (
                          <button
                            key={register.address}
                            type='button'
                            onClick={(event) => handleRegisterClick(register.address, event.shiftKey)}
                            className={cn(
                              'grid w-full grid-cols-[8rem_1fr_1fr_1.25fr] gap-2 rounded-xl border px-2 py-2 text-left font-mono text-sm transition-colors',
                              inSelection ? 'border-primary/35 bg-primary/10 text-foreground' : 'border-border/70 bg-background/70 hover:bg-accent/35',
                            )}
                          >
                            <span className='font-semibold text-foreground'>{register.address}</span>
                            <span>{toByteHex(register.highByte)}</span>
                            <span>{toByteHex(register.lowByte)}</span>
                            <span>{register.hexValue}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className='mt-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground'>
                  Connect to a device to populate the scanner matrix.
                </div>
              )}
            </div>
          </div>

          <div className='space-y-5'>
            <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Selection</div>
                  <div className='mt-1 text-sm text-muted-foreground'>
                    Click a register for a single-word selection. Shift-click another row to expand to a contiguous range.
                  </div>
                </div>
                <div className='inline-flex rounded-xl border border-border/70 bg-background/75 p-1'>
                  <button
                    type='button'
                    onClick={() => setDetailView('raw')}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                      detailView === 'raw' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                    )}
                  >
                    Raw
                  </button>
                  <button
                    type='button'
                    onClick={() => setDetailView('decoded')}
                    className={cn(
                      'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                      detailView === 'decoded' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                    )}
                  >
                    Decoded
                  </button>
                </div>
              </div>

              {selection ? (
                <div className='mt-4 space-y-4'>
                  <div className='grid gap-3 sm:grid-cols-2'>
                    <SummaryTile label='Start register' value={String(selection.startAddress)} />
                    <SummaryTile label='End register' value={String(selection.endAddress)} />
                    <SummaryTile label='Registers' value={String(selection.registerCount)} />
                    <SummaryTile label='Bytes' value={String(selection.byteCount)} />
                  </div>

                  {detailView === 'raw' ? (
                    <div className='space-y-2'>
                      {selection.registers.map((register) => (
                        <div key={register.address} className='rounded-xl border border-border/70 bg-background/70 px-3 py-3 font-mono text-sm text-foreground'>
                          <div className='flex flex-wrap items-center justify-between gap-2'>
                            <span>Register {register.address}</span>
                            <span>{register.hexValue}</span>
                          </div>
                          <div className='mt-2 text-xs text-muted-foreground'>
                            {toByteHex(register.highByte)} {toByteHex(register.lowByte)} · unsigned {register.unsignedValue}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className='space-y-4'>
                      <Field label='Decode mode'>
                        <Select value={decodeMode} onValueChange={(value) => setDecodeMode((value ?? 'float') as ModbusDecodeMode)}>
                          <SelectTrigger aria-label='Decode mode' className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {decodeModes.map((mode) => (
                              <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>

                      <div className='space-y-2'>
                        {decodedValues.map((value) => (
                          <div key={value.label} className='rounded-xl border border-border/70 bg-background/70 px-3 py-3'>
                            <div className='flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                              {decodeMode === 'binary' ? <Binary className='h-3.5 w-3.5' /> : <Cable className='h-3.5 w-3.5' />}
                              {value.label}
                            </div>
                            <div className='mt-2 break-all font-mono text-sm text-foreground'>{value.value}</div>
                            {value.detail ? <div className='mt-1 text-xs text-muted-foreground'>{value.detail}</div> : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className='mt-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground'>
                  <div className='mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-background/75 text-muted-foreground'>
                    <ScanSearch className='h-5 w-5' />
                  </div>
                  <div className='mt-3 font-medium text-foreground'>No selection</div>
                  <div className='mt-2'>Scan first, then click a register row to inspect bytes or decode a contiguous range.</div>
                </div>
              )}
            </div>

            {scanResult ? (
              <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
                <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Scan metadata</div>
                <div className='mt-3 space-y-2'>
                  {scanResult.blocks.map((block) => (
                    <div key={`${block.startAddress}-${block.registerCount}`} className='rounded-xl border border-border/70 bg-background/70 px-3 py-3 text-sm text-foreground'>
                      <div className='flex flex-wrap items-center justify-between gap-2'>
                        <span className='font-mono'>Registers {block.startAddress}-{block.startAddress + block.registerCount - 1}</span>
                        <span className='text-xs text-muted-foreground'>{block.attempts} attempt{block.attempts === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  function updateForm<Key extends keyof ModbusScannerFormState>(key: Key, value: ModbusScannerFormState[Key]) {
    setForm((current) => ({ ...current, [key]: value }));
  }
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className='space-y-1.5'>
      <span className='block text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{label}</span>
      {children}
    </label>
  );
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className='rounded-xl border border-border/70 bg-background/70 px-3 py-3'>
      <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{label}</div>
      <div className='mt-2 font-mono text-sm text-foreground'>{value}</div>
    </div>
  );
}

function buildRequest(form: ModbusScannerFormState): ModbusScannerReadRequest {
  const request = {
    portName: form.portName.trim(),
    slaveAddress: parseInteger(form.slaveAddress, 'Slave address'),
    baudRate: parseInteger(form.baudRate, 'Baud rate'),
    parity: form.parity,
    dataBits: parseInteger(form.dataBits, 'Data bits'),
    stopBits: parseInteger(form.stopBits, 'Stop bits'),
    responseTimeoutMs: parseInteger(form.responseTimeoutMs, 'Response timeout'),
    retryCount: parseInteger(form.retryCount, 'Retry count'),
    startRegister: parseInteger(form.startRegister, 'Start register'),
    registerCount: parseInteger(form.registerCount, 'Register count'),
    registersPerRequest: parseInteger(form.registersPerRequest, 'Registers per request'),
    registerKind: form.registerKind,
  } satisfies ModbusScannerReadRequest;

  if (!request.portName) {
    throw new Error('Select a COM port before connecting.');
  }

  return request;
}

function parseInteger(value: string, label: string) {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return Number.parseInt(normalized, 10);
}

function toByteHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}
