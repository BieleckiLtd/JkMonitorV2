import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Binary, Cable, LoaderCircle, PlugZap, RefreshCcw, ScanSearch } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  buildRegisterMatrix,
  decodeSelection,
  formatRegisterValue,
  getSelectionSummary,
  type ModbusDecodeMode,
  type ModbusMatrixDisplayMode,
} from '../../lib/modbusScanner';
import { cn } from '../../lib/utils';
import type {
  DeleteModbusScannerSettingResult,
  ModbusScannerReadRequest,
  ModbusScannerReadResult,
  ModbusScannerSavedSetting,
  ModbusScannerSavedSettingsSnapshot,
  SaveModbusScannerSettingRequest,
  SaveModbusScannerSettingResult,
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
const matrixDisplayModes: { value: ModbusMatrixDisplayMode; label: string }[] = [
  { value: 'hex', label: 'Hex word' },
  { value: 'unsigned', label: 'Unsigned' },
  { value: 'signed', label: 'Signed' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'binary', label: 'Binary' },
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
  const [savedSettings, setSavedSettings] = useState<ModbusScannerSavedSetting[]>([]);
  const [settingsName, setSettingsName] = useState('');
  const [settingsStorageAvailable, setSettingsStorageAvailable] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isDeletingSettingName, setIsDeletingSettingName] = useState<string | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const [selectionStart, setSelectionStart] = useState<number | null>(null);
  const [selectionEnd, setSelectionEnd] = useState<number | null>(null);
  const [detailView, setDetailView] = useState<'raw' | 'decoded'>('decoded');
  const [decodeMode, setDecodeMode] = useState<ModbusDecodeMode>('float');
  const [matrixColumns, setMatrixColumns] = useState('10');
  const [matrixDisplayMode, setMatrixDisplayMode] = useState<ModbusMatrixDisplayMode>('hex');

  useEffect(() => {
    if (!form.portName && interfaces?.serialPorts.length) {
      setForm((current) => ({ ...current, portName: interfaces.serialPorts[0]?.name ?? '' }));
    }
  }, [form.portName, interfaces]);

  const loadSavedSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/system/modbus-scanner/settings', { cache: 'no-store' });
      const body = await readJsonResponse<ModbusScannerSavedSettingsSnapshot | { error?: string }>(response);
      if (!response.ok) {
        throw new Error(body && 'error' in body && body.error ? body.error : 'Unable to load saved Modbus scanner settings.');
      }

      const snapshot = body as ModbusScannerSavedSettingsSnapshot | null;
      setSavedSettings(snapshot?.settings ?? []);
      setSettingsStorageAvailable(snapshot?.storageAvailable ?? false);
    } catch (error) {
      setSavedSettings([]);
      setSettingsStorageAvailable(false);
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to load saved Modbus scanner settings.',
        isError: true,
      });
    }
  }, []);

  useEffect(() => {
    void loadSavedSettings();
  }, [loadSavedSettings]);

  const selection = useMemo(
    () => getSelectionSummary(scanResult, selectionStart, selectionEnd),
    [scanResult, selectionEnd, selectionStart],
  );
  const decodedValues = useMemo(() => decodeSelection(selection, decodeMode), [decodeMode, selection]);
  const matrixColumnCount = useMemo(() => parsePositiveInteger(matrixColumns, 10), [matrixColumns]);
  const matrixRows = useMemo(() => buildRegisterMatrix(scanResult, matrixColumnCount), [matrixColumnCount, scanResult]);

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
      const body = await readJsonResponse<ModbusScannerReadResult | { error?: string }>(response);
      if (!response.ok) {
        throw new Error(body && 'error' in body && body.error ? body.error : 'Unable to read Modbus registers.');
      }

      if (!body) {
        throw new Error('The scanner returned an empty response.');
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

  async function saveSettings() {
    let request: ModbusScannerReadRequest;

    try {
      request = buildRequest(form);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Enter valid Modbus settings before saving.',
        isError: true,
      });
      return;
    }

    const name = settingsName.trim();
    if (!name) {
      setFeedback({
        message: 'Enter a name before saving scanner settings.',
        isError: true,
      });
      return;
    }

    setIsSavingSettings(true);
    try {
      const response = await fetch('/api/system/modbus-scanner/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          settings: request,
        } satisfies SaveModbusScannerSettingRequest),
      });
      const body = await readJsonResponse<SaveModbusScannerSettingResult | { error?: string }>(response);
      if (!response.ok) {
        throw new Error(body && 'error' in body && body.error ? body.error : 'Unable to save scanner settings.');
      }

      if (!body) {
        throw new Error('The saved settings response was empty.');
      }

      const result = body as SaveModbusScannerSettingResult;
      setSavedSettings((current) => [result.setting, ...current.filter((item) => item.name !== result.setting.name)]);
      setSettingsName(result.setting.name);
      setFeedback({
        message: result.message,
        isError: false,
      });
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to save scanner settings.',
        isError: true,
      });
    } finally {
      setIsSavingSettings(false);
    }
  }

  function loadSetting(setting: ModbusScannerSavedSetting) {
    setForm(toFormState(setting.settings));
    setSettingsName(setting.name);
    setFeedback({
      message: `Loaded scanner settings '${setting.name}'.`,
      isError: false,
    });
  }

  async function deleteSetting(setting: ModbusScannerSavedSetting) {
    setIsDeletingSettingName(setting.name);
    try {
      const response = await fetch(`/api/system/modbus-scanner/settings/${encodeURIComponent(setting.name)}`, {
        method: 'DELETE',
      });
      const body = await readJsonResponse<DeleteModbusScannerSettingResult | { error?: string }>(response);
      if (!response.ok) {
        throw new Error(body && 'error' in body && body.error ? body.error : 'Unable to delete scanner settings.');
      }

      const result = body as DeleteModbusScannerSettingResult | null;
      setSavedSettings((current) => current.filter((item) => item.name !== setting.name));
      setFeedback({
        message: result?.message ?? `Deleted scanner settings '${setting.name}'.`,
        isError: false,
      });
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to delete scanner settings.',
        isError: true,
      });
    } finally {
      setIsDeletingSettingName(null);
    }
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
              <div className='mb-4 space-y-3 rounded-2xl border border-border/70 bg-background/55 p-3'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <div>
                    <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Saved scanner settings</div>
                    <div className='mt-1 text-sm text-muted-foreground'>Name a scanner setup once, then load it back into the form instantly.</div>
                  </div>
                  <div className='rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-right'>
                    <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>Saved</div>
                    <div className='font-mono text-xs text-foreground'>{savedSettings.length}</div>
                  </div>
                </div>

                <div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]'>
                  <Field label='Settings name'>
                    <Input aria-label='Settings name' value={settingsName} onChange={(event) => setSettingsName(event.target.value)} />
                  </Field>
                  <div className='flex items-end'>
                    <Button variant='outline' onClick={() => void loadSavedSettings()} disabled={isSavingSettings || isLoading}>
                      <RefreshCcw />
                      Reload saved
                    </Button>
                  </div>
                  <div className='flex items-end'>
                    <Button onClick={() => void saveSettings()} disabled={isSavingSettings || !settingsStorageAvailable}>
                      {isSavingSettings ? <LoaderCircle className='animate-spin' /> : <PlugZap />}
                      Save current
                    </Button>
                  </div>
                </div>

                {!settingsStorageAvailable ? (
                  <div className='rounded-xl border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm text-amber-100'>
                    PostgreSQL storage is not available, so scanner settings cannot be saved yet.
                  </div>
                ) : savedSettings.length > 0 ? (
                  <div className='overflow-x-auto'>
                    <div className='min-w-[38rem] space-y-2'>
                      <div className='grid grid-cols-[minmax(0,1.1fr)_8rem_7rem_10rem_10rem] gap-2 px-2 text-[11px] uppercase tracking-[0.18em] text-muted-foreground'>
                        <div>Name</div>
                        <div>Port</div>
                        <div>Slave</div>
                        <div>Range</div>
                        <div>Actions</div>
                      </div>
                      {savedSettings.map((setting) => (
                        <div key={setting.name} className='grid grid-cols-[minmax(0,1.1fr)_8rem_7rem_10rem_10rem] gap-2 rounded-xl border border-border/70 bg-background/70 px-2 py-3 text-sm'>
                          <div className='min-w-0'>
                            <div className='truncate font-semibold text-foreground'>{setting.name}</div>
                            <div className='truncate text-xs text-muted-foreground'>{describeSetting(setting)}</div>
                          </div>
                          <div className='font-mono text-foreground'>{setting.settings.portName}</div>
                          <div className='font-mono text-foreground'>{setting.settings.slaveAddress}</div>
                          <div className='font-mono text-foreground'>
                            {setting.settings.startRegister}-{setting.settings.startRegister + setting.settings.registerCount - 1}
                          </div>
                          <div className='flex flex-wrap gap-2'>
                            <Button type='button' size='sm' variant='outline' onClick={() => loadSetting(setting)}>
                              Load
                            </Button>
                            <Button
                              type='button'
                              size='sm'
                              variant='ghost'
                              onClick={() => void deleteSetting(setting)}
                              disabled={isDeletingSettingName === setting.name}
                            >
                              {isDeletingSettingName === setting.name ? <LoaderCircle className='animate-spin' /> : 'Delete'}
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className='rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-4 text-sm text-muted-foreground'>
                    No named scanner settings saved yet.
                  </div>
                )}
              </div>

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
                  <div className='mt-1 text-sm text-muted-foreground'>Addresses run top-to-bottom. Offsets run left-to-right from <span className='font-mono'>+0</span> through the configured column count.</div>
                </div>
                <div className='flex flex-wrap items-end gap-3'>
                  <Field label='Columns'>
                    <Input
                      aria-label='Matrix columns'
                      value={matrixColumns}
                      onChange={(event) => setMatrixColumns(event.target.value)}
                      className='w-24'
                    />
                  </Field>
                  <Field label='Cell display'>
                    <Select value={matrixDisplayMode} onValueChange={(value) => setMatrixDisplayMode((value ?? 'hex') as ModbusMatrixDisplayMode)}>
                      <SelectTrigger aria-label='Cell display' className='w-40'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {matrixDisplayModes.map((mode) => (
                          <SelectItem key={mode.value} value={mode.value}>{mode.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {scanResult ? (
                    <div className='rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-right'>
                      <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>Requests</div>
                      <div className='font-mono text-xs text-foreground'>{scanResult.totalRequests}</div>
                    </div>
                  ) : null}
                </div>
              </div>

              {scanResult ? (
                <div className='mt-4 overflow-x-auto'>
                  <div className='min-w-max'>
                    <table className='border-separate border-spacing-1.5'>
                      <thead>
                        <tr>
                          <th className='min-w-24 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em] text-muted-foreground'>
                            Address
                          </th>
                          {Array.from({ length: matrixColumnCount }, (_, offset) => (
                            <th
                              key={offset}
                              className='min-w-32 rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em] text-muted-foreground'
                            >
                              +{offset}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {matrixRows.map((row) => (
                          <tr key={row.rowAddress}>
                            <th className='rounded-xl border border-border/70 bg-background/70 px-3 py-2 text-left font-mono text-sm font-semibold text-foreground'>
                              {row.rowAddress}
                            </th>
                            {row.cells.map((register, index) => {
                              if (!register) {
                                return (
                                  <td
                                    key={`${row.rowAddress}-${index}`}
                                    className='rounded-xl border border-dashed border-border/60 bg-muted/15 px-3 py-3'
                                  />
                                );
                              }

                              const inSelection = selection != null
                                && register.address >= selection.startAddress
                                && register.address <= selection.endAddress;
                              const display = formatRegisterValue(register, matrixDisplayMode);

                              return (
                                <td key={register.address} className='p-0 align-top'>
                                  <button
                                    type='button'
                                    aria-label={`Register ${register.address}: ${display.primary}`}
                                    onClick={(event) => handleRegisterClick(register.address, event.shiftKey)}
                                    className={cn(
                                      'flex min-h-20 w-full min-w-32 flex-col rounded-xl border px-3 py-3 text-left font-mono text-sm transition-colors',
                                      inSelection ? 'border-primary/35 bg-primary/10 text-foreground' : 'border-border/70 bg-background/70 hover:bg-accent/35',
                                    )}
                                  >
                                    <span className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>@{register.address}</span>
                                    <span className={cn('mt-2 break-all text-sm text-foreground', matrixDisplayMode === 'binary' && 'text-xs')}>
                                      {display.primary}
                                    </span>
                                    {display.secondary ? (
                                      <span className='mt-1 break-all text-[11px] text-muted-foreground'>{display.secondary}</span>
                                    ) : null}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
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

function toFormState(request: ModbusScannerReadRequest): ModbusScannerFormState {
  return {
    portName: request.portName,
    slaveAddress: String(request.slaveAddress),
    baudRate: String(request.baudRate),
    parity: request.parity,
    dataBits: String(request.dataBits),
    stopBits: String(request.stopBits),
    responseTimeoutMs: String(request.responseTimeoutMs),
    retryCount: String(request.retryCount),
    autoPollMs: '0',
    startRegister: String(request.startRegister),
    registerCount: String(request.registerCount),
    registersPerRequest: String(request.registersPerRequest),
    registerKind: request.registerKind,
  };
}

function describeSetting(setting: ModbusScannerSavedSetting) {
  return `${setting.settings.registerKind} registers, ${setting.settings.baudRate} baud, ${setting.settings.parity} parity`;
}

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text.trim()) {
      return null;
    }

    return JSON.parse(text) as T;
  }

  if (typeof response.json === 'function') {
    return await response.json() as T;
  }

  return null;
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

function parsePositiveInteger(value: string, fallbackValue: number) {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallbackValue;
  }

  return Math.min(parsed, 32);
}

function toByteHex(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}
