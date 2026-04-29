using FluxMonitor.Backend.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class JkBleDefinitionTests
{
    private static readonly string RepositoryRoot = Path.GetFullPath(
        Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void JkBleLiveBank_UsesNotifyStreamWithCommandFallback()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            RepositoryRoot,
            new HttpClientFactoryStub(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadFromJson(File.ReadAllText(Path.Combine(RepositoryRoot, "devices", "jk-inverter-bms-ble.json")));

        var definition = loader.Get("jk-inverter-bms-ble");
        Assert.Equal(["config", "live", "info"], definition.DataSources.Select(bank => bank.Id).ToArray());

        var liveBank = Assert.Single(definition.DataSources, bank => bank.Id == "live");

        Assert.Equal("notify-stream", liveBank.ReadMode);
        Assert.Equal(0x97, liveBank.Command);
    }

    [Fact]
    public void JkBleDefinition_ExposesExpandedMonitorFields()
    {
        var loader = new DeviceDefinitionLoader(
            "devices",
            RepositoryRoot,
            new HttpClientFactoryStub(),
            NullLogger<DeviceDefinitionLoader>.Instance);
        loader.LoadFromJson(File.ReadAllText(Path.Combine(RepositoryRoot, "devices", "jk-inverter-bms-ble.json")));

        var definition = loader.Get("jk-inverter-bms-ble");
        var entityIds = definition.Entities.Select(entity => entity.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

        Assert.Contains("battery_temp_3", entityIds);
        Assert.Contains("heating_status", entityIds);
        Assert.Contains("heating_current", entityIds);
        Assert.Contains("emergency_time_countdown", entityIds);
        Assert.Contains("time_enter_sleep", entityIds);
        Assert.Contains("pcl_module_state", entityIds);
        Assert.Contains("dry_contact_1", entityIds);
        Assert.Contains("dry_contact_2", entityIds);
        Assert.Contains("lcd_buzzer_trigger", entityIds);

        Assert.Equal("Thermal Protection", Assert.Single(definition.Entities, entity => entity.Id == "mos_temperature").Category);
        Assert.Equal("Thermal Protection", Assert.Single(definition.Entities, entity => entity.Id == "battery_temp_3").Category);
        Assert.Equal("Charging", Assert.Single(definition.Entities, entity => entity.Id == "charge_status").Category);
        Assert.Equal("System", Assert.Single(definition.Entities, entity => entity.Id == "heating_status").Category);
        Assert.Equal("System", Assert.Single(definition.Entities, entity => entity.Id == "pcl_module_state").Category);

        var pages = definition.Ui?.Pages;
        Assert.NotNull(pages);

        var monitor = pages!["monitor"];
        var sections = monitor.Sections;
        Assert.NotNull(sections);
        Assert.DoesNotContain(sections!, section => section.Title == "Temperatures");
        Assert.DoesNotContain(sections!, section => section.Title == "Charging" && section.Entities is ["charge_status", "charge_status_time_elapsed"]);
        Assert.DoesNotContain(sections!, section => section.Title == "Heating & Sleep");
        Assert.DoesNotContain(sections!, section => section.Title == "Outputs & Limits");

        var configurationSection = Assert.Single(sections!, section => section.Title == "Configuration");
        Assert.Equal("category", configurationSection.GroupBy);
        Assert.NotNull(configurationSection.Filter?.Categories);
        Assert.Equal(
            ["Cell Protection", "Current Protection", "Thermal Protection", "Balance Settings", "SOC Settings", "System", "Charging", "Discharging", "F2 Charger"],
            configurationSection.Filter!.Categories);

        var statusGlyphs = monitor.Card?.StatusGlyphs;
        Assert.NotNull(statusGlyphs);

        var stateGlyph = Assert.Single(statusGlyphs!, glyph => glyph.Type == "state");
        var glyphStates = stateGlyph.States;
        Assert.NotNull(glyphStates);

        var glyphEntities = glyphStates!.Select(state => state.Entity).ToArray();
        Assert.Equal(["charging_enabled", "discharging_enabled"], glyphEntities);
    }

    private sealed class HttpClientFactoryStub : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new();
    }
}
