using System.Buffers.Binary;
using System.Globalization;
using JkMonitor.Backend.Models;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.Status;

namespace JkMonitor.Backend.Protocol;

/// <summary>
/// JK Inverter BMS RS485 Modbus RTU protocol (V1.1).
/// Register base addresses: 0x1000 (config), 0x1200 (live data), 0x1400 (device info).
/// </summary>
internal static class JkModbusProtocol
{
    private const ushort LiveDataBase = 0x1200;
    private const int MaxCells = 32;

    /// <summary>
    /// Build a Modbus RTU "Read Holding Registers" (function code 0x03) request.
    /// Reads 115 registers starting at 0x1200, which covers cell voltages
    /// through the end of the live-data region (up to offset 0x00E4).
    /// The BMS supports a maximum of ~115 registers per read.
    /// </summary>
    public static byte[] BuildReadLiveDataRequest(byte slaveAddress)
    {
        return BuildReadHoldingRegistersRequest(slaveAddress, LiveDataBase, LiveDataRegisterCount);
    }

    public const ushort LiveDataRegisterCount = 115;

    public static byte[] BuildReadHoldingRegistersRequest(byte slaveAddress, ushort startRegister, ushort registerCount)
    {
        var request = new byte[8];
        request[0] = slaveAddress;
        request[1] = 0x03; // Read Holding Registers
        request[2] = (byte)(startRegister >> 8);
        request[3] = (byte)(startRegister & 0xFF);
        request[4] = (byte)(registerCount >> 8);
        request[5] = (byte)(registerCount & 0xFF);
        var crc = ComputeCrc16(request.AsSpan(0, 6));
        request[6] = (byte)(crc & 0xFF);        // CRC low
        request[7] = (byte)((crc >> 8) & 0xFF); // CRC high
        return request;
    }

    /// <summary>
    /// Expected response length for a Modbus RTU read response.
    /// </summary>
    public static int ExpectedResponseLength(ushort registerCount)
    {
        // [addr=1][func=1][byteCount=1][data=registerCount*2][crc=2]
        return 3 + registerCount * 2 + 2;
    }

    /// <summary>
    /// Parse a Modbus RTU read response for the live data region.
    /// </summary>
    public static DevicePollResult ParseLiveDataResponse(
        byte[] frame,
        byte expectedSlaveAddress,
        DateTimeOffset collectedAt,
        IReadOnlyList<RegisterDefinition>? registerDefs = null)
    {
        ValidateModbusResponse(frame, expectedSlaveAddress, 0x03);

        var byteCount = frame[2];
        var data = frame.AsSpan(3, byteCount);

        var rawRegisters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        rawRegisters["raw_live_hex"] = Convert.ToHexString(data);

        // --- Cell voltages: offset 0x0000..0x003E (UINT16 each, mV) ---
        var cells = new List<CellVoltageSnapshot>();
        for (var i = 0; i < MaxCells; i++)
        {
            var offset = i * 2;
            if (offset + 2 > data.Length) break;
            var millivolts = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(offset, 2));
            if (millivolts == 0) continue; // unused cell slot
            cells.Add(new CellVoltageSnapshot
            {
                Index = i + 1,
                VoltageVolts = decimal.Round(millivolts / 1000m, 3)
            });
            rawRegisters[$"cell_{i:D2}_mV"] = millivolts.ToString(CultureInfo.InvariantCulture);
        }

        // --- Cell status: offset 0x0040 (UINT32 bitmask) ---
        uint cellStatus = 0;
        if (data.Length >= 0x0044)
            cellStatus = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(0x0040, 4));

        // --- Average cell voltage: offset 0x0044 (UINT16 mV) ---
        decimal? avgCellVoltage = null;
        if (data.Length >= 0x0046)
        {
            var avgMv = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(0x0044, 2));
            if (avgMv > 0) avgCellVoltage = decimal.Round(avgMv / 1000m, 3);
        }

        // --- Max cell voltage delta: offset 0x0046 (UINT16 mV) ---
        decimal? deltaCellVoltage = null;
        if (data.Length >= 0x0048)
        {
            var deltaMv = BinaryPrimitives.ReadUInt16BigEndian(data.Slice(0x0046, 2));
            deltaCellVoltage = decimal.Round(deltaMv / 1000m, 3);
        }

        // --- MOS temperature: offset 0x008A (INT16, 0.1°C) ---
        decimal? mosTemp = null;
        if (data.Length >= 0x008C)
        {
            var raw = BinaryPrimitives.ReadInt16BigEndian(data.Slice(0x008A, 2));
            mosTemp = decimal.Round(raw / 10m, 1);
        }

        // --- Total battery voltage: offset 0x0090 (UINT32 mV) ---
        decimal? totalVoltageVolts = null;
        if (data.Length >= 0x0094)
        {
            var totalMv = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(0x0090, 4));
            totalVoltageVolts = decimal.Round(totalMv / 1000m, 3);
            rawRegisters["totalVoltage_mV"] = totalMv.ToString(CultureInfo.InvariantCulture);
        }

        // --- Battery power: offset 0x0094 (UINT32 mW) ---
        decimal? powerWatts = null;
        if (data.Length >= 0x0098)
        {
            var powerMw = BinaryPrimitives.ReadUInt32BigEndian(data.Slice(0x0094, 4));
            powerWatts = decimal.Round(powerMw / 1000m, 2);
        }

        // --- Battery current: offset 0x0098 (INT32 mA) ---
        decimal? currentAmps = null;
        if (data.Length >= 0x009C)
        {
            var currentMa = BinaryPrimitives.ReadInt32BigEndian(data.Slice(0x0098, 4));
            currentAmps = decimal.Round(currentMa / 1000m, 3);
            rawRegisters["current_mA"] = currentMa.ToString(CultureInfo.InvariantCulture);
        }

        // --- Battery temperature 1: offset 0x009C (INT16, 0.1°C) ---
        decimal? batteryTemp1 = null;
        if (data.Length >= 0x009E)
        {
            var raw = BinaryPrimitives.ReadInt16BigEndian(data.Slice(0x009C, 2));
            batteryTemp1 = decimal.Round(raw / 10m, 1);
        }

        // --- Battery temperature 2: offset 0x009E (INT16, 0.1°C) ---
        decimal? batteryTemp2 = null;
        if (data.Length >= 0x00A0)
        {
            var raw = BinaryPrimitives.ReadInt16BigEndian(data.Slice(0x009E, 2));
            batteryTemp2 = decimal.Round(raw / 10m, 1);
        }

        // --- Alarm flags: offset 0x00A0 (UINT32) ---
        int? alarmFlags = null;
        if (data.Length >= 0x00A4)
        {
            alarmFlags = (int)BinaryPrimitives.ReadUInt32BigEndian(data.Slice(0x00A0, 4));
        }

        // --- Balance current: offset 0x00A4 (INT16 mA) ---
        // --- Balance state + SOC: offset 0x00A6 (UINT8 + UINT8) ---
        decimal? stateOfChargePercent = null;
        int? balanceState = null;
        if (data.Length >= 0x00A8)
        {
            balanceState = data[0x00A6];
            stateOfChargePercent = data[0x00A7];
            rawRegisters["soc_percent"] = data[0x00A7].ToString(CultureInfo.InvariantCulture);
        }

        // --- Remaining capacity: offset 0x00A8 (INT32 mAH) ---
        // --- Full charge capacity: offset 0x00AC (UINT32 mAH) ---
        // --- Cycle count: offset 0x00B0 (UINT32) ---
        int? cycleCount = null;
        if (data.Length >= 0x00B4)
        {
            cycleCount = (int)BinaryPrimitives.ReadUInt32BigEndian(data.Slice(0x00B0, 4));
        }

        // --- SOH + precharge: offset 0x00B8 ---
        // --- Charge/Discharge status: offset 0x00C0 ---
        bool? chargingEnabled = null;
        bool? dischargingEnabled = null;
        if (data.Length >= 0x00C2)
        {
            chargingEnabled = data[0x00C0] == 1;
            dischargingEnabled = data[0x00C1] == 1;
        }

        // Build derived values
        var orderedCells = cells.OrderBy(c => c.Index).ToArray();
        decimal? minCellVoltage = orderedCells.Length == 0 ? null : orderedCells.Min(c => c.VoltageVolts);
        decimal? maxCellVoltage = orderedCells.Length == 0 ? null : orderedCells.Max(c => c.VoltageVolts);
        if (avgCellVoltage is null && orderedCells.Length > 0)
        {
            avgCellVoltage = decimal.Round(orderedCells.Average(c => c.VoltageVolts), 3);
        }

        if (deltaCellVoltage is null && minCellVoltage.HasValue && maxCellVoltage.HasValue)
        {
            deltaCellVoltage = decimal.Round(maxCellVoltage.Value - minCellVoltage.Value, 3);
        }

        if (powerWatts is null && totalVoltageVolts.HasValue && currentAmps.HasValue)
        {
            powerWatts = decimal.Round(totalVoltageVolts.Value * currentAmps.Value, 2);
        }

        var activeWarnings = alarmFlags.HasValue ? DecodeAlarmFlags(alarmFlags.Value) : [];
        bool? balancingEnabled = balanceState.HasValue ? balanceState.Value != 0 : null;

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
            AverageCellVoltageVolts = avgCellVoltage,
            DeltaCellVoltageVolts = deltaCellVoltage,
            MosTemperatureCelsius = mosTemp,
            AmbientTemperatureCelsius = null,
            BatteryTemperatureCelsius = batteryTemp1,
            CycleCount = cycleCount,
            WarningFlags = alarmFlags,
            StatusFlags = null,
            ProtocolVersion = null,
            SoftwareVersion = null,
            ManufacturerId = null,
            ChargingEnabled = chargingEnabled,
            DischargingEnabled = dischargingEnabled,
            BalancingEnabled = balancingEnabled,
            BatteryOnline = true,
            Cells = orderedCells,
            ActiveWarnings = activeWarnings,
            Parameters = BuildParameters(collectedAt, orderedCells, rawRegisters, registerDefs,
                totalVoltageVolts, currentAmps, powerWatts, stateOfChargePercent,
                minCellVoltage, maxCellVoltage, avgCellVoltage, deltaCellVoltage,
                mosTemp, batteryTemp1, batteryTemp2,
                cycleCount, alarmFlags, chargingEnabled, dischargingEnabled, balancingEnabled,
                activeWarnings)
        };

        return new DevicePollResult(snapshot, rawRegisters, Convert.ToHexString(frame));
    }

    private static void ValidateModbusResponse(byte[] frame, byte expectedSlaveAddress, byte expectedFunctionCode)
    {
        if (frame.Length < 5)
            throw new InvalidDataException($"Modbus response too short ({frame.Length} bytes).");

        if (frame[0] != expectedSlaveAddress)
            throw new InvalidDataException($"Modbus response slave address mismatch. Expected 0x{expectedSlaveAddress:X2}, got 0x{frame[0]:X2}.");

        // Check for Modbus exception response
        if ((frame[1] & 0x80) != 0)
        {
            var exceptionCode = frame.Length > 2 ? frame[2] : 0;
            throw new InvalidDataException($"Modbus exception response: function 0x{frame[1]:X2}, exception code 0x{exceptionCode:X2}.");
        }

        if (frame[1] != expectedFunctionCode)
            throw new InvalidDataException($"Modbus response function code mismatch. Expected 0x{expectedFunctionCode:X2}, got 0x{frame[1]:X2}.");

        var byteCount = frame[2];
        var expectedLength = 3 + byteCount + 2; // header + data + CRC
        if (frame.Length < expectedLength)
            throw new InvalidDataException($"Modbus response length mismatch. Expected {expectedLength}, got {frame.Length}.");

        var crc = ComputeCrc16(frame.AsSpan(0, frame.Length - 2));
        var receivedCrc = (ushort)(frame[^2] | (frame[^1] << 8));
        if (crc != receivedCrc)
            throw new InvalidDataException($"Modbus CRC mismatch. Computed 0x{crc:X4}, received 0x{receivedCrc:X4}.");
    }

    public static ushort ComputeCrc16(ReadOnlySpan<byte> data)
    {
        ushort crc = 0xFFFF;
        foreach (var b in data)
        {
            crc ^= b;
            for (var i = 0; i < 8; i++)
            {
                if ((crc & 1) != 0)
                {
                    crc >>= 1;
                    crc ^= 0xA001;
                }
                else
                {
                    crc >>= 1;
                }
            }
        }
        return crc;
    }

    private static string[] DecodeAlarmFlags(int flags)
    {
        string[] alarmNames =
        [
            "Wire resistance too high",
            "MOS overtemperature",
            "Cell count mismatch",
            "Current sensor error",
            "Cell overvoltage",
            "Battery overvoltage",
            "Charge overcurrent",
            "Charge short circuit",
            "Charge overtemperature",
            "Charge undertemperature",
            "CPU-AUX communication error",
            "Cell undervoltage",
            "Battery undervoltage",
            "Discharge overcurrent",
            "Discharge short circuit",
            "Discharge overtemperature",
            "Charge MOS error",
            "Discharge MOS error",
            "GPS disconnected",
            "Modify password reminder",
            "Discharge on failed",
            "Battery over temp alarm",
            "Temperature sensor anomaly",
            "PLC module anomaly"
        ];

        var warnings = new List<string>();
        for (var i = 0; i < alarmNames.Length && i < 32; i++)
        {
            if ((flags & (1 << i)) != 0)
                warnings.Add(alarmNames[i]);
        }
        return warnings.ToArray();
    }

    private static IReadOnlyList<DeviceParameter> BuildParameters(
        DateTimeOffset collectedAt,
        IReadOnlyList<CellVoltageSnapshot> cells,
        IReadOnlyDictionary<string, string> rawRegisters,
        IReadOnlyList<RegisterDefinition>? registerDefs,
        decimal? totalVoltageVolts,
        decimal? currentAmps,
        decimal? powerWatts,
        decimal? stateOfChargePercent,
        decimal? minCellVoltage,
        decimal? maxCellVoltage,
        decimal? avgCellVoltage,
        decimal? deltaCellVoltage,
        decimal? mosTemp,
        decimal? batteryTemp1,
        decimal? batteryTemp2,
        int? cycleCount,
        int? alarmFlags,
        bool? chargingEnabled,
        bool? dischargingEnabled,
        bool? balancingEnabled,
        IReadOnlyList<string> activeWarnings)
    {
        var parameters = new List<DeviceParameter>();
        var sortOrder = 0;

        void AddNumeric(string key, string displayName, decimal? value, string? unit, string category)
        {
            if (value is null) return;
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = displayName,
                NumericValue = value,
                Unit = unit,
                Category = category,
                SortOrder = sortOrder++
            });
        }

        void AddBool(string key, string displayName, bool? value, string category)
        {
            if (value is null) return;
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = displayName,
                BooleanValue = value,
                Category = category,
                SortOrder = sortOrder++
            });
        }

        void AddString(string key, string displayName, string? value, string category)
        {
            if (value is null) return;
            parameters.Add(new DeviceParameter
            {
                Key = key,
                DisplayName = displayName,
                StringValue = value,
                Category = category,
                SortOrder = sortOrder++
            });
        }

        AddNumeric("totalVoltage", "Total Voltage", totalVoltageVolts, "V", "Pack Status");
        AddNumeric("current", "Current", currentAmps, "A", "Pack Status");
        AddNumeric("power", "Power", powerWatts, "W", "Pack Status");
        AddNumeric("stateOfCharge", "State of Charge", stateOfChargePercent, "%", "Pack Status");
        AddNumeric("cycleCount", "Cycle Count", cycleCount, null, "Pack Status");

        AddNumeric("minCellVoltage", "Min Cell Voltage", minCellVoltage, "V", "Cell Voltages");
        AddNumeric("maxCellVoltage", "Max Cell Voltage", maxCellVoltage, "V", "Cell Voltages");
        AddNumeric("avgCellVoltage", "Avg Cell Voltage", avgCellVoltage, "V", "Cell Voltages");
        AddNumeric("deltaCellVoltage", "Cell Delta", deltaCellVoltage, "V", "Cell Voltages");

        foreach (var cell in cells)
        {
            AddNumeric($"cell_{cell.Index:D2}", $"Cell {cell.Index}", cell.VoltageVolts, "V", "Cell Voltages");
        }

        AddNumeric("mosTemperature", "MOS Temperature", mosTemp, "°C", "Temperatures");
        AddNumeric("batteryTemperature1", "Battery Temp 1", batteryTemp1, "°C", "Temperatures");
        AddNumeric("batteryTemperature2", "Battery Temp 2", batteryTemp2, "°C", "Temperatures");

        AddBool("chargingEnabled", "Charging", chargingEnabled, "Status");
        AddBool("dischargingEnabled", "Discharging", dischargingEnabled, "Status");
        AddBool("balancingEnabled", "Balancing", balancingEnabled, "Status");

        if (activeWarnings.Count > 0)
        {
            AddString("activeWarnings", "Active Warnings", string.Join(", ", activeWarnings), "Status");
        }

        return parameters;
    }
}
