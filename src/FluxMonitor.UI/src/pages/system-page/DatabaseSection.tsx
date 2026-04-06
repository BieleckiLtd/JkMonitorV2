import type { RefObject } from 'react';
import { Database, Download, LoaderCircle, Upload } from 'lucide-react';
import { PanelHeader } from '../../components/PanelHeader';
import { Card, CardContent } from '../../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { cn } from '../../lib/utils';
import {
  DetailTile,
  supportedPersistedBucketMinutes,
  supportedTemporaryHistoryMinutes,
} from './shared';
import type {
  DatabaseSettingsFormState,
  DatabaseSettingsState,
  DatabaseSizeInfo,
  InlineFeedback,
} from './types';

type DatabaseSectionProps = {
  dbLoading: boolean;
  dbSize: DatabaseSizeInfo | null;
  dbSettingsLoading: boolean;
  dbSettings: DatabaseSettingsState | null;
  dbSettingsForm: DatabaseSettingsFormState | null;
  dbSettingsSaving: boolean;
  dbSettingsDirty: boolean;
  dbSettingsFeedback: InlineFeedback | null;
  importing: boolean;
  importResult: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onRawWindowChange: (value: string) => void;
  onPersistedBucketChange: (value: string) => void;
  onSaveSettings: () => void | Promise<void>;
  onExport: () => void;
  onImportFile: (file: File) => void | Promise<void>;
};

export function DatabaseSection({
  dbLoading,
  dbSize,
  dbSettingsLoading,
  dbSettings,
  dbSettingsForm,
  dbSettingsSaving,
  dbSettingsDirty,
  dbSettingsFeedback,
  importing,
  importResult,
  fileInputRef,
  onRawWindowChange,
  onPersistedBucketChange,
  onSaveSettings,
  onExport,
  onImportFile,
}: DatabaseSectionProps) {
  return (
    <Card className='system-section-card'>
      <PanelHeader
        title='Database'
        description='TimescaleDB storage size, backup, and restore.'
      />
      <CardContent className='space-y-4 pt-5'>
        {dbLoading && !dbSize ? (
          <div className='flex items-center justify-center py-6'>
            <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
          </div>
        ) : dbSize ? (
          <>
            <DetailTile label='Total database size' value={dbSize.totalSizeFormatted} />
            <div className='space-y-2'>
              {dbSize.tables.map((table) => (
                <div key={table.tableName} className='system-detail-tile'>
                  <div className='flex flex-wrap items-center justify-between gap-2'>
                    <div className='system-label font-mono'>{table.tableName}</div>
                    <div className='text-xs text-muted-foreground'>{table.rowCount.toLocaleString()} rows</div>
                  </div>
                  <div className='mt-1 text-sm font-semibold text-foreground'>{table.sizeFormatted}</div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className='text-sm text-muted-foreground'>Unable to load database info.</div>
        )}

        <div className='system-panel-surface'>
          <div className='space-y-1'>
            <div className='text-sm font-semibold text-foreground'>Storage policy</div>
            <div className='max-w-2xl text-xs leading-5 text-muted-foreground'>
              Temporary history stays in memory at the device&apos;s raw poll cadence, so faster polling can keep sub-second samples. Persisted buckets are written to the database forever.
            </div>
          </div>

          {dbSettingsLoading && !dbSettingsForm ? (
            <div className='flex items-center justify-center py-8'>
              <LoaderCircle className='h-5 w-5 animate-spin text-primary' />
            </div>
          ) : dbSettings && dbSettingsForm ? (
            <div className='space-y-4 pt-4'>
              <div className='grid gap-4 sm:grid-cols-2'>
                <label className='space-y-2'>
                  <span className='block system-input-label'>Temporary memory history</span>
                  <Select
                    value={dbSettingsForm.rawSecondsWindowMinutes}
                    onValueChange={(value) => {
                      if (value !== null) {
                        onRawWindowChange(value);
                      }
                    }}
                  >
                    <SelectTrigger aria-label='Temporary memory history minutes' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedTemporaryHistoryMinutes.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className='block text-[11px] leading-5 text-muted-foreground'>Larger temporary memory windows use more RAM, especially when devices poll faster than once per second.</span>
                </label>

                <label className='space-y-2'>
                  <span className='block system-input-label'>Persisted bucket size</span>
                  <Select
                    value={dbSettingsForm.persistedBucketMinutes}
                    onValueChange={(value) => {
                      if (value !== null) {
                        onPersistedBucketChange(value);
                      }
                    }}
                  >
                    <SelectTrigger aria-label='Persisted bucket minutes' className='w-full'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {supportedPersistedBucketMinutes.map((minutes) => (
                        <SelectItem key={minutes} value={String(minutes)}>{minutes} min</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className='block text-[11px] leading-5 text-muted-foreground'>Smaller persisted buckets capture more detail, but they also grow the database faster.</span>
                </label>
              </div>

              {dbSettingsFeedback ? (
                <div className={cn(
                  'system-feedback',
                  dbSettingsFeedback.isError ? 'system-feedback-error' : 'system-feedback-success'
                )}>
                  {dbSettingsFeedback.message}
                </div>
              ) : null}

              <div className='flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between'>
                <div className='text-[11px] leading-5 text-muted-foreground'>
                  Current policy: {dbSettings.rawSecondsWindowMinutes}m of temporary in-memory history, {dbSettings.persistedBucketMinutes}m persisted buckets stored forever in the database.
                </div>
                <button
                  type='button'
                  disabled={dbSettingsSaving || !dbSettingsDirty}
                  onClick={() => void onSaveSettings()}
                  className='system-button-secondary disabled:cursor-not-allowed'
                >
                  {dbSettingsSaving ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Database className='h-4 w-4' />}
                  {dbSettingsSaving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            <div className='pt-4 text-sm text-muted-foreground'>Unable to load database retention settings.</div>
          )}
        </div>

        <div className='flex flex-col gap-2 pt-2'>
          <button
            type='button'
            onClick={onExport}
            className='system-button-secondary'
          >
            <Download className='h-4 w-4' />
            Export database
          </button>

          <input
            ref={fileInputRef}
            type='file'
            accept='.csv,.sql'
            className='hidden'
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onImportFile(file);
              }
              event.target.value = '';
            }}
          />

          <button
            type='button'
            disabled={importing}
            onClick={() => fileInputRef.current?.click()}
            className='system-button-secondary'
          >
            {importing ? <LoaderCircle className='h-4 w-4 animate-spin' /> : <Upload className='h-4 w-4' />}
            {importing ? 'Importing…' : 'Import database'}
          </button>

          {importResult ? (
            <div className={cn(
              'rounded-xl border px-3 py-2 text-xs',
              importResult.includes('successfully') ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-200' : 'border-rose-500/20 bg-rose-500/10 text-rose-200'
            )}>
              {importResult}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
