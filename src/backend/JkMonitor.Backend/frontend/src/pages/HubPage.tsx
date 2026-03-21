export function HubPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-foreground mb-2">Community Hub</h2>
        <p className="text-sm text-muted-foreground">
          Install and manage ready-made third-party device integrations and UI plugins.
        </p>
      </div>

      <div className="flex items-center justify-between mb-8">
        <div className="relative w-full max-w-md">
          <input
            type="text"
            placeholder="Search integrations (e.g., Victron, Deye, USB-TTL)..."
            className="w-full bg-muted border border-border text-sm text-foreground rounded-lg px-4 py-2.5 outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-all placeholder:text-muted-foreground"
          />
        </div>
        <div className="flex gap-2">
          <button className="px-4 py-2 bg-muted-foreground/20 hover:bg-muted-foreground text-sm font-medium rounded-lg text-foreground transition-colors">
            Updates (2)
          </button>
          <button className="px-4 py-2 bg-primary hover:opacity-90 text-sm font-medium rounded-lg text-primary-foreground transition-colors shadow-sm shadow-primary/50">
            Publish New Plugin
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {[
          { name: "JK BMS Official", author: "Core Team", type: "Device", desc: "Native support for JK active balancers via Bluetooth and RS485.", installs: "Pre-installed" },
          { name: "Victron SmartSolar", author: "Community", type: "Device", desc: "VE.Direct protocol implementation for standard MPPT controllers.", installs: "12.4k" },
          { name: "Deye Inverter Status", author: "solar_hacker", type: "Widget", desc: "Dashboard UI widget displaying PV generation and grid flow.", installs: "3.2k" },
          { name: "MQTT Broker Sync", author: "Home Assistant", type: "Transport", desc: "Bridge to automatically advertise all variables over MQTT.", installs: "8.9k" },
          { name: "DLP Battery Node", author: "Community", type: "Device", desc: "Support for generic DIY 16S battery nodes over CAN bus.", installs: "1.1k" },
          { name: "Custom Serial Parser", author: "advanced_user", type: "Parser", desc: "Write regex or JS scripts to parse any generic TTL stream.", installs: "950" },
        ].map((plugin, i) => (
          <div key={i} className="group flex flex-col justify-between bg-card text-card-foreground shadow-sm hover:hover:bg-muted/50 border border-border hover:border-border/80 rounded-xl p-5 transition-all cursor-pointer h-[200px]">
            <div>
              <div className="flex justify-between items-start mb-2">
                <h3 className="font-semibold text-foreground truncate">{plugin.name}</h3>
                <span className="text-[10px] uppercase tracking-wider bg-muted-foreground/20 px-2 py-0.5 rounded text-muted-foreground border border-border/80">
                  {plugin.type}
                </span>
              </div>
              <p className="text-xs text-primary mb-3">by {plugin.author}</p>
              <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed">
                {plugin.desc}
              </p>
            </div>
            
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border/50">
              <span className="text-xs text-muted-foreground/80 font-mono">↙ {plugin.installs}</span>
              {plugin.installs === "Pre-installed" ? (
                <span className="text-sm text-muted-foreground font-medium">Installed</span>
              ) : (
                <button className="text-sm font-medium text-primary hover:opacity-80 opacity-0 group-hover:opacity-100 transition-opacity">
                  Install Plugin
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
