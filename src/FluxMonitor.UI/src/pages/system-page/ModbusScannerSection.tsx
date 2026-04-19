import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Cable, LoaderCircle, PlugZap, RefreshCcw, ScanSearch } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Button } from '../../components/ui/button';
import { Card, CardContent } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import {
  buildAnnotationSegments,
  buildRegisterMatrix,
  decodeAnnotationPreview,
  formatRegisterValue,
  getSelectionSummary,
  type ModbusEntityDataType,
  type ModbusEntityKind,
  type ModbusMatrixAnnotation,
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
const matrixDisplayModes: { value: ModbusMatrixDisplayMode; label: string }[] = [
  { value: 'hex', label: 'Hex word' },
  { value: 'unsigned', label: 'Unsigned' },
  { value: 'signed', label: 'Signed' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'binary', label: 'Binary' },
];
const entityTypeOptions: { value: ModbusEntityKind; label: string }[] = [
  { value: 'sensor', label: 'Sensor' },
  { value: 'binary_sensor', label: 'Binary sensor' },
  { value: 'text', label: 'Text' },
];
const entityDataTypeOptions: { value: ModbusEntityDataType; label: string }[] = [
  { value: 'uint16', label: 'UInt16' },
  { value: 'int16', label: 'Int16' },
  { value: 'uint32', label: 'UInt32' },
  { value: 'int32', label: 'Int32' },
  { value: 'float32', label: 'Float32' },
  { value: 'float64', label: 'Float64' },
  { value: 'ascii', label: 'ASCII' },
  { value: 'hex', label: 'Hex bytes' },
];
const annotationPalette = [
  'border-lime-400/90 bg-lime-500/18 text-lime-100',
  'border-sky-400/90 bg-sky-500/18 text-sky-100',
  'border-amber-400/90 bg-amber-500/18 text-amber-100',
  'border-fuchsia-400/90 bg-fuchsia-500/18 text-fuchsia-100',
  'border-cyan-400/90 bg-cyan-500/18 text-cyan-100',
];

type ModbusEntityDraft = {
  name: string;
  category: string;
  entityType: ModbusEntityKind;
  dataType: ModbusEntityDataType;
  formatter: string;
  unit: string;
  scale: string;
  bitMask: string;
};

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
    registerCount: '30',
    registersPerRequest: '40',
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
  const [matrixColumns, setMatrixColumns] = useState('10');
  const [matrixDisplayMode, setMatrixDisplayMode] = useState<ModbusMatrixDisplayMode>('hex');
  const [annotations, setAnnotations] = useState<ModbusMatrixAnnotation[]>([]);
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [entityDraft, setEntityDraft] = useState<ModbusEntityDraft>({
    name: '',
    category: 'Registers',
    entityType: 'sensor',
    dataType: 'uint16',
    formatter: '',
    unit: '',
    scale: '1',
    bitMask: '',
  });
  const [settingsSections, setSettingsSections] = useState({
    saved: false,
    connection: false,
    scan: false,
  });

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
  const selectionPreview = useMemo(() => {
    if (!selection || !scanResult) {
      return [];
    }

    const draftAnnotation: ModbusMatrixAnnotation = {
      id: slugifyEntityId(entityDraft.name.trim() || `REG_${selection.startAddress}_${selection.endAddress}`),
      name: entityDraft.name.trim() || `REG_${selection.startAddress}_${selection.endAddress}`,
      category: entityDraft.category.trim() || 'Registers',
      entityType: entityDraft.entityType,
      startAddress: selection.startAddress,
      endAddress: selection.endAddress,
      dataType: entityDraft.dataType,
      formatter: entityDraft.formatter.trim() || undefined,
      unit: entityDraft.unit.trim() || undefined,
      scale: parseDecimal(entityDraft.scale, 1),
      bitMask: parseOptionalInteger(entityDraft.bitMask) ?? undefined,
      colorIndex: 0,
    };

    const preview = decodeAnnotationPreview(scanResult, draftAnnotation);
    return [{
      label: draftAnnotation.dataType,
      value: preview.value,
      detail: preview.detail,
    }];
  }, [entityDraft, scanResult, selection]);
  const matrixColumnCount = useMemo(() => parsePositiveInteger(matrixColumns, 10), [matrixColumns]);
  const matrixRows = useMemo(() => buildRegisterMatrix(scanResult, matrixColumnCount), [matrixColumnCount, scanResult]);
  const activeAnnotation = useMemo(
    () => annotations.find((annotation) => annotation.id === activeAnnotationId) ?? null,
    [activeAnnotationId, annotations],
  );
  const annotationSegments = useMemo(
    () => buildAnnotationSegments(matrixRows, annotations, matrixColumnCount),
    [annotations, matrixColumnCount, matrixRows],
  );
  const coveredAnnotationAddresses = useMemo(() => {
    const addresses = new Set<number>();
    for (const annotation of annotations) {
      const start = Math.min(annotation.startAddress, annotation.endAddress);
      const end = Math.max(annotation.startAddress, annotation.endAddress);
      for (let address = start; address <= end; address += 1) {
        addresses.add(address);
      }
    }
    return addresses;
  }, [annotations]);
  const annotationPreviews = useMemo(
    () => new Map(annotations.map((annotation) => [annotation.id, decodeAnnotationPreview(scanResult, annotation)])),
    [annotations, scanResult],
  );

  useEffect(() => {
    if (activeAnnotation) {
      setEntityDraft({
        name: activeAnnotation.name,
        category: activeAnnotation.category,
        entityType: activeAnnotation.entityType,
        dataType: activeAnnotation.dataType,
        formatter: activeAnnotation.formatter ?? '',
        unit: activeAnnotation.unit ?? '',
        scale: String(activeAnnotation.scale ?? 1),
        bitMask: activeAnnotation.bitMask == null || activeAnnotation.bitMask === 0 ? '' : `0x${activeAnnotation.bitMask.toString(16).toUpperCase()}`,
      });
      return;
    }

    if (selection) {
      const defaultName = `REG_${selection.startAddress}_${selection.endAddress}`;
      setEntityDraft((current) => ({
        ...current,
        name: current.name.trim() ? current.name : defaultName,
        dataType: current.name.trim() ? current.dataType : matrixDisplayModeToEntityDataType(matrixDisplayMode),
      }));
    }
  }, [activeAnnotation, matrixDisplayMode, selection]);

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

      const result = validateScanResult(body as ModbusScannerReadResult);
      setScanResult(result);
      setIsConnected(true);
      setFeedback(null);

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
    setFeedback(null);
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

      const savedResult = body as SaveModbusScannerSettingResult;
      setSavedSettings((current) => [savedResult.setting, ...current.filter((item) => item.name !== savedResult.setting.name)]);
      setSettingsName(savedResult.setting.name);
      setFeedback(null);
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
    setFeedback(null);
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

      setSavedSettings((current) => current.filter((item) => item.name !== setting.name));
      setFeedback(null);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to delete scanner settings.',
        isError: true,
      });
    } finally {
      setIsDeletingSettingName(null);
    }
  }

  async function shiftRegisterPage(direction: -1 | 1) {
    const pageSize = parsePositiveInteger(form.registerCount, 24);
    const currentStart = parseIntegerOrFallback(form.startRegister, 0);
    const nextStart = Math.max(0, currentStart + direction * pageSize);

    if (nextStart === currentStart) {
      return;
    }

    setForm((current) => ({ ...current, startRegister: String(nextStart) }));

    const nextForm = {
      ...form,
      startRegister: String(nextStart),
    };

    let request: ModbusScannerReadRequest;
    try {
      request = buildRequest(nextForm);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Enter valid Modbus settings before changing pages.',
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

      const result = validateScanResult(body as ModbusScannerReadResult);
      setScanResult(result);
      setSelectionStart(result.registers[0]?.address ?? null);
      setSelectionEnd(result.registers[0]?.address ?? null);
      setFeedback(null);
    } catch (error) {
      setFeedback({
        message: error instanceof Error ? error.message : 'Unable to change register page.',
        isError: true,
      });
    } finally {
      setIsLoading(false);
    }
  }

  function saveEntityMapping() {
    if (!selection || !scanResult) {
      setFeedback({
        message: 'Select one or more registers before creating an entity mapping.',
        isError: true,
      });
      return;
    }

    const name = entityDraft.name.trim();
    const id = slugifyEntityId(name);
    if (!name || !id) {
      setFeedback({
        message: 'Entity name is required.',
        isError: true,
      });
      return;
    }

    const hasDuplicateName = annotations.some((annotation) => annotation.id !== activeAnnotationId && annotation.name.trim().toLowerCase() === name.toLowerCase());
    if (hasDuplicateName) {
      setFeedback({
        message: 'Entity name must be unique.',
        isError: true,
      });
      return;
    }

    const bitMask = parseOptionalInteger(entityDraft.bitMask);
    const scale = parseDecimal(entityDraft.scale, 1);
    const nextAnnotation: ModbusMatrixAnnotation = {
      id,
      name,
      category: entityDraft.category.trim() || 'Registers',
      entityType: entityDraft.entityType,
      startAddress: selection.startAddress,
      endAddress: selection.endAddress,
      dataType: entityDraft.dataType,
      formatter: entityDraft.formatter.trim() || undefined,
      unit: entityDraft.unit.trim() || undefined,
      scale,
      bitMask: bitMask ?? undefined,
      colorIndex: activeAnnotation?.colorIndex ?? annotations.length % annotationPalette.length,
    };

    const hasOverlap = annotations.some((annotation) => annotation.id !== activeAnnotationId && rangesOverlap(annotation, nextAnnotation));
    if (hasOverlap) {
      setFeedback({
        message: 'That register range overlaps an existing entity mapping. Remove or edit the existing mapping first.',
        isError: true,
      });
      return;
    }

    setAnnotations((current) => [
      nextAnnotation,
      ...current.filter((annotation) => annotation.id !== activeAnnotationId && annotation.id !== nextAnnotation.id),
    ].sort((left, right) => left.startAddress - right.startAddress));
    setActiveAnnotationId(nextAnnotation.id);
    setFeedback(null);
  }

  function loadAnnotation(annotation: ModbusMatrixAnnotation) {
    setActiveAnnotationId(annotation.id);
    setSelectionStart(annotation.startAddress);
    setSelectionEnd(annotation.endAddress);
  }

  function removeAnnotation(annotationId: string) {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
    setActiveAnnotationId((current) => current === annotationId ? null : current);
  }

  return (
    <Card className='system-section-card'>
      <PanelHeader
        title='Modbus Scanner'
        description='Probe RTU devices, inspect raw register bytes, and decode selected register ranges without leaving the original matrix view.'
      />
      <CardContent className='space-y-5 pt-5'>
        <div className='space-y-5'>
          <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
            <CollapsibleSection
              title='Saved settings'
              description='Reusable scanner presets.'
              isOpen={settingsSections.saved}
              onToggle={() => setSettingsSections((current) => ({ ...current, saved: !current.saved }))}
              aside={(
                <div className='rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-right'>
                  <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>Saved</div>
                  <div className='font-mono text-xs text-foreground'>{savedSettings.length}</div>
                </div>
              )}
            >
              <div className='space-y-3 rounded-2xl border border-border/70 bg-background/55 p-3'>
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
            </CollapsibleSection>

            <div className='mt-4 space-y-3'>
              <CollapsibleSection
                title='Connection'
                description='Port and serial link settings.'
                isOpen={settingsSections.connection}
                onToggle={() => setSettingsSections((current) => ({ ...current, connection: !current.connection }))}
              >
                <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
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
                </div>
              </CollapsibleSection>

              <CollapsibleSection
                title='Scan window'
                description='Address range, paging, and Modbus request chunking.'
                isOpen={settingsSections.scan}
                onToggle={() => setSettingsSections((current) => ({ ...current, scan: !current.scan }))}
              >
                <div className='grid gap-3 md:grid-cols-2 xl:grid-cols-4'>
                <Field label='Auto-poll interval (ms)'>
                  <Input aria-label='Auto-poll interval' value={form.autoPollMs} onChange={(event) => updateForm('autoPollMs', event.target.value)} />
                </Field>

                <Field label='Start register'>
                  <Input aria-label='Start register' value={form.startRegister} onChange={(event) => updateForm('startRegister', event.target.value)} />
                </Field>

                <Field label='Register count'>
                  <Input aria-label='Register count' value={form.registerCount} onChange={(event) => updateForm('registerCount', event.target.value)} />
                  <div className='text-[11px] text-muted-foreground'>How many registers to show in the current matrix page.</div>
                </Field>

                <Field label='Registers per request'>
                  <Input aria-label='Registers per request' value={form.registersPerRequest} onChange={(event) => updateForm('registersPerRequest', event.target.value)} />
                  <div className='text-[11px] text-muted-foreground'>Chunk size per Modbus read. Large scans are split into multiple requests using this value.</div>
                </Field>
                </div>
              </CollapsibleSection>
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

            {feedback?.isError ? (
                <div className={cn(
                  'mt-4 rounded-2xl border px-3 py-2 text-sm',
                  'border-rose-500/25 bg-rose-500/10 text-rose-200',
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
                <div className='mt-4'>
                  <div className='space-y-0'>
                    <div className='grid w-full gap-0' style={{ gridTemplateColumns: `6rem repeat(${matrixColumnCount}, minmax(0, 1fr))` }}>
                        <div className='border border-border/70 bg-background/80 px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground'>
                          Address
                        </div>
                        {Array.from({ length: matrixColumnCount }, (_, offset) => (
                          <div
                            key={offset}
                            className='border border-l-0 border-border/70 bg-background/80 px-2 py-1.5 text-left text-[10px] uppercase tracking-[0.16em] text-muted-foreground'
                          >
                            +{offset}
                          </div>
                        ))}
                    </div>

                    {matrixRows.map((row) => (
                      <div
                        key={row.rowAddress}
                        className='relative isolate grid gap-0'
                        style={{ gridTemplateColumns: `6rem repeat(${matrixColumnCount}, minmax(0, 1fr))` }}
                      >
                          <div
                            className='border border-t-0 border-border/70 bg-background/70 px-2 py-1.5 text-left font-mono text-xs font-semibold text-foreground'
                            style={{ gridColumn: '1' }}
                          >
                            {row.rowAddress}
                          </div>
                          {row.cells.map((register, index) => {
                            if (!register) {
                              return (
                                <div
                                  key={`${row.rowAddress}-${index}`}
                                  className='border border-l-0 border-t-0 border-dashed border-border/60 bg-muted/15 px-2 py-2'
                                  style={{ gridColumn: String(index + 2) }}
                                />
                              );
                            }

                            if (coveredAnnotationAddresses.has(register.address)) {
                              return null;
                            }

                            const inSelection = selection != null
                              && register.address >= selection.startAddress
                              && register.address <= selection.endAddress;
                            const display = formatRegisterValue(register, matrixDisplayMode);

                            return (
                              <button
                                key={register.address}
                                type='button'
                                aria-label={`Register ${register.address}: ${display.primary}`}
                                onClick={(event) => handleRegisterClick(register.address, event.shiftKey)}
                                className={cn(
                                  'relative z-0 flex min-h-14 w-full min-w-0 flex-col border border-l-0 border-t-0 px-2 py-1.5 text-left font-mono text-xs transition-colors',
                                  inSelection ? 'border-primary/35 bg-primary/10 text-foreground' : 'border-border/70 bg-background/70 hover:bg-accent/35',
                                )}
                                style={{ gridColumn: String(index + 2) }}
                              >
                                <span className={cn('break-all text-sm text-foreground', matrixDisplayMode === 'binary' && 'text-[10px]')}>
                                  {display.primary}
                                </span>
                              </button>
                            );
                          })}

                          {(annotationSegments.get(row.rowAddress) ?? []).map((segment) => {
                            const annotation = annotations.find((item) => item.id === segment.annotationId);
                            if (!annotation) {
                              return null;
                            }

                            const preview = annotationPreviews.get(annotation.id);
                            return (
                              <div
                                key={`${segment.annotationId}-${segment.rowAddress}`}
                                className={cn(
                                  'pointer-events-none z-10 border px-2 py-1 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)] backdrop-blur-[1px]',
                                  annotationPalette[annotation.colorIndex % annotationPalette.length],
                                )}
                                style={{
                                  gridColumn: `${segment.startOffset + 2} / ${segment.endOffset + 3}`,
                                  gridRow: '1',
                                }}
                              >
                                {segment.isStartSegment ? (
                                  <div className='min-h-[2.5rem]'>
                                    <div className='text-[9px] font-semibold uppercase tracking-[0.14em]'>{annotation.name}</div>
                                    <div className='mt-0.5 truncate font-mono text-xs font-semibold'>{preview?.value ?? 'Pending'}</div>
                                    <div className='mt-0.5 truncate text-[10px] opacity-75'>
                                      {annotation.dataType}
                                      {annotation.formatter ? ` · ${annotation.formatter}` : ''}
                                      {annotation.bitMask ? ` · mask ${toMaskLabel(annotation.bitMask)}` : ''}
                                    </div>
                                  </div>
                                ) : (
                                  <div className='min-h-[2.5rem]' />
                                )}
                              </div>
                            );
                          })}
                      </div>
                    ))}
                  </div>

                  <div className='mt-3 flex flex-wrap items-center justify-between gap-2'>
                    <div className='font-mono text-xs text-muted-foreground'>
                      {scanResult.startRegister}-{scanResult.startRegister + scanResult.registerCount - 1}
                    </div>
                    <div className='flex gap-2'>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => void shiftRegisterPage(-1)}
                        disabled={isLoading || scanResult.startRegister <= 0}
                      >
                        Prev {Math.max(0, scanResult.startRegister - scanResult.registerCount)}-{Math.max(0, scanResult.startRegister - 1)}
                      </Button>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        onClick={() => void shiftRegisterPage(1)}
                        disabled={isLoading}
                      >
                        Next {scanResult.startRegister + scanResult.registerCount}-{scanResult.startRegister + (scanResult.registerCount * 2) - 1}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className='mt-4 rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground'>
                  Connect to a device to populate the scanner matrix.
                </div>
              )}
          </div>

          <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
              <div className='flex flex-wrap items-center justify-between gap-3'>
                <div>
                  <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Selection</div>
                  <div className='mt-1 text-sm text-muted-foreground'>
                    Click a register for a single-word selection. Shift-click another row to expand to a contiguous range.
                  </div>
                </div>
              </div>

              {selection ? (
                <div className='mt-4 space-y-4'>
                  <div className='rounded-2xl border border-border/70 bg-background/55 p-4'>
                    <div className='grid gap-3 md:grid-cols-2'>
                      <Field label='Entity name'>
                        <Input aria-label='Entity name' value={entityDraft.name} onChange={(event) => setEntityDraft((current) => ({ ...current, name: event.target.value }))} />
                      </Field>
                      <Field label='Category'>
                        <Input aria-label='Entity category' value={entityDraft.category} onChange={(event) => setEntityDraft((current) => ({ ...current, category: event.target.value }))} />
                      </Field>
                      <Field label='Entity type'>
                        <Select value={entityDraft.entityType} onValueChange={(value) => setEntityDraft((current) => ({ ...current, entityType: (value ?? 'sensor') as ModbusEntityKind }))}>
                          <SelectTrigger aria-label='Entity type' className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {entityTypeOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label='Data type'>
                        <Select value={entityDraft.dataType} onValueChange={(value) => setEntityDraft((current) => ({ ...current, dataType: (value ?? 'uint16') as ModbusEntityDataType }))}>
                          <SelectTrigger aria-label='Entity data type' className='w-full'>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {entityDataTypeOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      <Field label='Formatter / converter'>
                        <Input aria-label='Entity formatter' value={entityDraft.formatter} onChange={(event) => setEntityDraft((current) => ({ ...current, formatter: event.target.value }))} placeholder='plain-number, custom formatter, converter id' />
                      </Field>
                      <Field label='Unit'>
                        <Input aria-label='Entity unit' value={entityDraft.unit} onChange={(event) => setEntityDraft((current) => ({ ...current, unit: event.target.value }))} placeholder='°C, V, rpm' />
                      </Field>
                      <Field label='Scale'>
                        <Input aria-label='Entity scale' value={entityDraft.scale} onChange={(event) => setEntityDraft((current) => ({ ...current, scale: event.target.value }))} />
                      </Field>
                      <Field label='Bit mask'>
                        <Input aria-label='Entity bit mask' value={entityDraft.bitMask} onChange={(event) => setEntityDraft((current) => ({ ...current, bitMask: event.target.value }))} placeholder='0x000F' />
                      </Field>
                    </div>

                    <div className='mt-4 flex flex-wrap items-center gap-2'>
                      <Button type='button' onClick={saveEntityMapping}>
                        Save mapping
                      </Button>
                      {activeAnnotation ? (
                        <Button
                          type='button'
                          variant='ghost'
                          onClick={() => {
                            setActiveAnnotationId(null);
                            setEntityDraft({
                              name: '',
                              category: 'Registers',
                              entityType: 'sensor',
                              dataType: matrixDisplayModeToEntityDataType(matrixDisplayMode),
                              formatter: '',
                              unit: '',
                              scale: '1',
                              bitMask: '',
                            });
                          }}
                        >
                          Clear editor
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className='space-y-2'>
                    {selectionPreview.map((value) => (
                      <div key={value.label} className='rounded-xl border border-border/70 bg-background/70 px-3 py-3'>
                        <div className='flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>
                          <Cable className='h-3.5 w-3.5' />
                          {value.label}
                        </div>
                        <div className='mt-2 break-all font-mono text-sm text-foreground'>{value.value}</div>
                        {value.detail ? <div className='mt-1 text-xs text-muted-foreground'>{value.detail}</div> : null}
                      </div>
                    ))}
                  </div>
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

          {annotations.length > 0 ? (
            <div className='rounded-2xl border border-border/70 bg-background/45 p-4'>
                <div className='flex flex-wrap items-center justify-between gap-3'>
                  <div>
                    <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>Mapped entities</div>
                    <div className='mt-1 text-sm text-muted-foreground'>These overlays stay aligned with the matrix and use the same register ranges you selected.</div>
                  </div>
                  <div className='rounded-xl border border-border/70 bg-background/80 px-3 py-2 text-right'>
                    <div className='text-[10px] uppercase tracking-[0.18em] text-muted-foreground'>Mapped</div>
                    <div className='font-mono text-xs text-foreground'>{annotations.length}</div>
                  </div>
                </div>

                <div className='mt-4 space-y-2'>
                  {annotations.map((annotation) => {
                    const preview = annotationPreviews.get(annotation.id);
                    return (
                      <div key={annotation.id} className='rounded-xl border border-border/70 bg-background/70 px-3 py-3'>
                        <div className='flex flex-wrap items-center justify-between gap-2'>
                          <div>
                            <div className='font-semibold text-foreground'>{annotation.name}</div>
                            <div className='text-xs text-muted-foreground'>
                              {annotation.entityType} · {annotation.dataType} · {annotation.startAddress}-{annotation.endAddress}
                            </div>
                          </div>
                          <div className='flex flex-wrap gap-2'>
                            <Button type='button' size='sm' variant='outline' onClick={() => loadAnnotation(annotation)}>Edit</Button>
                            <Button type='button' size='sm' variant='ghost' onClick={() => removeAnnotation(annotation.id)}>Remove</Button>
                          </div>
                        </div>
                        <div className='mt-2 font-mono text-sm text-foreground'>{preview?.value ?? 'Pending'}</div>
                        <div className='mt-1 text-xs text-muted-foreground'>
                          {buildEntitySnippet(annotation, scanResult?.startRegister ?? 0)}
                        </div>
                      </div>
                    );
                  })}
                </div>
            </div>
          ) : null}

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

function CollapsibleSection({
  title,
  description,
  isOpen,
  onToggle,
  aside,
  children,
}: {
  title: string;
  description: string;
  isOpen: boolean;
  onToggle: () => void;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className='rounded-2xl border border-border/70 bg-background/45'>
      <button
        type='button'
        onClick={onToggle}
        className='flex w-full items-center justify-between gap-3 px-4 py-3 text-left'
      >
        <div className='min-w-0'>
          <div className='text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground'>{title}</div>
          <div className='mt-1 text-sm text-muted-foreground'>{description}</div>
        </div>
        <div className='flex items-center gap-3'>
          {aside}
          <div className='font-mono text-xs text-muted-foreground'>{isOpen ? 'Hide' : 'Show'}</div>
        </div>
      </button>
      {isOpen ? (
        <div className='border-t border-border/70 px-4 py-4'>
          {children}
        </div>
      ) : null}
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

function validateScanResult(result: ModbusScannerReadResult) {
  if (result.registers.length !== result.registerCount) {
    throw new Error(
      `Scanner returned ${result.registers.length} registers for requested range ${result.startRegister}-${result.startRegister + result.registerCount - 1}. ` +
      'Reduce the page size or registers-per-request and try again.',
    );
  }

  return result;
}

function parseInteger(value: string, label: string) {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error(`${label} must be a whole number.`);
  }

  return Number.parseInt(normalized, 10);
}

function parseIntegerOrFallback(value: string, fallbackValue: number) {
  const normalized = value.trim();
  if (!/^-?\d+$/.test(normalized)) {
    return fallbackValue;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
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

function parseOptionalInteger(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return Number.parseInt(normalized.slice(2), 16);
  }

  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }

  return null;
}

function parseDecimal(value: string, fallbackValue: number) {
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function slugifyEntityId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function matrixDisplayModeToEntityDataType(mode: ModbusMatrixDisplayMode): ModbusEntityDataType {
  switch (mode) {
    case 'ascii':
      return 'ascii';
    case 'signed':
      return 'int16';
    case 'unsigned':
      return 'uint16';
    case 'binary':
    case 'hex':
    default:
      return 'hex';
  }
}

function rangesOverlap(left: ModbusMatrixAnnotation, right: ModbusMatrixAnnotation) {
  return Math.max(left.startAddress, right.startAddress) <= Math.min(left.endAddress, right.endAddress);
}

function toMaskLabel(value: number) {
  return `0x${value.toString(16).toUpperCase()}`;
}

function buildEntitySnippet(annotation: ModbusMatrixAnnotation, startRegister: number) {
  const byteOffset = (annotation.startAddress - startRegister) * 2;
  const fields = [
    `"id": "${annotation.id}"`,
    `"type": "${annotation.entityType}"`,
    `"name": "${annotation.name}"`,
    `"source": { "byteOffset": ${byteOffset}, "dataType": "${annotation.dataType}"${annotation.bitMask ? `, "bitMask": ${annotation.bitMask}` : ''}${annotation.unit ? `, "unit": "${annotation.unit}"` : ''}${annotation.scale && annotation.scale !== 1 ? `, "scale": ${annotation.scale}` : ''} }`,
  ];

  if (annotation.formatter) {
    fields.push(`"display": { "formatter": "${annotation.formatter}" }`);
  }

  return `{ ${fields.join(', ')} }`;
}
