using System.Text.RegularExpressions;
using FluxMonitor.Contracts.Status;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Evaluates simple expressions from device definition computed entities.
/// Supports: min(), max(), avg(), count() over cell arrays,
/// binary operators (+, -, *, /), comparisons (==, !=, &lt;, &gt;, &lt;=, &gt;=),
/// entity references by ID, and numeric literals.
/// </summary>
public sealed partial class ExpressionEvaluator
{
    /// <summary>
    /// Evaluate an expression against the current entity values.
    /// Returns a numeric result (for comparisons: 1.0 = true, 0.0 = false).
    /// Returns null if any referenced entity is unavailable.
    /// </summary>
    public decimal? Evaluate(string expression, IReadOnlyDictionary<string, decimal?> entityValues, IReadOnlyList<CellVoltageSnapshot>? cellVoltages)
    {
        var trimmed = expression.Trim();

        // Handle comparison operators (!=, ==, <=, >=, <, >)
        var comparisonMatch = ComparisonRegex().Match(trimmed);
        if (comparisonMatch.Success)
        {
            var left = Evaluate(comparisonMatch.Groups[1].Value, entityValues, cellVoltages);
            var right = Evaluate(comparisonMatch.Groups[3].Value, entityValues, cellVoltages);
            if (left is null || right is null) return null;

            return comparisonMatch.Groups[2].Value switch
            {
                "!=" => left.Value != right.Value ? 1m : 0m,
                "==" => left.Value == right.Value ? 1m : 0m,
                "<=" => left.Value <= right.Value ? 1m : 0m,
                ">=" => left.Value >= right.Value ? 1m : 0m,
                "<" => left.Value < right.Value ? 1m : 0m,
                ">" => left.Value > right.Value ? 1m : 0m,
                _ => null
            };
        }

        // Handle addition/subtraction (lowest precedence math)
        var addSubMatch = AddSubRegex().Match(trimmed);
        if (addSubMatch.Success)
        {
            var left = Evaluate(addSubMatch.Groups[1].Value, entityValues, cellVoltages);
            var right = Evaluate(addSubMatch.Groups[3].Value, entityValues, cellVoltages);
            if (left is null || right is null) return null;

            return addSubMatch.Groups[2].Value switch
            {
                "+" => left.Value + right.Value,
                "-" => left.Value - right.Value,
                _ => null
            };
        }

        // Handle multiplication/division
        var mulDivMatch = MulDivRegex().Match(trimmed);
        if (mulDivMatch.Success)
        {
            var left = Evaluate(mulDivMatch.Groups[1].Value, entityValues, cellVoltages);
            var right = Evaluate(mulDivMatch.Groups[3].Value, entityValues, cellVoltages);
            if (left is null || right is null) return null;

            return mulDivMatch.Groups[2].Value switch
            {
                "*" => left.Value * right.Value,
                "/" => right.Value != 0 ? left.Value / right.Value : null,
                _ => null
            };
        }

        // Handle function calls: min(), max(), avg(), count()
        var funcMatch = FunctionRegex().Match(trimmed);
        if (funcMatch.Success)
        {
            var funcName = funcMatch.Groups[1].Value.ToLowerInvariant();
            var arg = funcMatch.Groups[2].Value.Trim();

            // If the argument references the cell_voltages entity, use cell array
            if (cellVoltages is { Count: > 0 } && string.Equals(arg, "cell_voltages", StringComparison.OrdinalIgnoreCase))
            {
                var values = cellVoltages.Select(c => c.VoltageVolts).ToArray();
                return funcName switch
                {
                    "min" => values.Min(),
                    "max" => values.Max(),
                    "avg" => decimal.Round(values.Average(), 3),
                    "count" => values.Length,
                    _ => null
                };
            }

            return null; // Unknown function or unavailable data
        }

        // Numeric literal
        if (decimal.TryParse(trimmed, System.Globalization.NumberStyles.Any, System.Globalization.CultureInfo.InvariantCulture, out var number))
            return number;

        // Entity reference
        if (entityValues.TryGetValue(trimmed, out var entityVal))
            return entityVal;

        return null;
    }

    // Comparison: highest-level split (e.g., "balance_state != 0")
    [GeneratedRegex(@"^(.+?)\s*(!=|==|<=|>=|<|>)\s*(.+)$")]
    private static partial Regex ComparisonRegex();

    // Addition/subtraction: split on + or - not inside function calls
    // Matches the LAST + or - that isn't inside parentheses
    [GeneratedRegex(@"^(.+?)\s*(\+|-)\s*([^+\-]+)$")]
    private static partial Regex AddSubRegex();

    // Multiplication/division
    [GeneratedRegex(@"^(.+?)\s*(\*|/)\s*(.+)$")]
    private static partial Regex MulDivRegex();

    // Function call: name(argument)
    [GeneratedRegex(@"^(\w+)\(([^)]+)\)$")]
    private static partial Regex FunctionRegex();
}
