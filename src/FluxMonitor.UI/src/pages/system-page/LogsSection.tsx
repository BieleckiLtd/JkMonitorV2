import { LogsPanel } from '../../components/LogsPanel';

export function LogsSection() {
  return (
    <div className='flex min-h-full flex-1 flex-col overflow-hidden'>
      <div className='flex min-h-0 flex-1 flex-col'>
        <LogsPanel />
      </div>
    </div>
  );
}
