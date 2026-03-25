using System.Buffers.Binary;
using System.IO.Ports;
using System.Text;
using JkMonitor.Backend.Models;
using JkMonitor.Backend.Protocol;
using JkMonitor.Contracts.Configuration;
using JkMonitor.Contracts.DeviceDefinition;
using JkMonitor.Contracts.Status;
using Microsoft.Extensions.Options;

namespace JkMonitor.Backend.Services;

/// <summary>
/// Definition-driven Modbus RTU polling client. Uses device definition JSON to determine
/// which register banks to read, how to parse entity values, compute derived values,
/// and decode alarms — with no hardcoded protocol knowledge.
/// </summary>
public sealed class GenericModbusPollingClient(
    ExpressionEvaluator expressionEvaluator,
    DeviceDefinitionLoader definitionLoader,
    IOptions<MonitorConfiguration> configuration,
    ILogger<GenericModbusPollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly MonitorConfiguration _configuration = configuration.Value;
    private readonly SemaphoreSlim _busLock = new(1, 1);
    private SerialPort? _serialPort;
    private bool _disposed;

    // Slow poll group caching: bank ID → (lastRead, rawData)
    private readonly Dictionary<string, (DateTimeOffset LastRead, byte[] Data)> _bankCache = new(StringComparer.OrdinalIgnoreCase);

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(device.DefinitionId) ||
            !definitionLoader.TryGet(device.DefinitionId, out var definition) || definition is null)
        {
            throw new InvalidOperationException(
                $"Device '{device.DeviceId}' has no valid DefinitionId ('{device.DefinitionId}').");
        }

        return PollAsync(device, definition, cancellationToken);
    }

    public async Task<DevicePollResult> PollAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        CancellationToken cancellationToken)
    {
        var transport = definition.Connection.Transport;
        var protocolSettings = definition.Connection.Protocol.Settings ?? new ProtocolSettings();
        var slaveAddress = device.Address != 0 ? device.Address : protocolSettings.DefaultSlaveAddress;
        var readTimeout = transport.Defaults?.ReadTimeoutMs ?? 1000;
        var interFrameDelay = protocolSettings.InterFrameDelayMs;
        var overallTimeoutMs = readTimeout * (definition.RegisterBanks.Count + 1) * 3;

        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        pollCts.CancelAfter(overallTimeoutMs);
        var pollToken = pollCts.Token;

        await _busLock.WaitAsync(pollToken);
        try
        {
            var serialPort = EnsurePort(device, definition);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            // Read each register bank
            var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            var now = DateTimeOffset.UtcNow;

            foreach (var bank in definition.RegisterBanks)
            {
                var pollGroup = definition.PollGroups.GetValueOrDefault(bank.PollGroup);
                var intervalMs = pollGroup?.IntervalMs ?? 1000;

                // Check if this bank is cached and still fresh
                if (_bankCache.TryGetValue(bank.Id, out var cached) &&
                    now - cached.LastRead < TimeSpan.FromMilliseconds(intervalMs))
                {
                    bankData[bank.Id] = cached.Data;
                    continue;
                }

                // Add inter-frame delay between bank reads
                if (bankData.Count > 0)
                {
                    await Task.Delay(interFrameDelay, pollToken);
                    serialPort.DiscardInBuffer();
                }

                logger.LogDebug("Reading register bank '{BankId}' (0x{Address:X4}, {Count} regs) for device {DeviceId}.",
                    bank.Id, bank.Address, bank.Count, device.DeviceId);

                var request = ModbusRtu.BuildReadHoldingRegistersRequest(slaveAddress, bank.Address, bank.Count);
                var response = await SendAndReceiveAsync(serialPort, request,
                    ModbusRtu.ExpectedReadResponseLength(bank.Count), readTimeout, cancellationToken);

                var data = ModbusRtu.ValidateAndExtractData(response, slaveAddress, bank.FunctionCode);
                var dataArray = data.ToArray();
                bankData[bank.Id] = dataArray;
                _bankCache[bank.Id] = (now, dataArray);
            }

            // Parse all entities from raw bank data
            var collectedAt = DateTimeOffset.UtcNow;
            return BuildPollResult(definition, bankData, collectedAt);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw new TimeoutException($"Overall poll timeout ({overallTimeoutMs}ms) exceeded for device {device.DeviceId}.");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw;
        }
        finally
        {
            _busLock.Release();
        }
    }

    public async Task<WriteRegisterResult> WriteEntityAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        string entityId,
        uint rawValue,
        CancellationToken cancellationToken)
    {
        var entity = definition.Entities.FirstOrDefault(e =>
            string.Equals(e.Id, entityId, StringComparison.OrdinalIgnoreCase) && e.Writable);
        if (entity is null)
            throw new ArgumentException($"Writable entity '{entityId}' not found in definition '{definition.Device.Id}'.");

        var bank = definition.RegisterBanks.FirstOrDefault(b =>
            string.Equals(b.Id, entity.Source.Bank, StringComparison.OrdinalIgnoreCase));
        if (bank?.Write is null)
            throw new InvalidOperationException($"Register bank '{entity.Source.Bank}' does not support writes.");

        var transport = definition.Connection.Transport;
        var protocolSettings = definition.Connection.Protocol.Settings ?? new ProtocolSettings();
        var slaveAddress = device.Address != 0 ? device.Address : protocolSettings.DefaultSlaveAddress;
        var readTimeout = transport.Defaults?.ReadTimeoutMs ?? 1000;

        // Calculate the register address for this entity's byte offset
        // For JK BMS: register address = bank base + byte offset (byte-addressed)
        var registerAddress = (ushort)(bank.Address + entity.Source.ByteOffset);

        using var writeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        writeCts.CancelAfter(readTimeout * 5);
        var writeToken = writeCts.Token;

        await _busLock.WaitAsync(writeToken);
        try
        {
            var serialPort = EnsurePort(device, definition);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            logger.LogInformation("Writing entity '{EntityId}' (0x{Register:X4}) = {Value} for device {DeviceId}.",
                entityId, registerAddress, rawValue, device.DeviceId);

            var writeRequest = ModbusRtu.BuildWriteMultipleRegistersRequest(slaveAddress, registerAddress, rawValue);
            var writeResponse = await SendAndReceiveAsync(serialPort, writeRequest,
                ModbusRtu.WriteResponseLength, readTimeout, cancellationToken);
            ModbusRtu.ValidateAndExtractData(writeResponse, slaveAddress, bank.Write.FunctionCode);

            // Read back to verify
            await Task.Delay(50, writeToken);
            serialPort.DiscardInBuffer();

            var readRequest = ModbusRtu.BuildReadHoldingRegistersRequest(slaveAddress, registerAddress, (ushort)bank.Write.RegistersPerWrite);
            var readResponse = await SendAndReceiveAsync(serialPort, readRequest,
                ModbusRtu.ExpectedReadResponseLength((ushort)bank.Write.RegistersPerWrite), readTimeout, cancellationToken);

            var frame = readResponse;
            if (frame.Length >= 9 && frame[1] == 0x03 && frame[2] == 4)
            {
                var readBack = (uint)((frame[3] << 24) | (frame[4] << 16) | (frame[5] << 8) | frame[6]);
                var success = readBack == rawValue;
                logger.LogInformation("Write verification for '{EntityId}': written={Written}, readBack={ReadBack}, success={Success}.",
                    entityId, rawValue, readBack, success);

                // Invalidate cached bank data after a write
                _bankCache.Remove(bank.Id);

                return new WriteRegisterResult(success, rawValue, readBack,
                    success ? null : $"Read-back mismatch: expected {rawValue}, got {readBack}");
            }

            return new WriteRegisterResult(false, rawValue, null, "Unable to read back register value after write.");
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw new TimeoutException($"Write timeout exceeded for entity {entityId}.");
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw;
        }
        finally
        {
            _busLock.Release();
        }
    }

    private DevicePollResult BuildPollResult(
        DeviceDefinition definition,
        IReadOnlyDictionary<string, byte[]> bankData,
        DateTimeOffset collectedAt)
    {
        var entityValues = new Dictionary<string, decimal?>(StringComparer.OrdinalIgnoreCase);
        var entityStringValues = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        var parameters = new List<DeviceParameter>();
        var cellVoltages = new List<CellVoltageSnapshot>();
        var rawRegisters = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var sortOrder = 0;

        // Phase 1: Parse all direct entities from register bank data
        foreach (var entity in definition.Entities)
        {
            if (!bankData.TryGetValue(entity.Source.Bank, out var data))
                continue;

            if (entity.Type == "cell_array")
            {
                ParseCellArray(entity, data, cellVoltages, entityValues, parameters, ref sortOrder);
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
                        IsWritable = entity.Writable
                    });
                }
                continue;
            }

            if (entity.Type == "binary_sensor")
            {
                var boolValue = ParseBinarySensorEntity(entity, data);
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
                        IsWritable = entity.Writable
                    });
                }
                continue;
            }

            // sensor, number, switch
            var numericValue = ParseNumericEntity(entity, data);
            entityValues[entity.Id] = numericValue;

            if (!entity.Hidden)
            {
                if (entity.Type == "switch")
                {
                    var rawUint = ReadRawUint(entity, data);
                    parameters.Add(new DeviceParameter
                    {
                        Key = entity.Id,
                        DisplayName = entity.Name,
                        BooleanValue = rawUint.HasValue && rawUint.Value != 0,
                        Category = entity.Category,
                        SortOrder = sortOrder++,
                        IsWritable = entity.Writable,
                        RawValue = rawUint.HasValue ? (long)rawUint.Value : null
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
                        RawValue = ReadRawUint(entity, data) is { } rv ? (long)rv : null
                    });
                }
            }
        }

        // Phase 2: Evaluate computed entities
        foreach (var computed in definition.ComputedEntities)
        {
            var result = expressionEvaluator.Evaluate(computed.Expression, entityValues, cellVoltages);

            // If this is a fallback, only use it if the original entity is null
            if (computed.FallbackFor is not null)
            {
                if (entityValues.TryGetValue(computed.FallbackFor, out var existing) && existing.HasValue)
                    continue;
            }

            entityValues[computed.Id] = result;

            if (computed.Type == "binary_sensor")
            {
                parameters.Add(new DeviceParameter
                {
                    Key = computed.Id,
                    DisplayName = computed.Name,
                    BooleanValue = result.HasValue && result.Value != 0,
                    Category = computed.Category,
                    SortOrder = sortOrder++
                });
            }
            else if (result.HasValue)
            {
                var precision = computed.Display?.Precision ?? 2;
                parameters.Add(new DeviceParameter
                {
                    Key = computed.Id,
                    DisplayName = computed.Name,
                    NumericValue = decimal.Round(result.Value, precision),
                    Unit = computed.Unit,
                    Category = computed.Category,
                    SortOrder = sortOrder++
                });
            }
        }

        // Phase 3: Decode alarms
        int? alarmFlagValue = null;
        if (definition.Alarms is not null &&
            entityValues.TryGetValue(definition.Alarms.Source, out var alarmVal) && alarmVal.HasValue)
        {
            alarmFlagValue = (int)alarmVal.Value;
        }
        var activeWarnings = AlarmDecoder.Decode(alarmFlagValue ?? 0, definition.Alarms);

        // Phase 4: Build snapshot using semantic roles
        var orderedCells = cellVoltages.OrderBy(c => c.Index).ToArray();
        var snapshot = new DeviceTelemetrySnapshot
        {
            CollectedAt = collectedAt,
            CellCount = orderedCells.Length == 0 ? null : orderedCells.Length,
            TotalVoltageVolts = GetRoleValue(entityValues, definition, "total-voltage"),
            CurrentAmps = GetRoleValue(entityValues, definition, "current"),
            PowerWatts = GetRoleValue(entityValues, definition, "power") ?? GetComputedValue(entityValues, "computed_power"),
            StateOfChargePercent = GetRoleValue(entityValues, definition, "state-of-charge"),
            MinCellVoltageVolts = entityValues.GetValueOrDefault("min_cell_voltage"),
            MaxCellVoltageVolts = entityValues.GetValueOrDefault("max_cell_voltage"),
            AverageCellVoltageVolts = entityValues.GetValueOrDefault("avg_cell_voltage"),
            DeltaCellVoltageVolts = entityValues.GetValueOrDefault("delta_cell_voltage"),
            MosTemperatureCelsius = GetFirstRoleValue(entityValues, definition, "temperature", "mos_temperature"),
            AmbientTemperatureCelsius = null,
            BatteryTemperatureCelsius = GetFirstRoleValue(entityValues, definition, "temperature", "battery_temp_1"),
            CycleCount = GetRoleValue(entityValues, definition, "cycle-count") is { } cc ? (int)cc : null,
            WarningFlags = alarmFlagValue,
            StatusFlags = null,
            ProtocolVersion = null,
            SoftwareVersion = entityStringValues.GetValueOrDefault("software_version"),
            ManufacturerId = entityStringValues.GetValueOrDefault("manufacturer_device_id"),
            ChargingEnabled = GetRoleBool(entityValues, definition, "charging-enabled"),
            DischargingEnabled = GetRoleBool(entityValues, definition, "discharging-enabled"),
            BalancingEnabled = GetRoleBool(entityValues, definition, "balancing-enabled"),
            BatteryOnline = true,
            Cells = orderedCells,
            ActiveWarnings = activeWarnings,
            Parameters = parameters
        };

        return new DevicePollResult(snapshot, rawRegisters, string.Empty);
    }

    #region Entity Parsing

    private static void ParseCellArray(
        EntityDefinition entity, byte[] data,
        List<CellVoltageSnapshot> cells,
        Dictionary<string, decimal?> entityValues,
        List<DeviceParameter> parameters,
        ref int sortOrder)
    {
        var source = entity.Source;
        var elementSize = source.ElementByteSize > 0 ? source.ElementByteSize : 2;
        var maxElements = source.MaxElements > 0 ? source.MaxElements : 32;
        var scale = source.Scale != 0 ? (decimal)source.Scale : 1m;

        for (var i = 0; i < maxElements; i++)
        {
            var offset = source.ByteOffset + i * elementSize;
            if (offset + elementSize > data.Length) break;

            var rawValue = elementSize switch
            {
                2 => BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(offset, 2)),
                4 => BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(offset, 4)),
                _ => BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(offset, 2))
            };

            if (source.SkipZero && rawValue == 0) continue;

            var voltage = decimal.Round(rawValue * scale, 3);
            cells.Add(new CellVoltageSnapshot { Index = i + 1, VoltageVolts = voltage });
        }

        // Make cell_voltages available for computed expressions  
        entityValues[entity.Id] = cells.Count > 0 ? 1m : null;
    }

    private static decimal? ParseNumericEntity(EntityDefinition entity, byte[] data)
    {
        var source = entity.Source;
        if (source.ByteOffset >= data.Length) return null;

        var scale = (decimal)source.Scale;
        var precision = entity.Display?.Precision ?? 3;

        return source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => decimal.Round(data[source.ByteOffset] * scale, precision),
            "int16" when source.ByteOffset + 2 <= data.Length
                => decimal.Round(BinaryPrimitives.ReadInt16BigEndian(data.AsSpan(source.ByteOffset, 2)) * scale, precision),
            "uint16" when source.ByteOffset + 2 <= data.Length
                => decimal.Round(BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(source.ByteOffset, 2)) * scale, precision),
            "int32" when source.ByteOffset + 4 <= data.Length
                => decimal.Round(BinaryPrimitives.ReadInt32BigEndian(data.AsSpan(source.ByteOffset, 4)) * scale, precision),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => decimal.Round(BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(source.ByteOffset, 4)) * scale, precision),
            _ => null
        };
    }

    private static uint? ReadRawUint(EntityDefinition entity, byte[] data)
    {
        var source = entity.Source;
        return source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => data[source.ByteOffset],
            "uint16" when source.ByteOffset + 2 <= data.Length
                => BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(source.ByteOffset, 2)),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(source.ByteOffset, 4)),
            "int16" when source.ByteOffset + 2 <= data.Length
                => (uint)BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(source.ByteOffset, 2)),
            "int32" when source.ByteOffset + 4 <= data.Length
                => BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(source.ByteOffset, 4)),
            _ => null
        };
    }

    private static bool? ParseBinarySensorEntity(EntityDefinition entity, byte[] data)
    {
        var source = entity.Source;
        uint? rawValue = source.DataType.ToLowerInvariant() switch
        {
            "uint8" when source.ByteOffset < data.Length
                => data[source.ByteOffset],
            "uint16" when source.ByteOffset + 2 <= data.Length
                => BinaryPrimitives.ReadUInt16BigEndian(data.AsSpan(source.ByteOffset, 2)),
            "uint32" when source.ByteOffset + 4 <= data.Length
                => BinaryPrimitives.ReadUInt32BigEndian(data.AsSpan(source.ByteOffset, 4)),
            _ => null
        };

        if (rawValue is null) return null;
        return rawValue.Value == (uint)source.TrueValue;
    }

    private static string? ParseAsciiEntity(EntityDefinition entity, byte[] data)
    {
        var source = entity.Source;
        var length = source.Length > 0 ? source.Length : 16;
        if (source.ByteOffset + length > data.Length) return null;

        var sb = new StringBuilder(length);
        for (var i = source.ByteOffset; i < source.ByteOffset + length; i++)
        {
            var b = data[i];
            if (b >= 0x20 && b < 0x7F) sb.Append((char)b);
        }
        var result = sb.ToString().Trim();
        return result.Length > 0 ? result : null;
    }

    #endregion

    #region Role Lookup Helpers

    private static decimal? GetRoleValue(IReadOnlyDictionary<string, decimal?> values, DeviceDefinition definition, string role)
    {
        var entity = definition.Entities.FirstOrDefault(e => string.Equals(e.Role, role, StringComparison.OrdinalIgnoreCase));
        if (entity is not null && values.TryGetValue(entity.Id, out var val))
            return val;

        var computed = definition.ComputedEntities.FirstOrDefault(e => string.Equals(e.Role, role, StringComparison.OrdinalIgnoreCase));
        if (computed is not null && values.TryGetValue(computed.Id, out var cVal))
            return cVal;

        return null;
    }

    private static decimal? GetFirstRoleValue(IReadOnlyDictionary<string, decimal?> values, DeviceDefinition definition, string role, string preferredId)
    {
        if (values.TryGetValue(preferredId, out var preferred) && preferred.HasValue)
            return preferred;
        return GetRoleValue(values, definition, role);
    }

    private static bool? GetRoleBool(IReadOnlyDictionary<string, decimal?> values, DeviceDefinition definition, string role)
    {
        var val = GetRoleValue(values, definition, role);
        return val.HasValue ? val.Value != 0 : null;
    }

    private static decimal? GetComputedValue(IReadOnlyDictionary<string, decimal?> values, string id)
        => values.GetValueOrDefault(id);

    #endregion

    #region Serial Port Management

    private async Task<byte[]> SendAndReceiveAsync(SerialPort serialPort, byte[] request, int expectedLen, int readTimeout, CancellationToken cancellationToken)
    {
        await serialPort.BaseStream.WriteAsync(request, cancellationToken);
        await serialPort.BaseStream.FlushAsync(cancellationToken);
        return await ModbusRtu.ReadResponseAsync(serialPort.BaseStream, expectedLen, readTimeout, cancellationToken);
    }

    private SerialPort EnsurePort(DeviceConfiguration device, DeviceDefinition definition)
    {
        var defaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();

        // Allow per-device transport overrides if configured in appsettings
        // For now, use the definition defaults
        var portName = device.TransportPortName ?? _configuration.SerialBus.PortName;

        if (_serialPort is { IsOpen: true } && _serialPort.PortName == portName)
            return _serialPort;

        _serialPort?.Dispose();

        _serialPort = new SerialPort(portName)
        {
            BaudRate = defaults.BaudRate,
            DataBits = defaults.DataBits,
            Parity = ParseParity(defaults.Parity),
            StopBits = ParseStopBits(defaults.StopBits),
            ReadTimeout = defaults.ReadTimeoutMs,
            WriteTimeout = defaults.WriteTimeoutMs,
            Handshake = Handshake.None
        };

        _serialPort.Open();
        return _serialPort;
    }

    private void ClosePort()
    {
        try { _serialPort?.Close(); } catch { /* best-effort */ }
        try { _serialPort?.Dispose(); } catch { /* best-effort */ }
        _serialPort = null;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _serialPort?.Dispose();
        _busLock.Dispose();
    }

    private static Parity ParseParity(string parity)
        => Enum.TryParse<Parity>(parity, ignoreCase: true, out var value)
            ? value
            : Parity.None;

    private static StopBits ParseStopBits(int stopBits)
        => stopBits switch
        {
            1 => StopBits.One,
            2 => StopBits.Two,
            _ => StopBits.One
        };

    #endregion
}
