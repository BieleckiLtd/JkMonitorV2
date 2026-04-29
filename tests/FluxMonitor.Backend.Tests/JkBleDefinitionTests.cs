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
        Assert.Contains("dry_1_trigger", entityIds);
        Assert.Contains("dry_2_trigger", entityIds);
        Assert.Contains("lcd_buzzer_trigger_value", entityIds);
        Assert.Contains("lcd_buzzer_release_value", entityIds);
        Assert.Contains("dry_1_trigger_value", entityIds);
        Assert.Contains("dry_1_release_value", entityIds);
        Assert.Contains("dry_2_trigger_value", entityIds);
        Assert.Contains("dry_2_release_value", entityIds);
        Assert.Contains("uart1_protocol", entityIds);
        Assert.Contains("can_protocol", entityIds);
        Assert.Contains("uart2_protocol", entityIds);
        Assert.Contains("uart3_protocol", entityIds);
        Assert.Contains("cell_request_float_voltage_time", entityIds);

        Assert.Equal("Thermal Protection", Assert.Single(definition.Entities, entity => entity.Id == "mos_temperature").Category);
        Assert.Equal("Thermal Protection", Assert.Single(definition.Entities, entity => entity.Id == "battery_temp_3").Category);
        Assert.Equal("Charging", Assert.Single(definition.Entities, entity => entity.Id == "charge_status").Category);
        Assert.Equal("Charging", Assert.Single(definition.Entities, entity => entity.Id == "charge_status_time_elapsed").Category);
        Assert.Equal("Charging", Assert.Single(definition.Entities, entity => entity.Id == "cell_charge_request_voltage").Category);
        Assert.Equal("Charging", Assert.Single(definition.Entities, entity => entity.Id == "charge_switch").Category);
        Assert.Equal("System", Assert.Single(definition.Entities, entity => entity.Id == "heating_status").Category);
        Assert.Equal("System", Assert.Single(definition.Entities, entity => entity.Id == "smart_sleep_voltage").Category);
        Assert.Equal("System", Assert.Single(definition.Entities, entity => entity.Id == "pcl_module_state").Category);
        Assert.Equal("Triggers", Assert.Single(definition.Entities, entity => entity.Id == "lcd_buzzer_trigger").Category);
        Assert.Equal("Communication", Assert.Single(definition.Entities, entity => entity.Id == "uart1_protocol").Category);
        Assert.Equal("Communication", Assert.Single(definition.Entities, entity => entity.Id == "uart3_protocol").Category);

        var communicationEntities = definition.Entities
            .Where(entity => entity.Category == "Communication")
            .Select(entity => entity.Id)
            .ToArray();
        Assert.Equal(["uart1_protocol", "can_protocol", "uart2_protocol", "uart3_protocol"], communicationEntities);
        Assert.All(
            definition.Entities.Where(entity => communicationEntities.Contains(entity.Id)),
            entity => Assert.True(entity.Writable));

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
            ["Cell Protection", "Current Protection", "Thermal Protection", "Balance Settings", "SOC Settings", "System", "Charging", "Discharging", "Communication", "Triggers", "F2 Charger"],
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
