using System.Globalization;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Evaluates definition-driven computed-entity expressions.
/// Supports arithmetic, comparisons, nested function calls, and aggregate
/// functions over the <c>cell_voltages</c> array.
/// </summary>
public sealed class ExpressionEvaluator
{
    public decimal? Evaluate(
        string expression,
        IReadOnlyDictionary<string, decimal?> entityValues,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        if (string.IsNullOrWhiteSpace(expression))
            return null;

        try
        {
            var parser = new Parser(expression);
            var node = parser.ParseExpression();
            parser.EnsureFullyConsumed();
            return EvaluateNode(node, entityValues, cellVoltages);
        }
        catch
        {
            return null;
        }
    }

    private static decimal? EvaluateNode(
        ExpressionNode node,
        IReadOnlyDictionary<string, decimal?> entityValues,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        return node switch
        {
            NumberNode number => number.Value,
            IdentifierNode identifier => entityValues.TryGetValue(identifier.Name, out var value) ? value : null,
            UnaryNode unary => EvaluateUnary(unary, entityValues, cellVoltages),
            BinaryNode binary => EvaluateBinary(binary, entityValues, cellVoltages),
            FunctionNode function => EvaluateFunction(function, entityValues, cellVoltages),
            _ => null
        };
    }

    private static decimal? EvaluateUnary(
        UnaryNode unary,
        IReadOnlyDictionary<string, decimal?> entityValues,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        var operand = EvaluateNode(unary.Operand, entityValues, cellVoltages);
        if (!operand.HasValue)
            return null;

        return unary.Operator switch
        {
            "-" => -operand.Value,
            "+" => operand.Value,
            _ => null
        };
    }

    private static decimal? EvaluateBinary(
        BinaryNode binary,
        IReadOnlyDictionary<string, decimal?> entityValues,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        var left = EvaluateNode(binary.Left, entityValues, cellVoltages);
        var right = EvaluateNode(binary.Right, entityValues, cellVoltages);
        if (!left.HasValue || !right.HasValue)
            return null;

        return binary.Operator switch
        {
            "+" => left.Value + right.Value,
            "-" => left.Value - right.Value,
            "*" => left.Value * right.Value,
            "/" => right.Value == 0 ? null : left.Value / right.Value,
            "==" => left.Value == right.Value ? 1m : 0m,
            "!=" => left.Value != right.Value ? 1m : 0m,
            "<" => left.Value < right.Value ? 1m : 0m,
            ">" => left.Value > right.Value ? 1m : 0m,
            "<=" => left.Value <= right.Value ? 1m : 0m,
            ">=" => left.Value >= right.Value ? 1m : 0m,
            _ => null
        };
    }

    private static decimal? EvaluateFunction(
        FunctionNode function,
        IReadOnlyDictionary<string, decimal?> entityValues,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        var name = function.Name.ToLowerInvariant();
        var arrayValues = ResolveArrayValues(function.Arguments, cellVoltages);
        if (arrayValues is not null)
        {
            return name switch
            {
                "min" => arrayValues.Min(),
                "max" => arrayValues.Max(),
                "avg" => decimal.Round(arrayValues.Average(), 3),
                "count" => arrayValues.Length,
                _ => null
            };
        }

        var values = new List<decimal>(function.Arguments.Count);
        foreach (var argument in function.Arguments)
        {
            var value = EvaluateNode(argument, entityValues, cellVoltages);
            if (!value.HasValue)
                return null;

            values.Add(value.Value);
        }

        return name switch
        {
            "min" when values.Count > 0 => values.Min(),
            "max" when values.Count > 0 => values.Max(),
            "avg" when values.Count > 0 => decimal.Round(values.Average(), 3),
            "count" => values.Count,
            "abs" when values.Count == 1 => decimal.Abs(values[0]),
            "exp" when values.Count == 1 => ConvertToDecimal(Math.Exp((double)values[0])),
            "ln" or "log" when values.Count == 1 && values[0] > 0 => ConvertToDecimal(Math.Log((double)values[0])),
            "pow" when values.Count == 2 => ConvertToDecimal(Math.Pow((double)values[0], (double)values[1])),
            "if" when values.Count == 3 => values[0] != 0 ? values[1] : values[2],
            _ => null
        };
    }

    private static decimal[]? ResolveArrayValues(
        IReadOnlyList<ExpressionNode> arguments,
        IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        if (arguments.Count != 1 || arguments[0] is not IdentifierNode identifier)
            return null;

        if (!string.Equals(identifier.Name, "cell_voltages", StringComparison.OrdinalIgnoreCase) ||
            cellVoltages is not { Count: > 0 })
        {
            return null;
        }

        return cellVoltages.Select(cell => cell.VoltageVolts).ToArray();
    }

    private static decimal? ConvertToDecimal(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
            return null;

        return (decimal)value;
    }

    private abstract record ExpressionNode;
    private sealed record NumberNode(decimal Value) : ExpressionNode;
    private sealed record IdentifierNode(string Name) : ExpressionNode;
    private sealed record UnaryNode(string Operator, ExpressionNode Operand) : ExpressionNode;
    private sealed record BinaryNode(ExpressionNode Left, string Operator, ExpressionNode Right) : ExpressionNode;
    private sealed record FunctionNode(string Name, IReadOnlyList<ExpressionNode> Arguments) : ExpressionNode;

    private sealed class Parser(string expression)
    {
        private readonly string _expression = expression;
        private int _index;

        public ExpressionNode ParseExpression() => ParseComparison();

        public void EnsureFullyConsumed()
        {
            SkipWhitespace();
            if (!IsAtEnd)
                throw new InvalidOperationException("Unexpected trailing expression content.");
        }

        private ExpressionNode ParseComparison()
        {
            var left = ParseAddSubtract();

            while (true)
            {
                SkipWhitespace();
                var op = MatchOperator("==", "!=", "<=", ">=", "<", ">");
                if (op is null)
                    break;

                var right = ParseAddSubtract();
                left = new BinaryNode(left, op, right);
            }

            return left;
        }

        private ExpressionNode ParseAddSubtract()
        {
            var left = ParseMultiplyDivide();

            while (true)
            {
                SkipWhitespace();
                var op = MatchOperator("+", "-");
                if (op is null)
                    break;

                var right = ParseMultiplyDivide();
                left = new BinaryNode(left, op, right);
            }

            return left;
        }

        private ExpressionNode ParseMultiplyDivide()
        {
            var left = ParseUnary();

            while (true)
            {
                SkipWhitespace();
                var op = MatchOperator("*", "/");
                if (op is null)
                    break;

                var right = ParseUnary();
                left = new BinaryNode(left, op, right);
            }

            return left;
        }

        private ExpressionNode ParseUnary()
        {
            SkipWhitespace();
            if (MatchOperator("-") is not null)
                return new UnaryNode("-", ParseUnary());

            if (MatchOperator("+") is not null)
                return new UnaryNode("+", ParseUnary());

            return ParsePrimary();
        }

        private ExpressionNode ParsePrimary()
        {
            SkipWhitespace();

            if (TryConsume('('))
            {
                var expression = ParseExpression();
                Expect(')');
                return expression;
            }

            if (TryParseNumber(out var number))
                return new NumberNode(number);

            var identifier = ParseIdentifier();
            SkipWhitespace();
            if (!TryConsume('('))
                return new IdentifierNode(identifier);

            var arguments = new List<ExpressionNode>();
            SkipWhitespace();
            if (!TryConsume(')'))
            {
                do
                {
                    arguments.Add(ParseExpression());
                    SkipWhitespace();
                }
                while (TryConsume(','));

                Expect(')');
            }

            return new FunctionNode(identifier, arguments);
        }

        private string ParseIdentifier()
        {
            SkipWhitespace();
            var start = _index;
            while (!IsAtEnd && (char.IsLetterOrDigit(Current) || Current is '_' or ':'))
                _index++;

            if (start == _index)
                throw new InvalidOperationException("Expected identifier.");

            return _expression[start.._index];
        }

        private bool TryParseNumber(out decimal number)
        {
            number = 0m;
            SkipWhitespace();
            var start = _index;
            var hasDigit = false;

            while (!IsAtEnd && (char.IsDigit(Current) || Current == '.'))
            {
                hasDigit |= char.IsDigit(Current);
                _index++;
            }

            if (!hasDigit)
                return false;

            var slice = _expression[start.._index];
            if (!decimal.TryParse(slice, NumberStyles.Number, CultureInfo.InvariantCulture, out number))
                throw new InvalidOperationException("Invalid number.");

            return true;
        }

        private string? MatchOperator(params string[] operators)
        {
            foreach (var op in operators.OrderByDescending(value => value.Length))
            {
                if (_index + op.Length > _expression.Length)
                    continue;

                if (string.Compare(_expression, _index, op, 0, op.Length, StringComparison.Ordinal) == 0)
                {
                    _index += op.Length;
                    return op;
                }
            }

            return null;
        }

        private void Expect(char expected)
        {
            SkipWhitespace();
            if (!TryConsume(expected))
                throw new InvalidOperationException($"Expected '{expected}'.");
        }

        private bool TryConsume(char value)
        {
            SkipWhitespace();
            if (IsAtEnd || Current != value)
                return false;

            _index++;
            return true;
        }

        private void SkipWhitespace()
        {
            while (!IsAtEnd && char.IsWhiteSpace(Current))
                _index++;
        }

        private bool IsAtEnd => _index >= _expression.Length;
        private char Current => _expression[_index];
    }
}
