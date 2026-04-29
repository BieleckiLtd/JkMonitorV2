using System.Buffers.Binary;
using System.Text;
using FluxMonitor.Backend.Models;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Builds telemetry snapshots from definition-driven raw bank data.
/// Supports both big-endian transports (Modbus) and little-endian transports (BLE).
/// </summary>
public sealed class DefinitionDrivenTelemetryBuilder(ExpressionEvaluator expressionEvaluator)
{
    public DevicePollResult BuildPollResult(
        DeviceDefinition definition,
        IReadOnlyDictionary<string, byte[]> bankData,
        DateTimeOffset collectedAt,
        string rawFrameHex = "")
    {
        var isLittleEndian = string.Equals(
            definition.Connection.Protocol.Settings?.ByteOrder,
            "little-endian",
            StringComparison.OrdinalIgnoreCase);

        var entityValues = new Dictionary<string, decimal?>(StringComparer.OrdinalIgnoreCase);
        var entityStringValues = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var parameters = new List<DeviceParameter>();
        var cellVoltages = new List<CellVoltageSnapshot>();
        var rawRegisters = bankData.ToDictionary(
            kvp => kvp.Key,
            kvp => Convert.ToHexString(kvp.Value),
            StringComparer.OrdinalIgnoreCase);
        var sortOrder = 0;

        foreach (var entity in definition.Entities)
        {
            if (!bankData.TryGetValue(entity.Source.Bank, out var data))
                continue;

            if (entity.Type == "cell_array")
            {
                ParseCellArray(entity, data, isLittleEndian, cellVoltages, entityValues);
                continue;
            }

            if (entity.Type == "text")
            {
                var textValue = ParseAsciiEntity(entity, data);
                entityStringValues[entity.Id] = textValue;
                if (!entity.Hidden && textValue is not null)
                {
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        StringValue = textValue,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        DisplayFormatter = entity.Display?.Formatter
                    });
                }

                continue;
            }

            if (entity.Type == "binary_sensor")
            {
                var boolValue = ParseBinarySensorEntity(entity, data, isLittleEndian);
                if (boolValue.HasValue)
                    entityValues[entity.Id] = boolValue.Value ? 1m : 0m;

                if (!entity.Hidden)
                {
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        BooleanValue = boolValue,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        DisplayFormatter = entity.Display?.Formatter
                    });
                }

                continue;
            }

            // select: enum with labeled options
            if (entity.Type == "select" && entity.Options is { Count: > 0 })
            {
                var rawUint = ReadRawUint(entity, data, isLittleEndian);
                entityValues[entity.Id] = rawUint.HasValue ? (decimal)rawUint.Value : null;

                if (!entity.Hidden)
                {
                    var label = rawUint.HasValue
                        ? entity.Options.FirstOrDefault(o => o.Value == (int)rawUint.Value)?.Label
                        : null;
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        NumericValue = rawUint.HasValue ? (decimal)rawUint.Value : null,
                        StringValue = label,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        RawValue = rawUint.HasValue ? (long)rawUint.Value : null,
                        Options = entity.Options.Select(o => new SelectOptionModel(o.Value, o.Label)).ToList(),
                        DisplayFormatter = entity.Display?.Formatter
                    });
                }

                continue;
            }

            var numericValue = ParseNumericEntity(entity, data, isLittleEndian);
            entityValues[entity.Id] = numericValue;

            if (!entity.Hidden)
            {
                if (entity.Type == "switch")
                {
                    var rawUint = ReadRawUint(entity, data, isLittleEndian);
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        BooleanValue = rawUint.HasValue && rawUint.Value != 0,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        RawValue = rawUint.HasValue ? (long)rawUint.Value : null,
                        DisplayFormatter = entity.Display?.Formatter
                    });
                }
                else
                {
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        NumericValue = numericValue,
                        Unit = entity.Source.Unit,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        RawValue = ReadRawUint(entity, data, isLittleEndian) is { } rv ? (long)rv : null,
                        DisplayFormatter = entity.Display?.Formatter
                    });
                }
            }
        }

        foreach (var computed in definition.ComputedEntities)
        {
            decimal? result;
            if (computed.FallbackFor is not null &&
                entityValues.TryGetValue(computed.FallbackFor, out var existing) &&
                existing.HasValue)
            {
                // Expose the canonical computed ID even when the device provided
                // the hardware/native value under the fallback source entity.
                result = existing;
            }
            else
            {
                result = expressionEvaluator.Evaluate(computed.Expression, entityValues, cellVoltages);
            }

            entityValues[computed.Id] = result;

            if (computed.Hidden)
            {
                continue;
            }

            if (computed.Type == "binary_sensor")
            {
                parameters.Add(new DeviceParameter
                {
                    Key = computed.Id,
                    DisplayName = computed.Name,
                    BooleanValue = result.HasValue && result.Value != 0,
                    Category = computed.Category,
                    SortOrder = sortOrder++,
                    DisplayFormatter = computed.Display?.Formatter
                });
            }
            else if (result.HasValue)
            {
                parameters.Add(new DeviceParameter
                {
                    Key = computed.Id,
                    DisplayName = computed.Name,
                    NumericValue = decimal.Round(result.Value, computed.Display?.Precision ?? 2),
                    Unit = computed.Unit,
                    Category = computed.Category,
                    SortOrder = sortOrder++,
                    DisplayFormatter = computed.Display?.Formatter
                });
            }
        }

        int? alarmFlagValue = null;
        if (definition.Alarms is not null &&
            entityValues.TryGetValue(definition.Alarms.Source, out var alarmVal) &&
            alarmVal.HasValue)
        {
            alarmFlagValue = (int)alarmVal.Value;
        }

        var activeWarnings = AlarmDecoder.Decode(alarmFlagValue ?? 0, definition.Alarms);
        var orderedCells = cellVoltages.OrderBy(c => c.Index).ToArray();

        var snapshot = new DeviceTelemetrySnapshot
        {
            CollectedAt = collectedAt,
            CellCount = orderedCells.Length == 0 ? null : orderedCells.Length,
            TotalVoltageVolts = GetRoleValue(entityValues, definition, "total-voltage"),
            CurrentAmps = GetRoleValue(entityValues, definition, "current"),
            PowerWatts = GetRoleValue(entityValues, definition, "power"),
            StateOfChargePercent = GetRoleValue(entityValues, definition, "state-of-charge"),
            MinCellVoltageVolts = GetRoleValue(entityValues, definition, "min-cell-voltage"),
            MaxCellVoltageVolts = GetRoleValue(entityValues, definition, "max-cell-voltage"),
            AverageCellVoltageVolts = GetRoleValue(entityValues, definition, "average-cell-voltage"),
            DeltaCellVoltageVolts = GetRoleValue(entityValues, definition, "delta-cell-voltage"),
            MosTemperatureCelsius = GetRoleValue(entityValues, definition, "mos-temperature"),
            AmbientTemperatureCelsius = null,
            BatteryTemperatureCelsius = GetRoleValue(entityValues, definition, "battery-temperature"),
            CycleCount = GetRoleValue(entityValues, definition, "cycle-count") is { } cc ? (int)cc : null,
            WarningFlags = alarmFlagValue,
            StatusFlags = null,
            ProtocolVersion = null,
            SoftwareVersion = GetRoleStringValue(entityStringValues, definition, "software-version"),
            ManufacturerId = GetRoleStringValue(entityStringValues, definition, "manufacturer-id"),
            ChargingEnabled = GetRoleBool(entityValues, definition, "charging-enabled"),
            DischargingEnabled = GetRoleBool(entityValues, definition, "discharging-enabled"),
            BalancingEnabled = GetRoleBool(entityValues, definition, "balancing-enabled"),
            BatteryOnline = true,
            Cells = orderedCells,
            ActiveWarnings = activeWarnings,
            Parameters = parameters,
            NumericValues = new Dictionary<string, decimal?>(entityValues, StringComparer.OrdinalIgnoreCase)
        };

        return new DevicePollResult(
            snapshot,
            rawRegisters,
            rawFrameHex,
            new Dictionary<string, decimal?>(entityValues, StringComparer.OrdinalIgnoreCase));
    }

    private static void ParseCellArray(
        EntityDefinition entity,
        byte[] data,
        bool isLittleEndian,
        List<CellVoltageSnapshot> cells,
        IDictionary<string, decimal?> entityValues)
    {
        var source = entity.Source;
        var elementSize = source.ElementByteSize > 0 ? source.ElementByteSize : 2;
        var maxElements = source.MaxElements > 0 ? source.MaxElements : 32;
        var scale = source.Scale != 0 ? (decimal)source.Scale : 1m;

        for (var i = 0; i < maxElements; i++)
        {
            var offset = source.ByteOffset + i * elementSize;
            if (offset + elementSize > data.Length)
                break;

            var rawValue = elementSize switch
            {
                2 => ReadUInt16(data.AsSpan(offset, 2), isLittleEndian),
                4 => ReadUInt32(data.AsSpan(offset, 4), isLittleEndian),
                _ => ReadUInt16(data.AsSpan(offset, 2), isLittleEndian)
            };

            if (source.SkipZero && rawValue == 0)
                continue;

            cells.Add(new CellVoltageSnapshot
            {
                Index = i + 1,
                VoltageVolts = decimal.Round(rawValue * scale, 3)
            });
        }

        entityValues[entity.Id] = cells.Count > 0 ? 1m : null;
    }

    private static decimal? ParseNumericEntity(EntityDefinition entity, byte[] data, bool isLittleEndian)
    {
        var source = entity.Source;
        if (source.ByteOffset >= data.Length)
            return null;

        var scale = (decimal)source.Scale;
        var precision = entity.Display?.Precision ?? 3;

        return source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => decimal.Round(data[source.ByteOffset] * scale, precision),
            "int16" when source.ByteOffset + 2 <= data.Length
                => decimal.Round(ReadInt16(data.AsSpan(source.ByteOffset, 2), isLittleEndian) * scale, precision),
            "uint16" when source.ByteOffset + 2 <= data.Length
                => decimal.Round(ReadUInt16(data.AsSpan(source.ByteOffset, 2), isLittleEndian) * scale, precision),
            "int32" when source.ByteOffset + 4 <= data.Length
                => decimal.Round(ReadInt32(data.AsSpan(source.ByteOffset, 4), isLittleEndian) * scale, precision),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => decimal.Round(ReadUInt32(data.AsSpan(source.ByteOffset, 4), isLittleEndian) * scale, precision),
            _ => null
        };
    }

    private static uint? ReadRawUint(EntityDefinition entity, byte[] data, bool isLittleEndian)
    {
        var source = entity.Source;
        return source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => data[source.ByteOffset],
            "uint16" when source.ByteOffset + 2 <= data.Length
                => ReadUInt16(data.AsSpan(source.ByteOffset, 2), isLittleEndian),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => ReadUInt32(data.AsSpan(source.ByteOffset, 4), isLittleEndian),
            "int16" when source.ByteOffset + 2 <= data.Length
                => unchecked((uint)ReadInt16(data.AsSpan(source.ByteOffset, 2), isLittleEndian)),
            "int32" when source.ByteOffset + 4 <= data.Length
                => unchecked((uint)ReadInt32(data.AsSpan(source.ByteOffset, 4), isLittleEndian)),
            _ => null
        };
    }

    private static bool? ParseBinarySensorEntity(EntityDefinition entity, byte[] data, bool isLittleEndian)
    {
        var source = entity.Source;
        uint? rawValue = source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => data[source.ByteOffset],
            "uint16" when source.ByteOffset + 2 <= data.Length
                => ReadUInt16(data.AsSpan(source.ByteOffset, 2), isLittleEndian),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => ReadUInt32(data.AsSpan(source.ByteOffset, 4), isLittleEndian),
            _ => null
        };

        if (rawValue is null) return null;
        var effective = source.BitMask != 0 ? rawValue.Value & source.BitMask : rawValue.Value;
        return effective == (uint)source.TrueValue;
    }

    private static string? ParseAsciiEntity(EntityDefinition entity, byte[] data)
    {
        var source = entity.Source;
        var length = source.Length > 0 ? source.Length : 16;
        if (source.ByteOffset + length > data.Length)
            return null;

        var sb = new StringBuilder(length);
        for (var i = source.ByteOffset; i < source.ByteOffset + length; i++)
        {
            var b = data[i];
            if (b >= 0x20 && b < 0x7F)
                sb.Append((char)b);
        }

        var result = sb.ToString().Trim();
        return result.Length > 0 ? result : null;
    }

    private static decimal? GetRoleValue(IReadOnlyDictionary<string, decimal?> values, DeviceDefinition definition, string role)
    {
        var entity = definition.Entities.FirstOrDefault(e => string.Equals(e.Role, role, StringComparison.OrdinalIgnoreCase));
        if (entity is not null && values.TryGetValue(entity.Id, out var value))
            return value;

        var computed = definition.ComputedEntities.FirstOrDefault(e => string.Equals(e.Role, role, StringComparison.OrdinalIgnoreCase));
        if (computed is not null && values.TryGetValue(computed.Id, out var computedValue))
            return computedValue;

        return null;
    }

    private static bool? GetRoleBool(IReadOnlyDictionary<string, decimal?> values, DeviceDefinition definition, string role)
    {
        var value = GetRoleValue(values, definition, role);
        return value.HasValue ? value.Value != 0 : null;
    }

    private static string? GetRoleStringValue(
        IReadOnlyDictionary<string, string?> values,
        DeviceDefinition definition,
        string role)
    {
        var entity = definition.Entities.FirstOrDefault(e => string.Equals(e.Role, role, StringComparison.OrdinalIgnoreCase));
        return entity is not null && values.TryGetValue(entity.Id, out var value)
            ? value
            : null;
    }

    private static ushort ReadUInt16(ReadOnlySpan<byte> data, bool isLittleEndian)
        => isLittleEndian
            ? BinaryPrimitives.ReadUInt16LittleEndian(data)
            : BinaryPrimitives.ReadUInt16BigEndian(data);

    private static short ReadInt16(ReadOnlySpan<byte> data, bool isLittleEndian)
        => isLittleEndian
            ? BinaryPrimitives.ReadInt16LittleEndian(data)
            : BinaryPrimitives.ReadInt16BigEndian(data);

    private static uint ReadUInt32(ReadOnlySpan<byte> data, bool isLittleEndian)
        => isLittleEndian
            ? BinaryPrimitives.ReadUInt32LittleEndian(data)
            : BinaryPrimitives.ReadUInt32BigEndian(data);

    private static int ReadInt32(ReadOnlySpan<byte> data, bool isLittleEndian)
        => isLittleEndian
            ? BinaryPrimitives.ReadInt32LittleEndian(data)
            : BinaryPrimitives.ReadInt32BigEndian(data);
}
