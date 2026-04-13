using FluxMonitor.Backend.Services;
using Xunit;

namespace FluxMonitor.Backend.Tests;

public sealed class BluetoothFailureHintsTests
{
    [Fact]
    public void Describe_UsesNotReadyHint_ForBlueZNotReadyErrors()
    {
        var message = BluetoothFailureHints.Describe("org.bluez.Error.NotReady: Resource Not Ready", "org.bluez.Error.NotReady");

        Assert.Equal(
            "Bluetooth is not ready. Turn Bluetooth on in System settings, wait a moment, then try again.",
            message);
    }

    [Fact]
    public void Describe_UsesUnavailableHint_ForExplicitPowerOffErrors()
    {
        var message = BluetoothFailureHints.Describe("org.bluez.Error.Failed: Bluetooth adapter is powered off");

        Assert.Equal(
            "Bluetooth is unavailable. It may be turned off or blocked by rfkill. Open System > Bluetooth, turn it on, then try again.",
            message);
    }

    [Fact]
    public void Describe_UsesInterruptedHint_ForLocalAbortErrors()
    {
        var message = BluetoothFailureHints.Describe("org.bluez.Error.Failed: le-connection-abort-by-local");

        Assert.Equal(
            "Bluetooth connection was interrupted. Check that Bluetooth is on, the device is awake, and within range, then try again.",
            message);
    }

    [Fact]
    public void Describe_UsesGenericHint_ForOpaqueBlueZFailures()
    {
        var message = BluetoothFailureHints.Describe("org.bluez.Error.Failed: Failed", "org.bluez.Error.Failed");

        Assert.Equal(
            "Bluetooth operation failed. Check System > Bluetooth and the device connection, then try again.",
            message);
    }
}
