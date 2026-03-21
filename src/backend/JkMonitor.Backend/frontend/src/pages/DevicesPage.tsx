import { Share2, Settings2, Plus, Zap, Wifi, Usb, Cpu, Radio } from 'lucide-react';

export function DevicesPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-foreground mb-2">Hardware Topology</h2>
        <p className="text-sm text-muted-foreground">
          Visual mapping of all physical buses, protocol bridges, and connected devices.
        </p>
      </div>

      <div className="flex items-center justify-between mt-8">
        <button className="flex items-center gap-2 px-4 py-2 bg-primary hover:opacity-90 rounded-lg text-sm text-primary-foreground font-medium shadow-sm transition-all focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background">
          <Plus className="h-4 w-4" /> Add Virtual Interface
        </button>
        <div className="flex bg-muted border border-border rounded-lg p-1">
          <button className="px-4 py-1.5 text-xs font-semibold text-foreground bg-muted-foreground/20 rounded-md shadow-sm">Topology</button>
          <button className="px-4 py-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors">List View</button>
        </div>
      </div>

      <div className="bg-muted border border-border rounded-xl min-h-[600px] mt-6 relative overflow-hidden flex shadow-inner">
        {/* Grid Background */}
        <div className="absolute inset-0 z-0 opacity-[0.15]" 
          style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, var(--border) 2px, transparent 0)', backgroundSize: '48px 48px', backgroundPosition: 'center' }} 
        />
        
        {/* Canvas / Node area */}
        <div className="relative z-10 w-full h-full p-8 flex flex-col md:flex-row gap-12 items-start justify-center pt-24">
          
          {/* Host Controller Node */}
          <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-card text-card-foreground/90 border border-border rounded-xl p-4 flex items-center gap-4 shadow-2xl backdrop-blur-md">
            <div className="h-10 w-10 rounded-lg bg-muted border border-border flex items-center justify-center">
              <Cpu className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">JK Monitor Edge</h3>
              <p className="text-xs text-muted-foreground/80 font-mono">10.0.0.89 • aarch64</p>
            </div>
            <div className="h-2 w-2 rounded-full bg-primary ml-4 animate-pulse shadow-[0_0_8px_var(--primary)]" />
          </div>

          {/* Connection Lines (CSS visually mocked for layout) */}
          <div className="hidden md:block absolute top-[88px] left-1/2 bottom-0 w-px bg-gradient-to-b from-muted-foreground/30 to-transparent -translate-x-1/2 z-0" />

          {/* RS485 Bus Node */}
          <div className="bg-card text-card-foreground/80 backdrop-blur-xl border border-border rounded-xl p-5 shadow-2xl w-80 relative group hover:border-border/80 transition-colors">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-muted border border-border px-3 py-1 rounded-full flex items-center gap-2">
              <Usb className="h-3 w-3 text-amber-500" />
              <span className="text-[10px] font-mono text-foreground/90">ttyUSB0</span>
            </div>
            
            <div className="flex items-center justify-between mb-4 mt-2">
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <Share2 className="h-4 w-4 text-amber-500" />
                RS485 Bus
              </h3>
              <button className="text-muted-foreground/80 hover:text-foreground/90 transition-colors">
                <Settings2 className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 relative before:absolute before:inset-y-0 before:left-3 before:w-px before:bg-muted-foreground/20">
              <div className="relative pl-8">
                <div className="absolute left-[11px] top-1/2 w-4 h-px bg-muted-foreground/20 -translate-y-1/2" />
                <div className="bg-muted/50 border border-border/50 hover:border-border/80 hover:bg-muted p-3 rounded-lg flex items-center gap-3 transition-colors cursor-pointer">
                  <span className="text-xs font-mono text-muted-foreground w-6">01</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">Main House Battery</p>
                    <p className="text-[10px] text-muted-foreground/80 uppercase tracking-wider mt-0.5">JK BMS Modbus</p>
                  </div>
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                </div>
              </div>

              <div className="relative pl-8">
                <div className="absolute left-[11px] top-1/2 w-4 h-px bg-muted-foreground/20 -translate-y-1/2" />
                <div className="bg-muted/50 border border-border/50 hover:border-border/80 hover:bg-muted p-3 rounded-lg flex items-center gap-3 transition-colors cursor-pointer">
                  <span className="text-xs font-mono text-muted-foreground w-6">02</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">Garage Battery</p>
                    <p className="text-[10px] text-muted-foreground/80 uppercase tracking-wider mt-0.5">Daly BMS</p>
                  </div>
                  <div className="h-1.5 w-1.5 rounded-full bg-red-500" />
                </div>
              </div>
            </div>

            <button className="w-full mt-4 py-2 bg-muted hover:bg-muted-foreground/20 border border-dashed border-border/80 hover:border-muted-foreground text-muted-foreground hover:text-foreground rounded-lg text-xs transition-colors font-medium">
              + Map Node to this Bus
            </button>
          </div>

          {/* BLE Network Node */}
          <div className="bg-card text-card-foreground/80 backdrop-blur-xl border border-border rounded-xl p-5 shadow-2xl w-80 relative group hover:border-border/80 transition-colors">
            <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-muted border border-border px-3 py-1 rounded-full flex items-center gap-2">
              <Radio className="h-3 w-3 text-blue-500" />
              <span className="text-[10px] font-mono text-foreground/90">hci0</span>
            </div>
            
            <div className="flex items-center justify-between mb-4 mt-2">
              <h3 className="font-semibold text-foreground flex items-center gap-2">
                <Zap className="h-4 w-4 text-blue-500" />
                Bluetooth LE
              </h3>
              <button className="text-muted-foreground/80 hover:text-foreground/90 transition-colors">
                <Settings2 className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 relative before:absolute before:inset-y-0 before:left-3 before:w-px before:bg-muted-foreground/20/50 before:border-r before:border-dashed before:border-border">
              <div className="relative pl-8">
                <div className="absolute left-[11px] top-1/2 w-4 h-px border-t border-dashed border-border -translate-y-1/2" />
                <div className="bg-muted/50 border border-border/50 hover:border-border/80 hover:bg-muted p-3 rounded-lg flex items-center gap-3 transition-colors cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">Portable Station</p>
                    <p className="text-[10px] font-mono text-muted-foreground/80 mt-0.5">C4:A1:..:9B</p>
                  </div>
                  <div className="h-1.5 w-1.5 rounded-full bg-primary" />
                </div>
              </div>
            </div>

            <button className="w-full mt-4 flex justify-between items-center px-4 py-2 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/20 hover:border-blue-500/40 text-blue-400 hover:text-blue-300 rounded-lg text-xs transition-colors font-medium">
              <span>Scan for devices</span>
              <Wifi className="h-3 w-3" />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
