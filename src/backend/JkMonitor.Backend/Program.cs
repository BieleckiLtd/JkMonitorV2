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

var logStore = new JkMonitor.Backend.Services.InMemoryLogStore();
builder.Services.AddSingleton(logStore);
builder.Logging.AddProvider(new JkMonitor.Backend.Services.InMemoryLoggerProvider(logStore));

builder.Services.AddSingleton<JkMonitor.Backend.Services.HostSystemMonitoringService>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.IBuildMetadataProvider, JkMonitor.Backend.Services.AssemblyBuildMetadataProvider>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.DeviceStateStore>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.ManagedRestartService>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.PollTrigger>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.CellVoltageSmoothingFilter>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.ExpressionEvaluator>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.JkRs485PollingClient>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.GenericModbusPollingClient>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.IDevicePollingClient, JkMonitor.Backend.Services.ConfiguredPollingClient>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.SetupConfigurationService>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.DeviceOrchestrator>();

// Notification system
builder.Services.AddHttpClient();
builder.Services.AddSingleton(sp => new JkMonitor.Backend.Services.NotificationConfigStore(
    sp.GetRequiredService<IHostEnvironment>().ContentRootPath,
    sp.GetRequiredService<ILogger<JkMonitor.Backend.Services.NotificationConfigStore>>()));
builder.Services.AddSingleton<JkMonitor.Backend.Services.INotificationChannelSender, JkMonitor.Backend.Services.NtfyChannelSender>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.INotificationChannelSender, JkMonitor.Backend.Services.EmailChannelSender>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.NotificationDispatcher>();
builder.Services.AddSingleton<JkMonitor.Backend.Services.NotificationEvaluator>();

// Device definition loader
var definitionsPath = monitorSection.GetValue<string>("DeviceDefinitionsPath") ?? "devices";
builder.Services.AddSingleton(sp => new JkMonitor.Backend.Services.DeviceDefinitionLoader(
    definitionsPath,
    sp.GetRequiredService<ILogger<JkMonitor.Backend.Services.DeviceDefinitionLoader>>()));

if (string.Equals(storageProvider, "TimescaleDb", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddSingleton<JkMonitor.Backend.Services.TimescaleTelemetryRepository>();
    builder.Services.AddSingleton<JkMonitor.Backend.Services.ITelemetryRepository>(sp => sp.GetRequiredService<JkMonitor.Backend.Services.TimescaleTelemetryRepository>());
}
else if (string.Equals(storageProvider, "Sqlite", StringComparison.OrdinalIgnoreCase))
{
    builder.Services.AddSingleton<JkMonitor.Backend.Services.SqliteTelemetryRepository>();
    builder.Services.AddSingleton<JkMonitor.Backend.Services.ITelemetryRepository>(sp => sp.GetRequiredService<JkMonitor.Backend.Services.SqliteTelemetryRepository>());
}
else
{
    builder.Services.AddSingleton<JkMonitor.Backend.Services.ITelemetryRepository, JkMonitor.Backend.Services.NoOpTelemetryRepository>();
}

builder.Services.AddHostedService<JkMonitor.Backend.Services.PollingBackgroundService>();
builder.Services.AddHostedService<JkMonitor.Backend.Services.RetentionBackgroundService>();

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

using (var scope = app.Services.CreateScope())
{
    var repository = scope.ServiceProvider.GetRequiredService<JkMonitor.Backend.Services.ITelemetryRepository>();
    await repository.InitializeAsync(CancellationToken.None);

    var definitionLoader = scope.ServiceProvider.GetRequiredService<JkMonitor.Backend.Services.DeviceDefinitionLoader>();
    definitionLoader.LoadAll();
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthorization();
app.MapControllers();
app.MapFallbackToFile("index.html");

app.Run();
