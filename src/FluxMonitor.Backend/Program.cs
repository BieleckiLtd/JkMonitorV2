using FluxMonitor.Backend.Configuration;
using FluxMonitor.Backend.Services;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Configuration
    .AddJsonFile("appsettings.Local.json", optional: true, reloadOnChange: true)
    .AddJsonFile($"appsettings.{builder.Environment.EnvironmentName}.Local.json", optional: true, reloadOnChange: true);

var monitorSection = builder.Configuration.GetSection("Monitor");
var storageProvider = monitorSection.GetValue<string>("Storage:Provider");
var storageConnectionString = monitorSection.GetValue<string>("Storage:ConnectionString");
var storageConfigured =
    string.Equals(storageProvider, "TimescaleDb", StringComparison.OrdinalIgnoreCase) &&
    !string.IsNullOrWhiteSpace(storageConnectionString);
var configuredLogStorageOptions = builder.Configuration.GetSection("Monitor:LogStorage").Get<LogStorageOptions>();
var logStorageOptions = LogStorageOptions.Resolve(
    configuredLogStorageOptions,
    storageConfigured ? storageConnectionString : null);
var logStore = new PostgresLogStore(logStorageOptions);

await logStore.InitializeAsync(CancellationToken.None);
await ManagedInstallAudit.TryPersistPendingAuditAsync(builder.Environment.ContentRootPath, logStore, CancellationToken.None);

builder.Services
    .AddOptions<FluxMonitor.Contracts.Configuration.MonitorConfiguration>()
    .Bind(monitorSection)
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddControllers();
builder.Services.AddOpenApi();
builder.Services.AddSingleton(logStore);
builder.Services.AddSingleton<ILogQueryService>(logStore);

builder.Host.UseSerilog((context, services, loggerConfiguration) => loggerConfiguration
    .ReadFrom.Configuration(context.Configuration)
    .Enrich.FromLogContext()
    .WriteTo.Console()
    .WriteTo.Sink(new PersistentLogSink(logStore)));

builder.Services.AddSingleton<FluxMonitor.Backend.Services.HostSystemMonitoringService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.IBuildMetadataProvider, FluxMonitor.Backend.Services.AssemblyBuildMetadataProvider>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DeviceConfigStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DeviceStateStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.NetworkManagementService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.WifiCredentialStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.BluetoothManagementService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.SshManagementService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DirectAccessStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DirectAccessService>();
builder.Services.AddHostedService<FluxMonitor.Backend.Services.DirectAccessBackgroundService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.HostServicesCatalogService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.ICommandRunner, FluxMonitor.Backend.Services.ProcessCommandRunner>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.ManagedRestartService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.CloudflareTunnelStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.CloudflareTunnelService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.IInternetSpeedTestStore, FluxMonitor.Backend.Services.InternetSpeedTestStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.InternetSpeedTestService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.UpdateProgressBroadcaster>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.SystemUpdateService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.PollTrigger>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.CellVoltageSmoothingFilter>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.ExpressionEvaluator>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DefinitionDrivenTelemetryBuilder>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.GenericModbusPollingClient>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.GenericBlePollingClient>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.PollingClientDispatcher>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.IDevicePollingClient>(sp => sp.GetRequiredService<FluxMonitor.Backend.Services.PollingClientDispatcher>());
builder.Services.AddSingleton<FluxMonitor.Backend.Services.SetupConfigurationService>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.DeviceOrchestrator>();

// Notification system
builder.Services.AddHttpClient();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.NotificationConfigStore>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.INotificationChannelSender, FluxMonitor.Backend.Services.NtfyChannelSender>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.INotificationChannelSender, FluxMonitor.Backend.Services.EmailChannelSender>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.INotificationChannelSender, FluxMonitor.Backend.Services.BrevoChannelSender>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.INotificationChannelSender, FluxMonitor.Backend.Services.TelegramChannelSender>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.NotificationDispatcher>();
builder.Services.AddSingleton<FluxMonitor.Backend.Services.NotificationEvaluator>();

// Device definition loader
var definitionsPath = monitorSection.GetValue<string>("DeviceDefinitionsPath") ?? "devices";
builder.Services.AddSingleton(sp => new FluxMonitor.Backend.Services.DeviceDefinitionLoader(
    definitionsPath,
    builder.Environment.ContentRootPath,
    sp.GetRequiredService<IHttpClientFactory>(),
    sp.GetRequiredService<ILogger<FluxMonitor.Backend.Services.DeviceDefinitionLoader>>()));

if (storageConfigured)
{
    builder.Services.AddSingleton<FluxMonitor.Backend.Services.TimescaleTelemetryRepository>();
    builder.Services.AddSingleton<FluxMonitor.Backend.Services.ITelemetryRepository>(sp => sp.GetRequiredService<FluxMonitor.Backend.Services.TimescaleTelemetryRepository>());
}
else
{
    builder.Services.AddSingleton<FluxMonitor.Backend.Services.ITelemetryRepository, FluxMonitor.Backend.Services.NoOpTelemetryRepository>();
}

if (storageConfigured)
{
    builder.Services.AddHostedService<FluxMonitor.Backend.Services.TelemetryShutdownFlushService>();
    builder.Services.AddHostedService<FluxMonitor.Backend.Services.PollingBackgroundService>();
    builder.Services.AddHostedService<FluxMonitor.Backend.Services.RetentionBackgroundService>();
}

var app = builder.Build();
var buildInfo = app.Services.GetRequiredService<FluxMonitor.Backend.Services.IBuildMetadataProvider>().GetBuildInfo();
var lifecycleLogger = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("FluxMonitor.Lifecycle");

lifecycleLogger.LogInformation(
    "Flux Monitor application starting. Environment={EnvironmentName}, ReleaseTag={ReleaseTag}, InformationalVersion={InformationalVersion}, MachineName={MachineName}.",
    app.Environment.EnvironmentName,
    buildInfo.ReleaseTag ?? "<none>",
    buildInfo.InformationalVersion ?? "<none>",
    Environment.MachineName);

app.Lifetime.ApplicationStarted.Register(() =>
    lifecycleLogger.LogInformation(
        "Flux Monitor application started. Environment={EnvironmentName}, ReleaseTag={ReleaseTag}, InformationalVersion={InformationalVersion}.",
        app.Environment.EnvironmentName,
        buildInfo.ReleaseTag ?? "<none>",
        buildInfo.InformationalVersion ?? "<none>"));

app.Lifetime.ApplicationStopping.Register(() =>
    lifecycleLogger.LogInformation(
        "Flux Monitor application stopping. Environment={EnvironmentName}, ReleaseTag={ReleaseTag}, InformationalVersion={InformationalVersion}.",
        app.Environment.EnvironmentName,
        buildInfo.ReleaseTag ?? "<none>",
        buildInfo.InformationalVersion ?? "<none>"));

app.Lifetime.ApplicationStopped.Register(() =>
    lifecycleLogger.LogInformation(
        "Flux Monitor application stopped. Environment={EnvironmentName}, ReleaseTag={ReleaseTag}, InformationalVersion={InformationalVersion}.",
        app.Environment.EnvironmentName,
        buildInfo.ReleaseTag ?? "<none>",
        buildInfo.InformationalVersion ?? "<none>"));

if (!storageConfigured)
{
    app.Logger.LogError(
        "PostgreSQL storage is not configured. Flux Monitor started in setup-required mode. Set Monitor:Storage:ConnectionString and restart.");
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

using (var scope = app.Services.CreateScope())
{
    var definitionLoader = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.DeviceDefinitionLoader>();
    definitionLoader.LoadAll();

    var deviceConfigStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.DeviceConfigStore>();
    await deviceConfigStore.InitializeAsync(CancellationToken.None);

    var repository = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.ITelemetryRepository>();
    await repository.InitializeAsync(CancellationToken.None);

    var notificationConfigStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.NotificationConfigStore>();
    await notificationConfigStore.InitializeAsync(CancellationToken.None);

    var wifiCredentialStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.WifiCredentialStore>();
    await wifiCredentialStore.InitializeAsync(CancellationToken.None);

    var cloudflareTunnelStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.CloudflareTunnelStore>();
    await cloudflareTunnelStore.InitializeAsync(CancellationToken.None);

    var cloudflareTunnelService = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.CloudflareTunnelService>();
    await cloudflareTunnelService.InitializeAsync(CancellationToken.None);

    var internetSpeedTestStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.IInternetSpeedTestStore>();
    await internetSpeedTestStore.InitializeAsync(CancellationToken.None);

    var internetSpeedTestService = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.InternetSpeedTestService>();
    await internetSpeedTestService.InitializeAsync(CancellationToken.None);

    var directAccessStore = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.DirectAccessStore>();
    await directAccessStore.InitializeAsync(CancellationToken.None);

    var directAccessService = scope.ServiceProvider.GetRequiredService<FluxMonitor.Backend.Services.DirectAccessService>();
    await directAccessService.InitializeAsync(CancellationToken.None);
}

app.UseDefaultFiles();
app.UseStaticFiles();

app.UseAuthorization();
app.MapControllers();
app.MapFallbackToFile("index.html");

try
{
    await app.RunAsync();
}
finally
{
    Log.CloseAndFlush();
}
