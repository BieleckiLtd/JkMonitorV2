using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Models;

public sealed record DevicePollResult(
    DeviceTelemetrySnapshot Snapshot,
    IReadOnlyDictionary<string, string> RawRegisters,
    string RawFrameHex);

public sealed record WriteRegisterResult(
    bool Success,
    uint WrittenValue,
    uint? ReadBackValue,
    string? Error);
