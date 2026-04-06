using Dapper;
using FluxMonitor.Contracts.Configuration;
using Microsoft.Extensions.Options;
using Npgsql;

namespace FluxMonitor.Backend.Services;

public sealed class DirectAccessStore(
    IOptions<MonitorConfiguration> configuration,
    ILogger<DirectAccessStore> logger)
    : PostgresStore(configuration.Value.Storage.ConnectionString)
{
    internal const string AutoStartModeOff = "off";
    internal const string AutoStartModeWhenWifiNotConnected = "when-wifi-not-connected";

    private readonly SemaphoreSlim _initializationLock = new(1, 1);
    private readonly object _cacheLock = new();
    private DirectAccessSettings _settings = BuildDefaultSettings(storageAvailable: true);
    private volatile bool _initialized;

    public async Task InitializeAsync(CancellationToken cancellationToken)
    {
        if (_initialized)
        {
            return;
        }

        if (!HasDatabase)
        {
            lock (_cacheLock)
            {
                _settings = BuildDefaultSettings(storageAvailable: false);
            }

            _initialized = true;
            return;
        }

        await _initializationLock.WaitAsync(cancellationToken);

        try
        {
            if (_initialized)
            {
                return;
            }

            await using var connection = await OpenConnectionAsync(cancellationToken);
            await EnsureSchemaAsync(connection, cancellationToken);

            var loadedSettings = await LoadSettingsAsync(connection, cancellationToken);
            lock (_cacheLock)
            {
                _settings = loadedSettings;
            }

            _initialized = true;
            logger.LogInformation(
                "Fallback local access settings loaded from PostgreSQL. AutoStartMode={AutoStartMode}, HasWifiPassword={HasWifiPassword}, HasHotspotNameOverride={HasHotspotNameOverride}, HasBluetoothDeviceNameOverride={HasBluetoothDeviceNameOverride}.",
                loadedSettings.AutoStartMode,
                !string.IsNullOrEmpty(loadedSettings.WifiPassword),
                !string.IsNullOrEmpty(loadedSettings.HotspotNameOverride),
                !string.IsNullOrEmpty(loadedSettings.BluetoothDeviceNameOverride));
        }
        finally
        {
            _initializationLock.Release();
        }
    }

    public async Task<DirectAccessSettings> GetSettingsAsync(CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        lock (_cacheLock)
        {
            return Clone(_settings);
        }
    }

    public async Task SaveSettingsAsync(
        string? autoStartMode,
        string? wifiPassword,
        string? hotspotName,
        string? bluetoothDeviceName,
        CancellationToken cancellationToken)
    {
        await InitializeAsync(cancellationToken);

        if (!HasDatabase)
        {
            throw new InvalidOperationException("Fallback local access settings cannot be saved until PostgreSQL storage is configured.");
        }

        var normalizedSettings = new DirectAccessSettings(
            StorageAvailable: true,
            AutoStartMode: NormalizeAutoStartMode(autoStartMode),
            WifiPassword: NormalizeWifiPassword(wifiPassword),
            HotspotNameOverride: NormalizeOptionalName(hotspotName),
            BluetoothDeviceNameOverride: NormalizeOptionalName(bluetoothDeviceName));

        await using var connection = await OpenConnectionAsync(cancellationToken);
        const string sql = """
            INSERT INTO direct_access_settings (id, auto_start_mode, wifi_password, hotspot_name, bluetooth_device_name, updated_at)
            VALUES (TRUE, @AutoStartMode, @WifiPassword, @HotspotNameOverride, @BluetoothDeviceNameOverride, NOW())
            ON CONFLICT (id) DO UPDATE
            SET
                auto_start_mode = EXCLUDED.auto_start_mode,
                wifi_password = EXCLUDED.wifi_password,
                hotspot_name = EXCLUDED.hotspot_name,
                bluetooth_device_name = EXCLUDED.bluetooth_device_name,
                updated_at = NOW();
            """;

        await connection.ExecuteAsync(new CommandDefinition(
            sql,
            new
            {
                normalizedSettings.AutoStartMode,
                normalizedSettings.WifiPassword,
                normalizedSettings.HotspotNameOverride,
                normalizedSettings.BluetoothDeviceNameOverride
            },
            cancellationToken: cancellationToken));

        lock (_cacheLock)
        {
            _settings = normalizedSettings;
        }
    }

    internal static DirectAccessSettings BuildDefaultSettings(bool storageAvailable)
    {
        return new DirectAccessSettings(
            StorageAvailable: storageAvailable,
            AutoStartMode: AutoStartModeWhenWifiNotConnected,
            WifiPassword: null,
            HotspotNameOverride: null,
            BluetoothDeviceNameOverride: null);
    }

    internal static string NormalizeAutoStartMode(string? value)
    {
        var normalized = value?.Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return AutoStartModeWhenWifiNotConnected;
        }

        if (string.Equals(normalized, AutoStartModeOff, StringComparison.OrdinalIgnoreCase))
        {
            return AutoStartModeOff;
        }

        if (string.Equals(normalized, AutoStartModeWhenWifiNotConnected, StringComparison.OrdinalIgnoreCase))
        {
            return AutoStartModeWhenWifiNotConnected;
        }

        throw new InvalidOperationException(
            $"Unsupported local access mode '{normalized}'. Use '{AutoStartModeOff}' or '{AutoStartModeWhenWifiNotConnected}'.");
    }

    internal static string? NormalizeWifiPassword(string? value)
    {
        if (value is null)
        {
            return null;
        }

        return value.Length == 0 ? null : value;
    }

    internal static string? NormalizeOptionalName(string? value)
    {
        if (value is null)
        {
            return null;
        }

        var normalized = value.Trim();
        return normalized.Length == 0 ? null : normalized;
    }

    private static async Task EnsureSchemaAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string createSql = """
            CREATE TABLE IF NOT EXISTS direct_access_settings (
                id boolean PRIMARY KEY DEFAULT TRUE CHECK (id),
                auto_start_mode text NOT NULL DEFAULT 'when-wifi-not-connected',
                wifi_password text NULL,
                hotspot_name text NULL,
                bluetooth_device_name text NULL,
                updated_at timestamptz NOT NULL DEFAULT NOW()
            );
            """;

        const string migrateSql = """
            ALTER TABLE direct_access_settings
                ADD COLUMN IF NOT EXISTS hotspot_name text NULL;
            ALTER TABLE direct_access_settings
                ADD COLUMN IF NOT EXISTS bluetooth_device_name text NULL;
            """;

        await connection.ExecuteAsync(new CommandDefinition(createSql, cancellationToken: cancellationToken));
        await connection.ExecuteAsync(new CommandDefinition(migrateSql, cancellationToken: cancellationToken));
    }

    private static async Task<DirectAccessSettings> LoadSettingsAsync(NpgsqlConnection connection, CancellationToken cancellationToken)
    {
        const string sql = """
            SELECT
                auto_start_mode AS "AutoStartMode",
                wifi_password AS "WifiPassword",
                hotspot_name AS "HotspotNameOverride",
                bluetooth_device_name AS "BluetoothDeviceNameOverride"
            FROM direct_access_settings
            WHERE id = TRUE;
            """;

        var row = await connection.QuerySingleOrDefaultAsync<DirectAccessSettingsRow>(
            new CommandDefinition(sql, cancellationToken: cancellationToken));

        if (row is null)
        {
            return BuildDefaultSettings(storageAvailable: true);
        }

        return new DirectAccessSettings(
            StorageAvailable: true,
            AutoStartMode: NormalizeAutoStartMode(row.AutoStartMode),
            WifiPassword: NormalizeWifiPassword(row.WifiPassword),
            HotspotNameOverride: NormalizeOptionalName(row.HotspotNameOverride),
            BluetoothDeviceNameOverride: NormalizeOptionalName(row.BluetoothDeviceNameOverride));
    }

    private static DirectAccessSettings Clone(DirectAccessSettings settings)
    {
        return new DirectAccessSettings(
            settings.StorageAvailable,
            settings.AutoStartMode,
            settings.WifiPassword,
            settings.HotspotNameOverride,
            settings.BluetoothDeviceNameOverride);
    }

    public sealed record DirectAccessSettings(
        bool StorageAvailable,
        string AutoStartMode,
        string? WifiPassword,
        string? HotspotNameOverride,
        string? BluetoothDeviceNameOverride);

    private sealed class DirectAccessSettingsRow
    {
        public required string AutoStartMode { get; init; }

        public string? WifiPassword { get; init; }

        public string? HotspotNameOverride { get; init; }

        public string? BluetoothDeviceNameOverride { get; init; }
    }
}
