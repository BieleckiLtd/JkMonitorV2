using System.Collections.ObjectModel;
using System.Globalization;
using System.Text;
using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Protocol;

internal static class JkRs485Protocol
{
    private static readonly IReadOnlyDictionary<byte, int> RegisterLengths = new ReadOnlyDictionary<byte, int>(new Dictionary<byte, int>
    {
        [0x80] = 2,
        [0x81] = 2,
        [0x82] = 2,
        [0x83] = 2,
        [0x84] = 2,
        [0x85] = 1,
        [0x86] = 1,
        [0x87] = 2,
        [0x89] = 4,
        [0x8A] = 2,
        [0x8B] = 2,
        [0x8C] = 2,
        [0x8E] = 2,
        [0x8F] = 2,
        [0x90] = 2,
        [0x91] = 2,
        [0x92] = 2,
        [0x93] = 2,
        [0x94] = 2,
        [0x95] = 2,
        [0x96] = 2,
        [0x97] = 2,
        [0x98] = 2,
        [0x99] = 2,
        [0x9A] = 2,
        [0x9B] = 2,
        [0x9C] = 2,
        [0x9D] = 1,
        [0x9E] = 2,
        [0x9F] = 2,
        [0xA0] = 2,
        [0xA1] = 2,
        [0xA2] = 2,
        [0xA3] = 2,
        [0xA4] = 2,
        [0xA5] = 2,
        [0xA6] = 2,
        [0xA7] = 2,
        [0xA8] = 2,
        [0xA9] = 1,
        [0xAA] = 4,
        [0xAB] = 1,
        [0xAC] = 1,
        [0xAD] = 2,
        [0xAE] = 1,
        [0xAF] = 1,
        [0xB0] = 2,
        [0xB1] = 1,
        [0xB2] = 10,
        [0xB3] = 1,
        [0xB4] = 8,
        [0xB5] = 4,
        [0xB6] = 4,
        [0xB7] = 15,
        [0xB8] = 1,
        [0xB9] = 4,
        [0xBA] = 24,
        [0xBB] = 1,
        [0xBC] = 1,
        [0xBD] = 1,
        [0xBE] = 2,
        [0xBF] = 2,
        [0xC0] = 1
    });

    private static readonly string[] WarningNames =
    [
        "Low capacity",
        "Power tube overtemperature",
        "Charging overvoltage",
        "Discharging undervoltage",
        "Battery over temperature",
        "Charging overcurrent",
        "Discharging overcurrent",
        "Cell pressure difference",
        "Battery box overtemperature",
        "Battery low temperature",
        "Cell overvoltage",
        "Cell undervoltage",
        "309_A protection",
        "309_A protection"
    ];

    public static byte[] BuildReadAllRequest(byte address)
    {
        var frame = new byte[21];
        frame[0] = 0x4E;
        frame[1] = 0x57;
        frame[2] = 0x00;
        frame[3] = 0x13;
        frame[8] = 0x06;
        frame[9] = 0x02;
        frame[10] = 0x00;
        frame[11] = address;
        frame[16] = 0x68;

        var checksum = ComputeChecksum(frame.AsSpan(0, 17));
        frame[19] = (byte)(checksum >> 8);
        frame[20] = (byte)checksum;
        return frame;
    }

    public static DevicePollResult ParseReadAllResponse(byte[] frame, DateTimeOffset collectedAt, IReadOnlyList<RegisterDefinition>? registerDefs = null)
    {
        if (frame.Length < 17)
        {
            throw new InvalidDataException("JK response frame is too short.");
        }

        if (frame[0] != 0x4E || frame[1] != 0x57)
        {
            throw new InvalidDataException("JK response frame has an invalid header.");
        }

        var declaredLength = ReadUInt16(frame.AsSpan(2, 2));
        if (declaredLength + 2 != frame.Length)
        {
            throw new InvalidDataException($"JK response frame length mismatch. Declared {declaredLength}, actual {frame.Length}.");
        }

        var checksum = ReadUInt16(frame.AsSpan(declaredLength, 2));
        var computedChecksum = ComputeChecksum(frame.AsSpan(0, declaredLength));
        if (checksum != computedChecksum)
        {
            throw new InvalidDataException($"JK response checksum mismatch. Expected 0x{checksum:X4}, computed 0x{computedChecksum:X4}.");
        }

        if (frame[8] != 0x06)
        {
            throw new InvalidDataException($"Unexpected JK function code 0x{frame[8]:X2}.");
        }

        if (frame[declaredLength - 3] != 0x68)
        {
            throw new InvalidDataException("JK response frame is missing the 0x68 trailer marker.");
        }

        var payload = frame.AsSpan(11, declaredLength - 14);
        return ParsePayload(payload, collectedAt, Convert.ToHexString(frame), registerDefs);
    }

    public static int GetExpectedFrameLength(ReadOnlySpan<byte> header)
    {
        if (header.Length < 4)
        {
            throw new InvalidOperationException("At least four bytes are required to read the JK frame length.");
        }

        return ReadUInt16(header.Slice(2, 2)) + 2;
    }

    private static DevicePollResult ParsePayload(ReadOnlySpan<byte> payload, DateTimeOffset collectedAt, string rawFrameHex, IReadOnlyList<RegisterDefinition>? registerDefs)
    {
        var rawRegisters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var cells = new List<CellVoltageSnapshot>();
        var activeWarnings = new List<string>();

        ushort? currentRaw = null;
        int? protocolVersion = null;
        int? cycleCount = null;
        int? warningFlags = null;
        int? statusFlags = null;
        decimal? totalVoltageVolts = null;
        decimal? currentAmps = null;
        decimal? stateOfChargePercent = null;
        decimal? mosTemperatureCelsius = null;
        decimal? ambientTemperatureCelsius = null;
        decimal? batteryTemperatureCelsius = null;
        string? softwareVersion = null;
        string? manufacturerId = null;

        var offset = 0;
        while (offset < payload.Length)
        {
            var register = payload[offset];
            if (register == 0x79)
            {
                if (offset + 1 >= payload.Length)
                {
                    throw new InvalidDataException("Cell voltage block is truncated.");
                }

                var byteCount = payload[offset + 1];
                if (offset + 2 + byteCount > payload.Length)
                {
                    throw new InvalidDataException("Cell voltage block exceeds payload length.");
                }

                var cellBytes = payload.Slice(offset + 2, byteCount);
                if (cellBytes.Length % 3 != 0)
                {
                    throw new InvalidDataException("Cell voltage block is not aligned to 3-byte entries.");
                }

                rawRegisters["79"] = Convert.ToHexString(cellBytes);

                for (var index = 0; index < cellBytes.Length; index += 3)
                {
                    var cellIndex = cellBytes[index];
                    var millivolts = ReadUInt16(cellBytes.Slice(index + 1, 2));
                    cells.Add(new CellVoltageSnapshot
                    {
                        Index = cellIndex,
                        VoltageVolts = decimal.Round(millivolts / 1000m, 3)
                    });
                }

                offset += 2 + byteCount;
                continue;
            }

            if (!RegisterLengths.TryGetValue(register, out var byteLength))
            {
                throw new InvalidDataException($"Unsupported JK register 0x{register:X2} encountered while parsing payload.");
            }

            if (offset + 1 + byteLength > payload.Length)
            {
                throw new InvalidDataException($"JK register 0x{register:X2} exceeds the payload length.");
            }

            var valueBytes = payload.Slice(offset + 1, byteLength);
            rawRegisters[register.ToString("X2", CultureInfo.InvariantCulture)] = Convert.ToHexString(valueBytes);

            switch (register)
            {
                case 0x80:
                    mosTemperatureCelsius = GetTemperature(ReadUInt16(valueBytes));
                    break;
                case 0x81:
                    ambientTemperatureCelsius = GetTemperature(ReadUInt16(valueBytes));
                    break;
                case 0x82:
                    batteryTemperatureCelsius = GetTemperature(ReadUInt16(valueBytes));
                    break;
                case 0x83:
                    totalVoltageVolts = decimal.Round(ReadUInt16(valueBytes) / 100m, 2);
                    break;
                case 0x84:
                    currentRaw = ReadUInt16(valueBytes);
                    break;
                case 0x85:
                    stateOfChargePercent = valueBytes[0];
                    break;
                case 0x87:
                    cycleCount = ReadUInt16(valueBytes);
                    break;
                case 0x8B:
                    warningFlags = ReadUInt16(valueBytes);
                    activeWarnings.AddRange(GetWarningNames(warningFlags.Value));
                    break;
                case 0x8C:
                    statusFlags = ReadUInt16(valueBytes);
                    break;
                case 0xB7:
                    softwareVersion = ReadAscii(valueBytes);
                    break;
                case 0xBA:
                    manufacturerId = ReadAscii(valueBytes);
                    break;
                case 0xC0:
                    protocolVersion = valueBytes[0];
                    break;
            }

            offset += 1 + byteLength;
        }

        if (currentRaw.HasValue)
        {
            currentAmps = DecodeCurrent(currentRaw.Value, protocolVersion);
        }

        var orderedCells = cells.OrderBy(cell => cell.Index).ToArray();
        decimal? minCellVoltage = orderedCells.Length == 0 ? null : orderedCells.Min(cell => cell.VoltageVolts);
        decimal? maxCellVoltage = orderedCells.Length == 0 ? null : orderedCells.Max(cell => cell.VoltageVolts);
        decimal? averageCellVoltage = orderedCells.Length == 0 ? null : decimal.Round(orderedCells.Average(cell => cell.VoltageVolts), 3);
        decimal? deltaCellVoltage = orderedCells.Length == 0 || minCellVoltage is null || maxCellVoltage is null
            ? null
            : decimal.Round(maxCellVoltage.Value - minCellVoltage.Value, 3);
        decimal? powerWatts = totalVoltageVolts.HasValue && currentAmps.HasValue
            ? decimal.Round(totalVoltageVolts.Value * currentAmps.Value, 2)
            : null;

        var snapshot = new DeviceTelemetrySnapshot
        {
            CollectedAt = collectedAt,
            CellCount = orderedCells.Length == 0 ? null : orderedCells.Length,
            TotalVoltageVolts = totalVoltageVolts,
            CurrentAmps = currentAmps,
            PowerWatts = powerWatts,
            StateOfChargePercent = stateOfChargePercent,
            MinCellVoltageVolts = minCellVoltage,
            MaxCellVoltageVolts = maxCellVoltage,
            AverageCellVoltageVolts = averageCellVoltage,
            DeltaCellVoltageVolts = deltaCellVoltage,
            MosTemperatureCelsius = mosTemperatureCelsius,
            AmbientTemperatureCelsius = ambientTemperatureCelsius,
            BatteryTemperatureCelsius = batteryTemperatureCelsius,
            CycleCount = cycleCount,
            WarningFlags = warningFlags,
            StatusFlags = statusFlags,
            ProtocolVersion = protocolVersion,
            SoftwareVersion = softwareVersion,
            ManufacturerId = manufacturerId,
            ChargingEnabled = statusFlags.HasValue ? (statusFlags.Value & 0b0001) != 0 : null,
            DischargingEnabled = statusFlags.HasValue ? (statusFlags.Value & 0b0010) != 0 : null,
            BalancingEnabled = statusFlags.HasValue ? (statusFlags.Value & 0b0100) != 0 : null,
            BatteryOnline = statusFlags.HasValue ? (statusFlags.Value & 0b1000) != 0 : null,
            Cells = orderedCells,
            ActiveWarnings = activeWarnings.ToArray(),
            Parameters = BuildParameters(
                collectedAt, orderedCells, rawRegisters, registerDefs,
                totalVoltageVolts, currentAmps, powerWatts, stateOfChargePercent,
                minCellVoltage, maxCellVoltage, averageCellVoltage, deltaCellVoltage,
                mosTemperatureCelsius, ambientTemperatureCelsius, batteryTemperatureCelsius,
                cycleCount, warningFlags, statusFlags, protocolVersion,
                softwareVersion, manufacturerId, activeWarnings,
                statusFlags.HasValue ? (statusFlags.Value & 0b0001) != 0 : (bool?)null,
                statusFlags.HasValue ? (statusFlags.Value & 0b0010) != 0 : (bool?)null,
                statusFlags.HasValue ? (statusFlags.Value & 0b0100) != 0 : (bool?)null,
                statusFlags.HasValue ? (statusFlags.Value & 0b1000) != 0 : (bool?)null)
        };

        return new DevicePollResult(snapshot, rawRegisters, rawFrameHex);
    }

    private static ushort ComputeChecksum(ReadOnlySpan<byte> bytes)
    {
        ushort checksum = 0;
        foreach (var value in bytes)
        {
            checksum += value;
        }

        return checksum;
    }

    private static ushort ReadUInt16(ReadOnlySpan<byte> bytes)
    {
        return (ushort)((bytes[0] << 8) | bytes[1]);
    }

    private static decimal GetTemperature(ushort rawTemperature)
    {
        return rawTemperature <= 100
            ? rawTemperature
            : 100 - rawTemperature;
    }

    private static decimal DecodeCurrent(ushort rawCurrent, int? protocolVersion)
    {
        if (protocolVersion == 1)
        {
            var magnitude = rawCurrent & 0x7FFF;
            var sign = (rawCurrent & 0x8000) != 0 ? 1m : -1m;
            return decimal.Round(magnitude * 0.01m * sign, 2);
        }

        return decimal.Round((10000 - rawCurrent) * 0.01m, 2);
    }

    private static IEnumerable<string> GetWarningNames(int flags)
    {
        for (var index = 0; index < WarningNames.Length; index++)
        {
            if ((flags & (1 << index)) != 0)
            {
                yield return WarningNames[index];
            }
        }
    }

    private static string? ReadAscii(ReadOnlySpan<byte> bytes)
    {
        var value = Encoding.ASCII.GetString(bytes).Trim('\0', ' ');
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static IReadOnlyList<DeviceParameter> BuildParameters(
        DateTimeOffset collectedAt,
        CellVoltageSnapshot[] cells,
        Dictionary<string, string> rawRegisters,
        IReadOnlyList<RegisterDefinition>? registerDefs,
        decimal? totalVoltageVolts,
        decimal? currentAmps,
        decimal? powerWatts,
        decimal? stateOfChargePercent,
        decimal? minCellVoltage,
        decimal? maxCellVoltage,
        decimal? averageCellVoltage,
        decimal? deltaCellVoltage,
        decimal? mosTemperatureCelsius,
        decimal? ambientTemperatureCelsius,
        decimal? batteryTemperatureCelsius,
        int? cycleCount,
        int? warningFlags,
        int? statusFlags,
        int? protocolVersion,
        string? softwareVersion,
        string? manufacturerId,
        List<string> activeWarnings,
        bool? chargingEnabled,
        bool? dischargingEnabled,
        bool? balancingEnabled,
        bool? batteryOnline)
    {
        var regLookup = (registerDefs ?? [])
            .Where(r => r.Enabled)
            .ToDictionary(r => r.Key, StringComparer.OrdinalIgnoreCase);

        var parameters = new List<DeviceParameter>(64);

        void AddNumeric(string key, string defaultName, string category, string? unit, decimal? value, int defaultSort)
        {
            if (!value.HasValue) return;
            regLookup.TryGetValue(key, out var def);
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = def?.DisplayName ?? defaultName,
                Category = def?.Category ?? category,
                Unit = def?.Unit ?? unit,
                NumericValue = value.Value,
                SortOrder = def?.SortOrder ?? defaultSort
            });
        }

        void AddString(string key, string defaultName, string category, string? value, int defaultSort)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            regLookup.TryGetValue(key, out var def);
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = def?.DisplayName ?? defaultName,
                Category = def?.Category ?? category,
                StringValue = value,
                SortOrder = def?.SortOrder ?? defaultSort
            });
        }

        void AddBool(string key, string defaultName, string category, bool? value, int defaultSort)
        {
            if (!value.HasValue) return;
            regLookup.TryGetValue(key, out var def);
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = def?.DisplayName ?? defaultName,
                Category = def?.Category ?? category,
                BooleanValue = value.Value,
                SortOrder = def?.SortOrder ?? defaultSort
            });
        }

        // Pack status
        AddNumeric("totalVoltage", "Total Voltage", "Pack Status", "V", totalVoltageVolts, 1);
        AddNumeric("current", "Current", "Pack Status", "A", currentAmps, 2);
        AddNumeric("power", "Power", "Pack Status", "W", powerWatts, 3);
        AddNumeric("stateOfCharge", "State of Charge", "Pack Status", "%", stateOfChargePercent, 4);
        AddNumeric("cycleCount", "Cycle Count", "Pack Status", null, cycleCount, 10);

        // Cell summary
        AddNumeric("cellCount", "Cell Count", "Cell Summary", null, cells.Length > 0 ? cells.Length : null, 90);
        AddNumeric("minCellVoltage", "Min Cell Voltage", "Cell Summary", "V", minCellVoltage, 91);
        AddNumeric("maxCellVoltage", "Max Cell Voltage", "Cell Summary", "V", maxCellVoltage, 92);
        AddNumeric("avgCellVoltage", "Average Cell Voltage", "Cell Summary", "V", averageCellVoltage, 93);
        AddNumeric("deltaCellVoltage", "Delta Cell Voltage", "Cell Summary", "V", deltaCellVoltage, 94);

        // Individual cells
        foreach (var cell in cells)
        {
            var cellKey = $"cellVoltage{cell.Index}";
            regLookup.TryGetValue(cellKey, out var cellDef);
            parameters.Add(new DeviceParameter
            {
                Key = cellKey,
                DisplayName = cellDef?.DisplayName ?? $"Cell {cell.Index}",
                Category = cellDef?.Category ?? "Cell Voltages",
                Unit = cellDef?.Unit ?? "V",
                NumericValue = cell.VoltageVolts,
                SortOrder = cellDef?.SortOrder ?? (100 + cell.Index)
            });
        }

        // Temperatures
        AddNumeric("mosTemperature", "MOS Temperature", "Temperatures", "°C", mosTemperatureCelsius, 200);
        AddNumeric("ambientTemperature", "Ambient Temperature", "Temperatures", "°C", ambientTemperatureCelsius, 201);
        AddNumeric("batteryTemperature", "Battery Temperature", "Temperatures", "°C", batteryTemperatureCelsius, 202);

        // Status flags
        AddBool("chargingEnabled", "Charging", "Status", chargingEnabled, 300);
        AddBool("dischargingEnabled", "Discharging", "Status", dischargingEnabled, 301);
        AddBool("balancingEnabled", "Balancing", "Status", balancingEnabled, 302);
        AddBool("batteryOnline", "Battery Online", "Status", batteryOnline, 303);
        AddNumeric("warningFlags", "Warning Flags", "Status", null, warningFlags, 310);
        AddNumeric("statusFlags", "Status Flags", "Status", null, statusFlags, 311);

        // Active warnings
        if (activeWarnings.Count > 0)
        {
            AddString("activeWarnings", "Active Warnings", "Status", string.Join(", ", activeWarnings), 320);
        }

        // Device info
        AddString("softwareVersion", "Software Version", "Device Info", softwareVersion, 400);
        AddString("manufacturerId", "Manufacturer ID", "Device Info", manufacturerId, 401);
        AddNumeric("protocolVersion", "Protocol Version", "Device Info", null, protocolVersion, 402);

        // Parse additional raw registers that weren't specifically handled above
        var handledKeys = new HashSet<string>(parameters.Select(p => p.Key), StringComparer.OrdinalIgnoreCase);

        foreach (var regDef in registerDefs ?? [])
        {
            if (!regDef.Enabled || handledKeys.Contains(regDef.Key))
            {
                continue;
            }

            if (rawRegisters.TryGetValue(regDef.RegisterId.Replace("0x", string.Empty, StringComparison.OrdinalIgnoreCase), out var rawHex))
            {
                var param = InterpretRawRegister(regDef, rawHex);
                if (param is not null)
                {
                    parameters.Add(param);
                }
            }
        }

        return parameters.OrderBy(p => p.SortOrder).ThenBy(p => p.Key, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static DeviceParameter? InterpretRawRegister(RegisterDefinition def, string rawHex)
    {
        if (string.IsNullOrEmpty(rawHex)) return null;

        try
        {
            var bytes = Convert.FromHexString(rawHex);
            decimal? numericValue = def.DataType.ToLowerInvariant() switch
            {
                "uint16" when bytes.Length >= 2 => ((bytes[0] << 8) | bytes[1]) * def.ScaleFactor,
                "int16" when bytes.Length >= 2 => (short)((bytes[0] << 8) | bytes[1]) * def.ScaleFactor,
                "uint32" when bytes.Length >= 4 => ((uint)((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3])) * def.ScaleFactor,
                "uint8" when bytes.Length >= 1 => bytes[0] * def.ScaleFactor,
                _ => null
            };

            string? stringValue = def.DataType.ToLowerInvariant() switch
            {
                "ascii" => Encoding.ASCII.GetString(bytes).Trim('\0', ' '),
                "hex" => rawHex,
                _ when numericValue is null => rawHex,
                _ => null
            };

            return new DeviceParameter
            {
                Key = def.Key,
                DisplayName = def.DisplayName,
                Category = def.Category,
                Unit = def.Unit,
                NumericValue = numericValue.HasValue ? decimal.Round(numericValue.Value, 4) : null,
                StringValue = string.IsNullOrWhiteSpace(stringValue) ? null : stringValue,
                SortOrder = def.SortOrder
            };
        }
        catch
        {
            return new DeviceParameter
            {
                Key = def.Key,
                DisplayName = def.DisplayName,
                Category = def.Category,
                StringValue = rawHex,
                SortOrder = def.SortOrder
            };
        }
    }
}