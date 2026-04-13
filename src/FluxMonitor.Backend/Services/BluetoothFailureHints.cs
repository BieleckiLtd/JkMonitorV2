using Tmds.DBus;

namespace FluxMonitor.Backend.Services;

internal static class BluetoothFailureHints
{
    private const string BluetoothUnavailableHint =
        "Bluetooth is unavailable. It may be turned off or blocked by rfkill. Open System > Bluetooth, turn it on, then try again.";

    private const string BluetoothOperationFailedHint =
        "Bluetooth operation failed. Check System > Bluetooth and the device connection, then try again.";

    private const string BluetoothConnectionInterruptedHint =
        "Bluetooth connection was interrupted. Check that Bluetooth is on, the device is awake, and within range, then try again.";

    private const string BluetoothNotReadyHint =
        "Bluetooth is not ready. Turn Bluetooth on in System settings, wait a moment, then try again.";

    internal static string Describe(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);

        return exception is DBusException dbusException
            ? Describe(dbusException.ErrorMessage, dbusException.ErrorName)
            : Describe(exception.Message);
    }

    internal static string Describe(string? message, string? errorName = null)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return "Bluetooth operation failed.";
        }

        var trimmedMessage = message.Trim();
        var normalizedMessage = StripBlueZErrorPrefix(trimmedMessage);

        if (string.Equals(errorName, "org.bluez.Error.NotReady", StringComparison.OrdinalIgnoreCase) ||
            normalizedMessage.Contains("not ready", StringComparison.OrdinalIgnoreCase))
        {
            return BluetoothNotReadyHint;
        }

        if (LooksLikeBluetoothUnavailable(trimmedMessage, errorName, normalizedMessage))
        {
            return BluetoothUnavailableHint;
        }

        if (normalizedMessage.Contains("le-connection-abort-by-local", StringComparison.OrdinalIgnoreCase) ||
            normalizedMessage.Contains("software caused connection abort", StringComparison.OrdinalIgnoreCase))
        {
            return BluetoothConnectionInterruptedHint;
        }

        if (LooksLikeOpaqueBlueZFailure(trimmedMessage, errorName, normalizedMessage))
        {
            return BluetoothOperationFailedHint;
        }

        return trimmedMessage.StartsWith("org.bluez.Error.", StringComparison.OrdinalIgnoreCase)
            ? $"Bluetooth error: {normalizedMessage}"
            : trimmedMessage;
    }

    private static bool LooksLikeBluetoothUnavailable(string rawMessage, string? errorName, string normalizedMessage)
    {
        return normalizedMessage.Contains("powered off", StringComparison.OrdinalIgnoreCase)
               || normalizedMessage.Contains("power off", StringComparison.OrdinalIgnoreCase)
               || normalizedMessage.Contains("operation currently not available", StringComparison.OrdinalIgnoreCase)
               || normalizedMessage.Contains("resource temporarily unavailable", StringComparison.OrdinalIgnoreCase);
    }

    private static bool LooksLikeOpaqueBlueZFailure(string rawMessage, string? errorName, string normalizedMessage)
    {
        if (string.Equals(errorName, "org.bluez.Error.Failed", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(normalizedMessage, "Failed", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (rawMessage.StartsWith("org.bluez.Error.Failed", StringComparison.OrdinalIgnoreCase) &&
            string.Equals(normalizedMessage, "Failed", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return false;
    }

    private static string StripBlueZErrorPrefix(string message)
    {
        if (!message.StartsWith("org.bluez.Error.", StringComparison.OrdinalIgnoreCase))
        {
            return message;
        }

        var separatorIndex = message.IndexOf(':');
        return separatorIndex >= 0
            ? message[(separatorIndex + 1)..].Trim()
            : message;
    }
}
