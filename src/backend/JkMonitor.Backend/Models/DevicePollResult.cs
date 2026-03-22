using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Models;

public sealed record DevicePollResult(
    DeviceTelemetrySnapshot Snapshot,
    IReadOnlyDictionary<string, string> RawRegisters,
    string RawFrameHex);
