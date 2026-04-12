using System.Buffers.Binary;
using FluxMonitor.Contracts.DeviceDefinition;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Interprets a JSON-defined <see cref="ResponseLayoutDefinition"/> to transform
/// variable-length protocol responses into fixed-size byte buffers.
///
/// This enables protocols with dynamic response structures (variable cell counts,
/// conditional fields, etc.) to be fully described in device definition JSON
/// rather than requiring per-device C# code.
/// </summary>
internal static class ResponseLayoutNormalizer
{
    /// <summary>
    /// Normalize a raw binary payload according to the given layout definition.
    /// Returns a fixed-size byte buffer that entity definitions can reference via byte offsets.
    /// </summary>
    public static byte[] Normalize(byte[] input, ResponseLayoutDefinition layout)
    {
        var buffer = new byte[layout.BufferSize];
        var vars = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var reader = new PayloadReader(input);

        ExecuteSteps(layout.Steps, reader, buffer, vars);
        return buffer;
    }

    private static void ExecuteSteps(
        IReadOnlyList<ResponseLayoutStep> steps,
        PayloadReader reader,
        byte[] buffer,
        Dictionary<string, int> vars)
    {
        foreach (var step in steps)
        {
            if (reader.IsExhausted && step.Op is not "writeVar" and not "writeBit" and not "branch" and not "mathAdd" and not "mathSub" and not "mathMul" and not "mathDiv" and not "mathMod" and not "mathAnd" and not "mathXor")
                break;

            switch (step.Op)
            {
                case "skip":
                    reader.Skip(step.Size);
                    break;

                case "copy":
                    reader.CopyTo(buffer, step.WriteTo ?? 0, step.Size);
                    break;

                case "copyRemaining":
                {
                    var remaining = reader.Remaining;
                    var toCopy = step.Max > 0 ? Math.Min(remaining, step.Max) : remaining;
                    reader.CopyTo(buffer, step.WriteTo ?? 0, toCopy);
                    break;
                }

                case "readVar":
                {
                    var value = ReadTypedValue(reader, step.Type ?? "u8");
                    if (step.Var is not null)
                        vars[step.Var] = value;

                    if (step.WriteTo.HasValue)
                    {
                        var writeType = step.WriteAs ?? step.Type ?? "u8";
                        WriteTypedValue(buffer, step.WriteTo.Value, value, writeType);
                    }
                    break;
                }

                case "writeVar":
                {
                    if (step.Var is not null && vars.TryGetValue(step.Var, out var val) && step.WriteTo.HasValue)
                    {
                        var writeType = step.WriteAs ?? "u16";
                        WriteTypedValue(buffer, step.WriteTo.Value, val, writeType);
                    }
                    break;
                }

                case "writeBit":
                {
                    if (step.Var is not null && vars.TryGetValue(step.Var, out var val) && step.WriteTo.HasValue)
                    {
                        var bitSet = (val & (1 << step.Bit)) != 0;
                        if (step.WriteTo.Value < buffer.Length)
                            buffer[step.WriteTo.Value] = (byte)(bitSet ? 1 : 0);
                    }
                    break;
                }

                case "copyArray":
                {
                    var count = ResolveCount(step.Count, vars);
                    var elemSize = step.ElementSize > 0 ? step.ElementSize : 1;
                    var maxSlots = step.Max > 0 ? step.Max : count;
                    var toCopy = Math.Min(count, maxSlots);
                    var writeTo = step.WriteTo ?? 0;

                    for (var i = 0; i < toCopy && !reader.IsExhausted; i++)
                        reader.CopyTo(buffer, writeTo + i * elemSize, elemSize);

                    // Skip remaining elements beyond max
                    for (var i = toCopy; i < count && !reader.IsExhausted; i++)
                        reader.Skip(elemSize);
                    break;
                }

                case "skipArray":
                {
                    var count = ResolveCount(step.Count, vars);
                    var elemSize = step.ElementSize > 0 ? step.ElementSize : 1;
                    reader.Skip(count * elemSize);
                    break;
                }

                case "readAnyNonZero":
                {
                    var count = ResolveCount(step.Count, vars);
                    var anyNonZero = false;
                    for (var i = 0; i < count && !reader.IsExhausted; i++)
                    {
                        if (reader.ReadByte() != 0)
                            anyNonZero = true;
                    }
                    if (step.WriteTo.HasValue && step.WriteTo.Value < buffer.Length)
                        buffer[step.WriteTo.Value] = (byte)(anyNonZero ? 1 : 0);
                    break;
                }

                case "readByte":
                {
                    if (!reader.IsExhausted && step.WriteTo.HasValue && step.WriteTo.Value < buffer.Length)
                        buffer[step.WriteTo.Value] = reader.ReadByte();
                    break;
                }

                case "firstOf":
                {
                    var count = step.Var is not null && vars.TryGetValue(step.Var, out var c) ? c : 0;
                    if (count > 0 && step.Steps is not null)
                        ExecuteSteps(step.Steps, reader, buffer, vars);
                    break;
                }

                case "branch":
                {
                    var varValue = step.Var is not null && vars.TryGetValue(step.Var, out var v) ? v : 0;
                    var conditionMet = EvaluateCondition(varValue, step);

                    if (conditionMet && step.Then is not null)
                        ExecuteSteps(step.Then, reader, buffer, vars);
                    else if (!conditionMet && step.Else is not null)
                        ExecuteSteps(step.Else, reader, buffer, vars);
                    break;
                }

                case "mathAdd":
                case "mathSub":
                case "mathMul":
                case "mathDiv":
                case "mathMod":
                case "mathAnd":
                case "mathXor":
                {
                    if (step.Var is null)
                        break;

                    var left = vars.TryGetValue(step.Var, out var currentValue) ? currentValue : 0;
                    var right = ResolveOperand(step, vars);
                    var result = step.Op switch
                    {
                        "mathAdd" => left + right,
                        "mathSub" => left - right,
                        "mathMul" => left * right,
                        "mathDiv" => right == 0 ? left : left / right,
                        "mathMod" => right == 0 ? left : left % right,
                        "mathAnd" => left & right,
                        "mathXor" => left ^ right,
                        _ => left
                    };

                    var targetVar = step.TargetVar ?? step.Var;
                    vars[targetVar] = result;

                    if (step.WriteTo.HasValue)
                    {
                        var writeType = step.WriteAs ?? "u16";
                        WriteTypedValue(buffer, step.WriteTo.Value, result, writeType);
                    }

                    break;
                }
            }
        }
    }

    private static int ResolveCount(string? countRef, Dictionary<string, int> vars)
    {
        if (countRef is null) return 0;
        return vars.TryGetValue(countRef, out var c) ? c : 0;
    }

    private static int ResolveOperand(ResponseLayoutStep step, Dictionary<string, int> vars)
    {
        if (step.Value.HasValue)
            return step.Value.Value;

        if (step.OtherVar is not null && vars.TryGetValue(step.OtherVar, out var other))
            return other;

        return 0;
    }

    private static int ReadTypedValue(PayloadReader reader, string type)
    {
        return type switch
        {
            "u8" => reader.ReadByte(),
            "u16" => reader.ReadUInt16BE(),
            "u24" => reader.ReadUInt24BE(),
            "u32" => reader.ReadInt32BE(),
            "i16" => reader.ReadInt16BE(),
            _ => reader.ReadByte()
        };
    }

    private static void WriteTypedValue(byte[] buffer, int offset, int value, string type)
    {
        switch (type)
        {
            case "u8" when offset < buffer.Length:
                buffer[offset] = (byte)(value & 0xFF);
                break;
            case "u16" or "i16" when offset + 1 < buffer.Length:
                if (string.Equals(type, "i16", StringComparison.OrdinalIgnoreCase))
                {
                    BinaryPrimitives.WriteInt16BigEndian(buffer.AsSpan(offset, 2), (short)value);
                }
                else
                {
                    BinaryPrimitives.WriteUInt16BigEndian(buffer.AsSpan(offset, 2), (ushort)(value & 0xFFFF));
                }
                break;
            case "u32" or "i32" when offset + 3 < buffer.Length:
                if (string.Equals(type, "i32", StringComparison.OrdinalIgnoreCase))
                {
                    BinaryPrimitives.WriteInt32BigEndian(buffer.AsSpan(offset, 4), value);
                }
                else
                {
                    BinaryPrimitives.WriteUInt32BigEndian(buffer.AsSpan(offset, 4), (uint)value);
                }
                break;
        }
    }

    private static bool EvaluateCondition(int value, ResponseLayoutStep step)
    {
        if (step.Gt.HasValue) return value > step.Gt.Value;
        if (step.Lt.HasValue) return value < step.Lt.Value;
        if (step.Eq.HasValue) return value == step.Eq.Value;
        return false;
    }

    /// <summary>
    /// Lightweight sequential reader over a byte array.
    /// </summary>
    private ref struct PayloadReader
    {
        private readonly ReadOnlySpan<byte> _data;
        private int _pos;

        public PayloadReader(byte[] data)
        {
            _data = data;
            _pos = 0;
        }

        public readonly bool IsExhausted => _pos >= _data.Length;
        public readonly int Remaining => Math.Max(0, _data.Length - _pos);

        public byte ReadByte()
        {
            if (_pos >= _data.Length) return 0;
            return _data[_pos++];
        }

        public int ReadUInt16BE()
        {
            if (_pos + 2 > _data.Length) { _pos = _data.Length; return 0; }
            var val = BinaryPrimitives.ReadUInt16BigEndian(_data.Slice(_pos, 2));
            _pos += 2;
            return val;
        }

        public int ReadInt16BE()
        {
            if (_pos + 2 > _data.Length) { _pos = _data.Length; return 0; }
            var val = BinaryPrimitives.ReadInt16BigEndian(_data.Slice(_pos, 2));
            _pos += 2;
            return val;
        }

        public int ReadUInt24BE()
        {
            if (_pos + 3 > _data.Length) { _pos = _data.Length; return 0; }
            var val = (_data[_pos] << 16) | (_data[_pos + 1] << 8) | _data[_pos + 2];
            _pos += 3;
            return val;
        }

        public int ReadInt32BE()
        {
            if (_pos + 4 > _data.Length) { _pos = _data.Length; return 0; }
            var val = BinaryPrimitives.ReadInt32BigEndian(_data.Slice(_pos, 4));
            _pos += 4;
            return val;
        }

        public void Skip(int bytes)
        {
            _pos = Math.Min(_pos + bytes, _data.Length);
        }

        public void CopyTo(byte[] dest, int destOffset, int count)
        {
            var available = Math.Min(count, _data.Length - _pos);
            var writable = Math.Min(available, dest.Length - destOffset);
            if (writable > 0)
                _data.Slice(_pos, writable).CopyTo(dest.AsSpan(destOffset, writable));
            _pos += available;
        }
    }
}
