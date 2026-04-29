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
        WriteInt16LittleEndian(live, 230, 5932);
        WriteInt16LittleEndian(live, 252, 268);
        live[166] = 1;
        live[167] = 87;
        WriteUInt32LittleEndian(live, 176, 123);
        live[192] = 1;
        live[193] = 0;
        live[209] = 1;
        WriteUInt16LittleEndian(live, 212, 45);
        WriteUInt32LittleEndian(live, 264, 86400);
        live[268] = 1;
        live[275] = 0x06;

        WriteUInt32LittleEndian(config, 0, 51200);

        WriteAscii(info, 0, 16, "JK_PB2A16S15P");
        WriteAscii(info, 16, 8, "14.XA");
        WriteAscii(info, 24, 8, "14.20");
        info[228] = 3;

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

        var batteryTemp3 = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "battery_temp_3");
        var heatingStatus = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "heating_status");
        var heatingCurrent = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "heating_current");
        var emergencyTimer = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "emergency_time_countdown");
        var timeEnterSleep = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "time_enter_sleep");
        var pclModule = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "pcl_module_state");
        var dry1Alarm = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "dry_contact_1");
        var dry2Alarm = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "dry_contact_2");
        var lcdBuzzerTrigger = result.Snapshot.Parameters.FirstOrDefault(p => p.Key == "lcd_buzzer_trigger");

        Assert.Equal(26.8m, batteryTemp3?.NumericValue);
        Assert.True(heatingStatus?.BooleanValue);
        Assert.Equal(5.932m, heatingCurrent?.NumericValue);
        Assert.Equal(45m, emergencyTimer?.NumericValue);
        Assert.Equal(86400m, timeEnterSleep?.NumericValue);
        Assert.True(pclModule?.BooleanValue);
        Assert.True(dry1Alarm?.BooleanValue);
        Assert.True(dry2Alarm?.BooleanValue);
        Assert.Equal(3m, lcdBuzzerTrigger?.NumericValue);
    }

    [Fact]
    public void BuildPollResult_ParsesSignedInverterLoadRegisterWithoutOffsetError()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            RepositoryRoot,
            new StubHttpClientFactory(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadFromJson(File.ReadAllText(Path.Combine(RepositoryRoot, "devices", "anenji-inverter-rs232.json")));

        var definition = loader.Get("anenji-inverter-rs232");
        var liveMain = new byte[34];
        var liveAc = new byte[24];

        WriteInt16BigEndian(liveMain, 16, 31);

        WriteInt16BigEndian(liveAc, 0, 2300);
        WriteInt16BigEndian(liveAc, 4, 450);
        WriteInt16BigEndian(liveAc, 16, 2300);
        WriteInt16BigEndian(liveAc, 18, 1);
        WriteInt16BigEndian(liveAc, 20, -29);
        WriteUInt16BigEndian(liveAc, 22, 19);

        var builder = new DefinitionDrivenTelemetryBuilder(new ExpressionEvaluator());
        var result = builder.BuildPollResult(
            definition,
            new Dictionary<string, byte[]>
            {
                ["live_main"] = liveMain,
                ["live_ac"] = liveAc,
            },
            new DateTimeOffset(2026, 4, 16, 19, 0, 0, TimeSpan.Zero));

        var gridPower = result.Snapshot.Parameters.FirstOrDefault(parameter => parameter.Key == "grid_power");
        var outputActivePower = result.Snapshot.Parameters.FirstOrDefault(parameter => parameter.Key == "output_active_power");

        Assert.NotNull(gridPower);
        Assert.NotNull(outputActivePower);
        Assert.Equal(450m, gridPower!.NumericValue);
        Assert.Equal(-29m, outputActivePower!.NumericValue);
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

    private static void WriteUInt16BigEndian(byte[] buffer, int offset, ushort value)
    {
        buffer[offset] = (byte)(value >> 8);
        buffer[offset + 1] = (byte)(value & 0xFF);
    }

    private static void WriteInt16BigEndian(byte[] buffer, int offset, short value)
        => WriteUInt16BigEndian(buffer, offset, unchecked((ushort)value));

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
