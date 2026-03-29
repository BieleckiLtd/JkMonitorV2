using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class DefinitionDrivenTelemetryBuilderTests
{
    private static readonly string RepositoryRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void BuildPollResult_ParsesLittleEndianBleBanks()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            RepositoryRoot,
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadFromJson(File.ReadAllText(Path.Combine(RepositoryRoot, "devices", "jk-inverter-bms-ble.json")));

        var definition = loader.Get("jk-inverter-bms-ble");
        var live = new byte[293];
        var config = new byte[293];
        var info = new byte[293];

        WriteUInt16LittleEndian(live, 0, 3300);
        WriteUInt16LittleEndian(live, 2, 3310);
        WriteUInt16LittleEndian(live, 68, 3305);
        WriteUInt16LittleEndian(live, 70, 10);
        WriteInt16LittleEndian(live, 138, 256);
        WriteUInt32LittleEndian(live, 144, 52800);
        WriteInt32LittleEndian(live, 152, -12500);
        WriteInt16LittleEndian(live, 156, 245);
        live[166] = 1;
        live[167] = 87;
        WriteUInt32LittleEndian(live, 176, 123);
        live[192] = 1;
        live[193] = 0;

        WriteUInt32LittleEndian(config, 0, 51200);

        WriteAscii(info, 0, 16, "JK_PB2A16S15P");
        WriteAscii(info, 16, 8, "14.XA");
        WriteAscii(info, 24, 8, "14.20");

        var builder = new DefinitionDrivenTelemetryBuilder(new ExpressionEvaluator());
        var result = builder.BuildPollResult(
            definition,
            new Dictionary<string, byte[]>
            {
                ["live"] = live,
                ["config"] = config,
                ["info"] = info
            },
            new DateTimeOffset(2026, 3, 27, 18, 0, 0, TimeSpan.Zero));

        Assert.Equal(52.8m, result.Snapshot.TotalVoltageVolts);
        Assert.Equal(-12.5m, result.Snapshot.CurrentAmps);
        Assert.Equal(87m, result.Snapshot.StateOfChargePercent);
        Assert.Equal(25.6m, result.Snapshot.MosTemperatureCelsius);
        Assert.Equal(24.5m, result.Snapshot.BatteryTemperatureCelsius);
        Assert.Equal(123, result.Snapshot.CycleCount);
        Assert.True(result.Snapshot.ChargingEnabled);
        Assert.False(result.Snapshot.DischargingEnabled);
        Assert.True(result.Snapshot.BalancingEnabled);
        Assert.Equal("14.20", result.Snapshot.SoftwareVersion);
        Assert.Equal("JK_PB2A16S15P", result.Snapshot.ManufacturerId);
        Assert.Equal(3.300m, result.Snapshot.MinCellVoltageVolts);
        Assert.Equal(3.310m, result.Snapshot.MaxCellVoltageVolts);
        Assert.Equal(3.305m, result.Snapshot.AverageCellVoltageVolts);
        Assert.Equal(0.010m, result.Snapshot.DeltaCellVoltageVolts);

        var smartSleep = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "smart_sleep_voltage");
        Assert.NotNull(smartSleep);
        Assert.Equal(51.200m, smartSleep!.NumericValue);
    }

    private static void WriteUInt16LittleEndian(byte[] buffer, int offset, ushort value)
    {
        buffer[offset] = (byte)(value & 0xFF);
        buffer[offset + 1] = (byte)(value >> 8);
    }

    private static void WriteInt16LittleEndian(byte[] buffer, int offset, short value)
        => WriteUInt16LittleEndian(buffer, offset, unchecked((ushort)value));

    private static void WriteUInt32LittleEndian(byte[] buffer, int offset, uint value)
    {
        buffer[offset] = (byte)(value & 0xFF);
        buffer[offset + 1] = (byte)((value >> 8) & 0xFF);
        buffer[offset + 2] = (byte)((value >> 16) & 0xFF);
        buffer[offset + 3] = (byte)((value >> 24) & 0xFF);
    }

    private static void WriteInt32LittleEndian(byte[] buffer, int offset, int value)
        => WriteUInt32LittleEndian(buffer, offset, unchecked((uint)value));

    private static void WriteAscii(byte[] buffer, int offset, int length, string value)
    {
        var bytes = System.Text.Encoding.ASCII.GetBytes(value);
        Array.Copy(bytes, 0, buffer, offset, Math.Min(bytes.Length, length));
    }

    private sealed class StubHttpClientFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
