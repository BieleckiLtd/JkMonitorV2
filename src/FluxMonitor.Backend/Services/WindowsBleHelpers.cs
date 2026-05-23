#if WINDOWS
using System.Runtime.Versioning;
using Windows.Storage.Streams;

namespace FluxMonitor.Backend.Services;

[SupportedOSPlatform("windows")]
internal static class WindowsBleHelpers
{
    public static string UlongToMacAddress(ulong address) =>
        string.Format(
            "{0:X2}:{1:X2}:{2:X2}:{3:X2}:{4:X2}:{5:X2}",
            (address >> 40) & 0xFF,
            (address >> 32) & 0xFF,
            (address >> 24) & 0xFF,
            (address >> 16) & 0xFF,
            (address >> 8) & 0xFF,
            address & 0xFF);

    public static ulong MacAddressToUlong(string address)
    {
        var parts = address.Split(':');
        if (parts.Length != 6)
            throw new ArgumentException($"Invalid BLE MAC address: {address}", nameof(address));
        ulong result = 0;
        foreach (var part in parts)
            result = (result << 8) | Convert.ToByte(part, 16);
        return result;
    }

    public static bool TryParseMacAddressToUlong(string address, out ulong result)
    {
        try
        {
            result = MacAddressToUlong(address);
            return true;
        }
        catch
        {
            result = 0;
            return false;
        }
    }

    public static byte[] BufferToBytes(IBuffer buffer)
    {
        var bytes = new byte[buffer.Length];
        DataReader.FromBuffer(buffer).ReadBytes(bytes);
        return bytes;
    }
}
#endif
