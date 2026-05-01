using Linux.Bluetooth;
using Linux.Bluetooth.Extensions;
using Microsoft.Extensions.Logging;
using Tmds.DBus;

namespace FluxMonitor.Backend.Services;

internal static class BlueZOperationHelpers
{
    private static readonly SemaphoreSlim AdapterOperationLock = new(1, 1);

    internal static async Task<IDisposable> AcquireAdapterOperationLockAsync(CancellationToken cancellationToken = default)
    {
        await AdapterOperationLock.WaitAsync(cancellationToken);
        return new AdapterOperationLockReleaser();
    }

    internal static bool IsOperationInProgress(Exception exception)
    {
        if (exception is DBusException dbusException)
        {
            if (string.Equals(dbusException.ErrorName, "org.bluez.Error.InProgress", StringComparison.OrdinalIgnoreCase))
                return true;

            if (ContainsInProgressMessage(dbusException.ErrorMessage))
                return true;
        }

        return ContainsInProgressMessage(exception.Message);
    }

    internal static async Task<bool> TryStartDiscoveryAsync(
        Adapter adapter,
        ILogger logger,
        string context,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (await IsDiscoveringAsync(adapter))
            return false;

        try
        {
            await adapter.StartDiscoveryAsync();
            return true;
        }
        catch (Exception exception) when (IsOperationInProgress(exception))
        {
            logger.LogDebug(
                exception,
                "Bluetooth discovery is already active. Context={Context}.",
                context);
            return false;
        }
    }

    internal static async Task StopDiscoveryIfStartedAsync(
        Adapter adapter,
        bool startedHere,
        ILogger logger,
        string context)
    {
        if (!startedHere)
            return;

        try
        {
            await adapter.StopDiscoveryAsync();
        }
        catch (Exception exception) when (IsOperationInProgress(exception))
        {
            logger.LogDebug(
                exception,
                "Bluetooth discovery stop is already in progress. Context={Context}.",
                context);
        }
        catch (Exception exception)
        {
            logger.LogDebug(
                exception,
                "Bluetooth discovery stop failed. Context={Context}.",
                context);
        }
    }

    internal static async Task EnsureConnectedAsync(
        Device device,
        TimeSpan timeout,
        ILogger logger,
        string context,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (await IsConnectedAsync(device))
            return;

        try
        {
            await device.ConnectAsync();
        }
        catch (Exception exception) when (IsOperationInProgress(exception))
        {
            logger.LogDebug(
                exception,
                "Bluetooth connection is already in progress. Context={Context}.",
                context);
        }

        await device.WaitForPropertyValueAsync("Connected", value: true, timeout);
    }

    internal static async Task StartNotifyAsync(
        IGattCharacteristic1 characteristic,
        ILogger logger,
        string context,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        try
        {
            await characteristic.StartNotifyAsync();
        }
        catch (Exception exception) when (IsOperationInProgress(exception))
        {
            logger.LogDebug(
                exception,
                "Bluetooth notification subscription is already active or starting. Context={Context}.",
                context);
        }
    }

    private static async Task<bool> IsDiscoveringAsync(Adapter adapter)
    {
        try
        {
            return await adapter.GetAsync<bool>("Discovering");
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> IsConnectedAsync(Device device)
    {
        try
        {
            return await device.GetAsync<bool>("Connected");
        }
        catch
        {
            return false;
        }
    }

    private static bool ContainsInProgressMessage(string? message)
        => !string.IsNullOrWhiteSpace(message) &&
           (message.Contains("operation already in progress", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("operation is already in progress", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("already in progress", StringComparison.OrdinalIgnoreCase));

    private sealed class AdapterOperationLockReleaser : IDisposable
    {
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed)
                return;

            _disposed = true;
            AdapterOperationLock.Release();
        }
    }
}
