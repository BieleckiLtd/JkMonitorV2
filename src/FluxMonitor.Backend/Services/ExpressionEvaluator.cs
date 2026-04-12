using FluxMonitor.Contracts.Status;
using NCalc;
using NCalc.Handlers;

namespace FluxMonitor.Backend.Services;

/// <summary>
/// Evaluates definition-driven computed-entity expressions using NCalc.
/// Supports arithmetic, comparisons, standard math functions, and aggregate
/// functions (<c>min</c>, <c>max</c>, <c>avg</c>, <c>count</c>) over the
/// <c>cell_voltages</c> array.
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
            var ncalc = new Expression(expression,
                ExpressionOptions.DecimalAsDefault | ExpressionOptions.IgnoreCaseAtBuiltInFunctions);

            // Feed entity values as parameters.
            foreach (var (key, value) in entityValues)
            {
                if (value.HasValue)
                    ncalc.Parameters[key] = value.Value;
            }

            // Expose the cell voltages array so aggregate functions can detect it.
            if (cellVoltages is { Count: > 0 })
                ncalc.Parameters["cell_voltages"] = cellVoltages.Select(c => c.VoltageVolts).ToArray();

            ncalc.EvaluateFunction += (name, args) =>
                EvaluateCustomFunction(name, args);

            var result = ncalc.Evaluate();
            return result switch
            {
                decimal d => d,
                double d when !double.IsNaN(d) && !double.IsInfinity(d) => (decimal)d,
                float f when !float.IsNaN(f) && !float.IsInfinity(f) => (decimal)f,
                int i => i,
                long l => l,
                bool b => b ? 1m : 0m,
                _ => null
            };
        }
        catch
        {
            return null;
        }
    }

    private static void EvaluateCustomFunction(string name, FunctionArgs args)
    {
        var lower = name.ToLowerInvariant();

        // Array aggregates: min/max/avg/count with a single array argument.
        if (lower is "min" or "max" or "avg" or "count"
            && args.Parameters.Length == 1)
        {
            var evaluated = args.Parameters[0].Evaluate();
            if (evaluated is decimal[] values && values.Length > 0)
            {
                args.Result = lower switch
                {
                    "min" => values.Min(),
                    "max" => values.Max(),
                    "avg" => decimal.Round(values.Average(), 3),
                    "count" => (decimal)values.Length,
                    _ => 0m
                };
                return;
            }
            // Not an array — fall through to NCalc built-in Min(a,b) / Max(a,b).
        }

        // ln(x) — NCalc has Log(value, base) but not a bare ln().
        if (lower == "ln" && args.Parameters.Length == 1)
        {
            var val = Convert.ToDouble(args.Parameters[0].Evaluate());
            if (val > 0)
                args.Result = (decimal)Math.Log(val);
        }

        // exp(x) override to keep result as decimal
        if (lower == "exp" && args.Parameters.Length == 1)
        {
            var val = Convert.ToDouble(args.Parameters[0].Evaluate());
            args.Result = (decimal)Math.Exp(val);
        }
    }
}
