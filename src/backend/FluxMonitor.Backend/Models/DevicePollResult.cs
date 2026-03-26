using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Models;

public sealed record DevicePollResult(
    DeviceTelemetrySnapshot Snapshot,
    IReadOnlyDictionary<string, string> RawRegisters,
    string RawFrameHex);

public sealed record WriteRegisterResult(
    bool Success,
    uint WrittenValue,
    uint? ReadBackValue,
    string? Error);
