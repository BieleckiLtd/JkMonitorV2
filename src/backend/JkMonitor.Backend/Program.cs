var builder = WebApplication.CreateBuilder(args);

builder.Configuration
    .AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.Local.json", optional: true, reloadOnChange: true);

var monitorSection = builder.Configuration.GetSection("Monitor");
var storageProvider = monitorSection.GetValue<string>("Storage:Provider");

builder.Services
    .AddOptions<JkMonitor.Contracts.Configuration.MonitorConfiguration>()
    .Bind(monitorSection)
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddSingleton<JkMonitor.Backend.Services.DeviceStateStore>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.JkRs485PollingClient>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.SimulatedJkPollingClient>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.IJkPollingClient, JkMonitor.Backend.Services.ConfiguredPollingClient>();

if (string.Equals(storageProvider, "TimescaleDb", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddSingleton<JkMonitor.Backend.Services.ITelemetryRepository, JkMonitor.Backend.Services.TimescaleTelemetryRepository>();
}
else
{
    builder.Services.AddSingleton<JkMonitor.Backend.Services.ITelemetryRepository, JkMonitor.Backend.Services.NoOpTelemetryRepository>();
}

builder.Services.AddHostedService<JkMonitor.Backend.Services.PollingBackgroundService>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

using (var scope = app.Services.CreateScope())
{
    var repository = scope.ServiceProvider.GetRequiredService<JkMonitor.Backend.Services.ITelemetryRepository>();
    await repository.InitializeAsync(CancellationToken.None);
}

app.UseDefaultFiles();
app.UseStaticFiles();

if (!app.Environment.IsDevelopment())
{
    app.UseHttpsRedirection();
}

app.UseAuthorization();
app.MapControllers();
app.MapFallbackToFile("index.html");

app.Run();
