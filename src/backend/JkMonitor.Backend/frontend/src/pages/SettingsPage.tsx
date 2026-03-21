export function SettingsPage() {
  return (
    <div className="space-y-6 max-w-4xl mx-auto pb-12">
      <div className="flex flex-col gap-1 border-b border-zinc-900 pb-4">
        <h2 className="text-3xl font-bold tracking-tight text-white mb-2">Global Settings</h2>
        <p className="text-sm text-zinc-400">
          Core configuration for network, MQTT, database retention, and the plugin engine.
        </p>
      </div>

      <div className="grid gap-6 mt-6">
        <section className="bg-zinc-900/30 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-medium text-white mb-4">Plugin Engine</h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-zinc-200">Allow Unsigned Community Plugins</label>
                <p className="text-xs text-zinc-500 mt-1">Enable installing extensions not verified by the core team. (Use at your own risk)</p>
              </div>
              <button className="w-11 h-6 bg-emerald-500 rounded-full relative transition-colors shadow-inner flex items-center shrink-0">
                <span className="w-4 h-4 bg-white rounded-full ml-6 shadow-sm pointer-events-none transition-all"></span>
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <label className="text-sm font-medium text-zinc-200">Plugin Isolation (Sandbox)</label>
                <p className="text-xs text-zinc-500 mt-1">Run user extensions in isolated processes.</p>
              </div>
              <button className="w-11 h-6 bg-zinc-700 rounded-full relative transition-colors shadow-inner flex items-center shrink-0">
                <span className="w-4 h-4 bg-white rounded-full ml-1 shadow-sm pointer-events-none transition-all"></span>
              </button>
            </div>
          </div>
        </section>

        <section className="bg-zinc-900/30 border border-zinc-800 rounded-xl p-6">
          <h3 className="text-lg font-medium text-white mb-4">Data Retention</h3>
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">High-Resolution Analytics</label>
                <select className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500">
                  <option>7 Days</option>
                  <option>14 Days</option>
                  <option>30 Days</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1.5">Downsampled Aggregates</label>
                <select className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm rounded-md px-3 py-2 outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500">
                  <option>1 Year</option>
                  <option>5 Years</option>
                  <option>Forever</option>
                </select>
              </div>
            </div>
          </div>
        </section>
        
        <section className="bg-red-950/20 border border-red-900/50 rounded-xl p-6">
          <h3 className="text-lg font-medium text-red-500 mb-4">Danger Zone</h3>
          <p className="text-sm text-zinc-400 mb-4">Actions here can result in data loss or require a physical reset.</p>
          <div className="flex gap-4">
            <button className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 rounded-md text-sm font-medium transition-colors">
              Purge Database
            </button>
            <button className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-500 border border-red-500/50 rounded-md text-sm font-medium transition-colors">
              Reset Configuration
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
