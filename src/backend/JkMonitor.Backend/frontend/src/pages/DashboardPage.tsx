export function DashboardPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-3xl font-bold tracking-tight text-foreground mb-2">Overview</h2>
        <p className="text-sm text-muted-foreground">
          Real-time metrics and extension dashboard. Your command center.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: "Total Devices", value: "24", sub: "+3 recently", color: "text-blue-500" },
          { title: "Active BMS", value: "18", sub: "All Nominal", color: "text-emerald-500" },
          { title: "Data Ingress", value: "1.2k req/s", sub: "Peak 1.5k", color: "text-amber-500" },
          { title: "Errors (24h)", value: "0", sub: "System Stable", color: "text-red-500" },
        ].map((stat, i) => (
          <div key={i} className="bg-card text-card-foreground shadow-sm backdrop-blur-md rounded-xl p-6 border border-border">
            <h3 className="text-sm font-medium text-muted-foreground mb-2">{stat.title}</h3>
            <div className={`text-4xl font-bold tracking-tighter ${stat.color}`}>{stat.value}</div>
            <p className="text-xs text-muted-foreground mt-2">{stat.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-card text-card-foreground shadow-sm rounded-xl border border-border p-6 min-h-[400px] flex items-center justify-center">
          <p className="text-muted-foreground font-mono text-sm">[Chart Plugin Container Placeholder]</p>
        </div>
        <div className="bg-card text-card-foreground shadow-sm rounded-xl border border-border p-6 min-h-[400px]">
          <h3 className="font-semibold text-foreground mb-4">Recent Events</h3>
          <ul className="space-y-4">
            <li className="flex items-start gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-foreground">Device Added: JK-BMS-01</p>
                <p className="text-xs text-muted-foreground font-mono">2 mins ago via RS485-1</p>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-500 mt-1.5 shrink-0" />
              <div>
                <p className="text-sm text-foreground">Community Plugin Updated</p>
                <p className="text-xs text-muted-foreground font-mono">1 hr ago: Victron Inverter Modbus</p>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
