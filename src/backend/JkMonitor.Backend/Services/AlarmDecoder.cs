using JkMonitor.Contracts.DeviceDefinition;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Decodes alarm bitmask values using definitions from the device definition JSON.
/// </summary>
internal static class AlarmDecoder
{
    public static string[] Decode(int flagValue, AlarmDefinition? alarmDefinition)
    {
        if (alarmDefinition is null || flagValue == 0)
            return [];

        var warnings = new List<string>();
        foreach (var bit in alarmDefinition.Bits)
        {
            if ((flagValue & (1 << bit.Bit)) != 0)
                warnings.Add(bit.Name);
        }
        return warnings.ToArray();
    }
}
