using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Models;

public sealed record DevicePollResult(
    DeviceTelemetrySnapshot Snapshot,
    IReadOnlyDictionary<string, string> RawRegisters,
    string RawFrameHex,
    IReadOnlyDictionary<string, decimal?>? NumericValues = null);

public sealed record WriteRegisterResult(
    bool Success,
    uint WrittenValue,
    uint? ReadBackValue,
    string? Error);

public sealed record EntityWriteRequest(
    string EntityId,
    uint RawValue);

public sealed record EntityWriteResult(
    string EntityId,
    bool Success,
    uint WrittenValue,
    uint? ReadBackValue,
    string? Error);
