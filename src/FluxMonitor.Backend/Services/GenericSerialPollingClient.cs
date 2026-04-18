using System.Buffers.Binary;
using System.IO.Ports;
using System.Text;
using FluxMonitor.Backend.Models;
using FluxMonitor.Backend.Protocol;
using FluxMonitor.Contracts.Configuration;
using FluxMonitor.Contracts.DeviceDefinition;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Definition-driven serial polling client. Selects wire framing based on the
/// protocol type in the device definition (modbus-rtu, ascii-hex-framed, ...).
/// Response normalization is JSON-driven via ResponseLayout definitions.
/// </summary>
public sealed class GenericSerialPollingClient(
    DefinitionDrivenTelemetryBuilder telemetryBuilder,
    ExpressionEvaluator expressionEvaluator,
    DeviceDefinitionLoader definitionLoader,
    ILogger<GenericSerialPollingClient> logger) : IDevicePollingClient, IDisposable
{
    private readonly SemaphoreSlim _busLock = new(1, 1);
    private SerialPort? _serialPort;
    private bool _disposed;

    // Slow poll group caching: bank ID → (lastRead, rawData)
    private readonly Dictionary<string, (DateTimeOffset LastRead, byte[] Data)> _bankCache = new(StringComparer.OrdinalIgnoreCase);

    public Task<DevicePollResult> PollAsync(DeviceConfiguration device, CancellationToken cancellationToken)
    {
        if (!device.TryResolveDefinition(definitionLoader, out var definition) || definition is null)
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
        var overallTimeoutMs = readTimeout * (definition.DataSources.Count + 1) * 3;

        using var pollCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        pollCts.CancelAfter(overallTimeoutMs);
        var pollToken = pollCts.Token;

        await _busLock.WaitAsync(pollToken);
        try
        {
            var serialPort = EnsurePort(device, definition);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            // Read each data-source bank
            var bankData = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            var now = DateTimeOffset.UtcNow;
            var protocolType = definition.Connection.Protocol.Type ?? "modbus-rtu";

            foreach (var bank in definition.DataSources)
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

                logger.LogDebug("Reading data source bank '{BankId}' via {Protocol}.", bank.Id, protocolType);

                byte[] dataArray;
                try
                {
                    dataArray = protocolType switch
                    {
                        "ascii-hex-framed" => await ReadAsciiHexFramedBankAsync(serialPort, bank, slaveAddress, protocolSettings, readTimeout, pollToken),
                        _ => await ReadModbusBankAsync(serialPort, bank, slaveAddress, readTimeout, pollToken),
                    };
                }
                catch (Exception ex) when (bank.Optional)
                {
                    logger.LogWarning(ex, "Optional bank '{BankId}' read failed, skipping.", bank.Id);
                    continue;
                }

                // Apply response layout normalization if defined
                if (bank.ResponseLayout is not null)
                    dataArray = ResponseLayoutNormalizer.Normalize(dataArray, bank.ResponseLayout);

                bankData[bank.Id] = dataArray;
                _bankCache[bank.Id] = (now, dataArray);
            }

            // Parse all entities from raw bank data
            var collectedAt = DateTimeOffset.UtcNow;
            return telemetryBuilder.BuildPollResult(definition, bankData, collectedAt);
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
        var result = (await WriteEntitiesAsync(
            device,
            definition,
            [new EntityWriteRequest(entityId, rawValue)],
            cancellationToken)).Single();

        return new WriteRegisterResult(
            result.Success,
            result.WrittenValue,
            result.ReadBackValue,
            result.Error);
    }

    public async Task<IReadOnlyList<EntityWriteResult>> WriteEntitiesAsync(
        DeviceConfiguration device,
        DeviceDefinition definition,
        IReadOnlyList<EntityWriteRequest> writes,
        CancellationToken cancellationToken)
    {
        if (writes.Count == 0)
            throw new ArgumentException("At least one write request is required.", nameof(writes));

        var transport = definition.Connection.Transport;
        var protocolSettings = definition.Connection.Protocol.Settings ?? new ProtocolSettings();
        var slaveAddress = device.Address != 0 ? device.Address : protocolSettings.DefaultSlaveAddress;
        var readTimeout = transport.Defaults?.ReadTimeoutMs ?? 1000;
        var plans = writes.Select(write => ResolveWritePlan(definition, write.EntityId, write.RawValue)).ToList();

        using var writeCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        writeCts.CancelAfter(readTimeout * 5);
        var writeToken = writeCts.Token;

        await _busLock.WaitAsync(writeToken);
        try
        {
            var serialPort = EnsurePort(device, definition);
            serialPort.DiscardInBuffer();
            serialPort.DiscardOutBuffer();

            var resultsByEntityId = new Dictionary<string, EntityWriteResult>(StringComparer.OrdinalIgnoreCase);
            var affectedBankIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var pendingPlans = new List<ResolvedWritePlan>(plans);

            while (pendingPlans.Count > 0)
            {
                var currentPlan = pendingPlans[0];
                pendingPlans.RemoveAt(0);

                logger.LogInformation(
                    "Writing configured register value. Entity={EntityId}, Register=0x{Register:X4}.",
                    currentPlan.Entity.Id,
                    currentPlan.RegisterAddress);

                if (currentPlan.GroupWrite is { } groupWrite)
                {
                    var groupedPlans = new[] { currentPlan }
                        .Concat(pendingPlans.Where(plan =>
                            plan.Bank.Id == currentPlan.Bank.Id &&
                            plan.GroupWrite is { } candidate &&
                            candidate.StartAddress == groupWrite.StartAddress &&
                            candidate.RegisterCount == groupWrite.RegisterCount))
                        .ToArray();

                    foreach (var groupedPlan in groupedPlans.Skip(1))
                    {
                        pendingPlans.Remove(groupedPlan);
                    }

                    var groupedResults = await WriteGroupedRegistersAsync(
                        serialPort,
                        slaveAddress,
                        readTimeout,
                        writeToken,
                        groupedPlans);

                    foreach (var result in groupedResults)
                    {
                        resultsByEntityId[result.EntityId] = result;
                    }

                    affectedBankIds.Add(currentPlan.Bank.Id);
                    continue;
                }

                var verificationResult = await WriteSingleRegisterAsync(
                    serialPort,
                    slaveAddress,
                    currentPlan,
                    readTimeout,
                    writeToken);

                resultsByEntityId[verificationResult.EntityId] = verificationResult;
                affectedBankIds.Add(currentPlan.Bank.Id);
            }

            foreach (var bankId in affectedBankIds)
            {
                _bankCache.Remove(bankId);
            }

            return plans.Select(plan => resultsByEntityId[plan.Entity.Id]).ToArray();
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            ClosePort();
            throw new TimeoutException("Write timeout exceeded while updating device parameters.");
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
                        IsWritable = entity.Writable,
                        DisplayFormatter = entity.Display?.Formatter
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
                        IsWritable = entity.Writable,
                        DisplayFormatter = entity.Display?.Formatter
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
                        RawValue = ReadRawUint(entity, data) is { } rv ? (long)rv : null,
                        DisplayFormatter = entity.Display?.Formatter
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
                    SortOrder = sortOrder++,
                    DisplayFormatter = computed.Display?.Formatter
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
                    SortOrder = sortOrder++,
                    DisplayFormatter = computed.Display?.Formatter
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
        var effective = source.BitMask != 0 ? rawValue.Value & source.BitMask : rawValue.Value;
        return effective == (uint)source.TrueValue;
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

    #region Protocol-specific bank reading

    private static ResolvedWritePlan ResolveWritePlan(DeviceDefinition definition, string entityId, uint rawValue)
    {
        var entity = definition.Entities.FirstOrDefault(e =>
            string.Equals(e.Id, entityId, StringComparison.OrdinalIgnoreCase) && e.Writable);
        if (entity is null)
            throw new ArgumentException($"Writable entity '{entityId}' not found in definition '{definition.Device.Id}'.");

        var bank = definition.DataSources.FirstOrDefault(b =>
            string.Equals(b.Id, entity.Source.Bank, StringComparison.OrdinalIgnoreCase));
        if (bank?.Write is null)
            throw new InvalidOperationException($"Register bank '{entity.Source.Bank}' does not support writes.");

        var configuredWriteAddress = entity.Write?.Address;
        if (configuredWriteAddress is < 0 or > ushort.MaxValue)
            throw new InvalidOperationException($"Writable entity '{entityId}' resolved to an invalid register address.");

        var registerAddress = configuredWriteAddress.HasValue
            ? (ushort)configuredWriteAddress.Value
            : (ushort)(bank.Address + entity.Source.ByteOffset);
        var registersPerWrite = bank.Write.RegistersPerWrite > 0 ? bank.Write.RegistersPerWrite : 2;

        GroupWritePlan? groupWrite = null;
        if (TryResolveGroupWrite(entity, registerAddress, registersPerWrite, out var resolvedGroupWrite))
        {
            groupWrite = resolvedGroupWrite;
        }

        return new ResolvedWritePlan(entity, bank, registerAddress, registersPerWrite, rawValue, groupWrite);
    }

    internal static bool TryResolveGroupWrite(
        EntityDefinition entity,
        ushort registerAddress,
        int registersPerWrite,
        out GroupWritePlan groupWrite)
    {
        var groupStartAddress = entity.Write?.GroupStartAddress;
        var groupRegisterCount = entity.Write?.GroupRegisterCount;

        if (!groupStartAddress.HasValue || !groupRegisterCount.HasValue)
        {
            groupWrite = default;
            return false;
        }

        if (groupStartAddress.Value < 0 || groupStartAddress.Value > ushort.MaxValue)
            throw new InvalidOperationException($"Writable entity '{entity.Id}' has an invalid grouped write start address.");

        if (groupRegisterCount.Value < registersPerWrite)
            throw new InvalidOperationException($"Writable entity '{entity.Id}' has an invalid grouped write register count.");

        var startAddress = (ushort)groupStartAddress.Value;
        var registerOffset = registerAddress - startAddress;
        if (registerOffset < 0 || registerOffset + registersPerWrite > groupRegisterCount.Value)
            throw new InvalidOperationException($"Writable entity '{entity.Id}' resolved outside its grouped write range.");

        groupWrite = new GroupWritePlan(startAddress, groupRegisterCount.Value, registerOffset);
        return true;
    }

    internal static ushort[] MergeGroupWriteRegisters(
        IReadOnlyList<ushort> existingRegisters,
        int registerOffset,
        uint rawValue,
        int registersPerWrite)
    {
        var merged = existingRegisters.ToArray();
        var encodedValue = ModbusRtu.EncodeRegisterValues(rawValue, registersPerWrite);

        if (registerOffset < 0 || registerOffset + encodedValue.Length > merged.Length)
            throw new ArgumentOutOfRangeException(nameof(registerOffset), "Register offset falls outside the grouped register range.");

        for (var i = 0; i < encodedValue.Length; i++)
        {
            merged[registerOffset + i] = encodedValue[i];
        }

        return merged;
    }

    internal static uint DecodeRegisterValue(IReadOnlyList<ushort> registers, int startIndex, int registerCount)
    {
        if (registerCount == 1)
            return registers[startIndex];

        if (registerCount == 2)
            return ((uint)registers[startIndex] << 16) | registers[startIndex + 1];

        throw new ArgumentOutOfRangeException(nameof(registerCount), registerCount, "Only 1 or 2 registers are supported for scalar read-back decoding.");
    }

    private async Task<byte[]> ReadModbusBankAsync(
        SerialPort serialPort, DataSourceDefinition bank, byte slaveAddress,
        int readTimeout, CancellationToken ct)
    {
        var request = ModbusRtu.BuildReadHoldingRegistersRequest(slaveAddress, bank.Address, bank.Count);
        var response = await SendAndReceiveModbusAsync(serialPort, request,
            ModbusRtu.ExpectedReadResponseLength(bank.Count), readTimeout, ct);
        var data = ModbusRtu.ValidateAndExtractData(response, slaveAddress, bank.FunctionCode);
        return data.ToArray();
    }

    private async Task<byte[]> ReadAsciiHexFramedBankAsync(
        SerialPort serialPort, DataSourceDefinition bank, byte slaveAddress,
        ProtocolSettings protocolSettings, int readTimeout, CancellationToken ct)
    {
        var framing = protocolSettings.AsciiHexFrame
            ?? throw new InvalidOperationException(
                $"Protocol '{bank.Id}' requires protocol.settings.asciiHexFrame.");

        // RequestInfo is the ASCII-hex payload content (e.g. "FF" for "get all modules").
        byte[]? infoPayload = null;
        if (!string.IsNullOrEmpty(bank.RequestInfo))
            infoPayload = System.Text.Encoding.ASCII.GetBytes(bank.RequestInfo);

        var request = AsciiHexFramedProtocol.BuildCommand(slaveAddress, bank.Command, framing, infoPayload);
        var stream = serialPort.BaseStream;
        await stream.WriteAsync(request, ct);
        await stream.FlushAsync(ct);
        var response = await AsciiHexFramedProtocol.ReadFrameAsync(stream, framing, readTimeout, ct);
        return AsciiHexFramedProtocol.ValidateAndExtractPayload(response, framing);
    }

    #endregion

    private async Task<IReadOnlyList<EntityWriteResult>> WriteGroupedRegistersAsync(
        SerialPort serialPort,
        byte slaveAddress,
        int readTimeout,
        CancellationToken cancellationToken,
        IReadOnlyList<ResolvedWritePlan> groupedPlans)
    {
        var firstPlan = groupedPlans[0];
        var bank = firstPlan.Bank;
        var groupWrite = firstPlan.GroupWrite
            ?? throw new InvalidOperationException("Grouped write plan is missing grouped write metadata.");

        var existingRegisters = await ReadHoldingRegistersAsync(
            serialPort,
            slaveAddress,
            groupWrite.StartAddress,
            groupWrite.RegisterCount,
            readTimeout,
            cancellationToken);
        var mergedRegisters = existingRegisters.ToArray();
        foreach (var plan in groupedPlans)
        {
            mergedRegisters = MergeGroupWriteRegisters(
                mergedRegisters,
                plan.GroupWrite?.RegisterOffset ?? 0,
                plan.RawValue,
                plan.RegistersPerWrite);
        }

        var writeRequest = ModbusRtu.BuildWriteMultipleRegistersRequest(slaveAddress, groupWrite.StartAddress, mergedRegisters);
        var writeResponse = await SendAndReceiveModbusAsync(
            serialPort,
            writeRequest,
            ModbusRtu.WriteResponseLength,
            readTimeout,
            cancellationToken);
        ModbusRtu.ValidateAndExtractData(writeResponse, slaveAddress, bank.Write?.FunctionCode ?? 0x10);

        await Task.Delay(50, cancellationToken);
        serialPort.DiscardInBuffer();

        var verifiedRegisters = await ReadHoldingRegistersAsync(
            serialPort,
            slaveAddress,
            groupWrite.StartAddress,
            groupWrite.RegisterCount,
            readTimeout,
            cancellationToken);
        var success = mergedRegisters.SequenceEqual(verifiedRegisters);

        logger.LogInformation(
            "Grouped write verification completed. GroupStart=0x{GroupStart:X4}, RegisterCount={RegisterCount}, Success={Success}.",
            groupWrite.StartAddress,
            groupWrite.RegisterCount,
            success);

        return groupedPlans.Select(plan =>
        {
            var planGroupWrite = plan.GroupWrite
                ?? throw new InvalidOperationException("Grouped write plan is missing grouped write metadata.");
            var readBackValue = DecodeRegisterValue(
                verifiedRegisters,
                planGroupWrite.RegisterOffset,
                plan.RegistersPerWrite);

            return new EntityWriteResult(
                plan.Entity.Id,
                success,
                plan.RawValue,
                readBackValue,
                success ? null : $"Read-back mismatch: expected grouped write at 0x{groupWrite.StartAddress:X4} to persist.");
        }).ToArray();
    }

    private async Task<EntityWriteResult> WriteSingleRegisterAsync(
        SerialPort serialPort,
        byte slaveAddress,
        ResolvedWritePlan plan,
        int readTimeout,
        CancellationToken cancellationToken)
    {
        var writeRequest = ModbusRtu.BuildWriteMultipleRegistersRequest(
            slaveAddress,
            plan.RegisterAddress,
            plan.RawValue,
            plan.RegistersPerWrite);
        var writeResponse = await SendAndReceiveModbusAsync(
            serialPort,
            writeRequest,
            ModbusRtu.WriteResponseLength,
            readTimeout,
            cancellationToken);
        ModbusRtu.ValidateAndExtractData(writeResponse, slaveAddress, plan.Bank.Write?.FunctionCode ?? 0x10);

        await Task.Delay(50, cancellationToken);
        serialPort.DiscardInBuffer();

        var readRequest = ModbusRtu.BuildReadHoldingRegistersRequest(slaveAddress, plan.RegisterAddress, (ushort)plan.RegistersPerWrite);
        var readResponse = await SendAndReceiveModbusAsync(
            serialPort,
            readRequest,
            ModbusRtu.ExpectedReadResponseLength((ushort)plan.RegistersPerWrite),
            readTimeout,
            cancellationToken);
        var registers = ParseHoldingRegisters(readResponse, slaveAddress, plan.RegistersPerWrite);
        var readBack = DecodeRegisterValue(registers, 0, plan.RegistersPerWrite);
        var success = readBack == plan.RawValue;
        logger.LogInformation("Write verification completed. Success={Success}.", success);

        return new EntityWriteResult(
            plan.Entity.Id,
            success,
            plan.RawValue,
            readBack,
            success ? null : $"Read-back mismatch: expected {plan.RawValue}, got {readBack}");
    }

    private static async Task<ushort[]> ReadHoldingRegistersAsync(
        SerialPort serialPort,
        byte slaveAddress,
        ushort startRegister,
        int registerCount,
        int readTimeout,
        CancellationToken cancellationToken)
    {
        var readRequest = ModbusRtu.BuildReadHoldingRegistersRequest(slaveAddress, startRegister, (ushort)registerCount);
        var readResponse = await SendAndReceiveModbusAsync(
            serialPort,
            readRequest,
            ModbusRtu.ExpectedReadResponseLength((ushort)registerCount),
            readTimeout,
            cancellationToken);
        return ParseHoldingRegisters(readResponse, slaveAddress, registerCount);
    }

    private static ushort[] ParseHoldingRegisters(byte[] response, byte slaveAddress, int registerCount)
    {
        var payload = ModbusRtu.ValidateAndExtractData(response, slaveAddress, 0x03);
        if (payload.Length != registerCount * 2)
            throw new InvalidDataException($"Modbus read-back length mismatch. Expected {registerCount * 2} data bytes, got {payload.Length}.");

        var registers = new ushort[registerCount];
        for (var i = 0; i < registerCount; i++)
        {
            var offset = i * 2;
            registers[i] = BinaryPrimitives.ReadUInt16BigEndian(payload.Slice(offset, 2));
        }

        return registers;
    }

    #region Serial Port Management

    private static async Task<byte[]> SendAndReceiveModbusAsync(SerialPort serialPort, byte[] request, int expectedLen, int readTimeout, CancellationToken cancellationToken)
    {
        await serialPort.BaseStream.WriteAsync(request, cancellationToken);
        await serialPort.BaseStream.FlushAsync(cancellationToken);
        return await ModbusRtu.ReadResponseAsync(serialPort.BaseStream, expectedLen, readTimeout, cancellationToken);
    }

    private SerialPort EnsurePort(DeviceConfiguration device, DeviceDefinition definition)
    {
        var defaults = definition.Connection.Transport.Defaults ?? new TransportDefaults();

        var portName = device.TransportPortName
            ?? throw new InvalidOperationException($"Device '{device.DeviceId}' has no TransportPortName configured.");

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

internal readonly record struct GroupWritePlan(ushort StartAddress, int RegisterCount, int RegisterOffset);

internal sealed record ResolvedWritePlan(
    EntityDefinition Entity,
    DataSourceDefinition Bank,
    ushort RegisterAddress,
    int RegistersPerWrite,
    uint RawValue,
    GroupWritePlan? GroupWrite);
