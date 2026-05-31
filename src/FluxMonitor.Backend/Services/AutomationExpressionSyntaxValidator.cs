using System.Text.RegularExpressions;
using NCalc;

namespace FluxMonitor.Backend.Services;

public static class AutomationExpressionSyntaxValidator
{
    private static readonly Regex AndRegex = new(@"\bAND\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex OrRegex = new(@"\bOR\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex NotRegex = new(@"\bNOT\b", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex EqualityRegex = new(@"(?<![<>=!])=(?!=)", RegexOptions.Compiled);
    private static readonly Regex LeadingIfRegex = new(@"^\s*IF\s*:?\s*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TokenRegex = new(@"(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)+)(?![A-Za-z0-9_])", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static bool TryValidate(string? rawExpression, out string error)
    {
        if (string.IsNullOrWhiteSpace(rawExpression))
        {
            error = "Expression is required.";
            return false;
        }

        var normalizedExpression = NormalizeExpressionText(rawExpression);
        var expressionText = normalizedExpression;
        var parameters = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);

        foreach (var token in TokenRegex.Matches(normalizedExpression)
                     .Select(match => match.Groups[1].Value)
                     .Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var safeName = ToSafeParameterName(token);
            expressionText = ReplaceToken(expressionText, token, safeName);
            parameters[safeName] = 0d;
        }

        try
        {
            var expression = new Expression(
                expressionText,
                ExpressionOptions.AllowNullParameter | ExpressionOptions.IgnoreCaseAtBuiltInFunctions);

            foreach (var (key, value) in parameters)
            {
                expression.Parameters[key] = value;
            }

            _ = expression.Evaluate();
            error = string.Empty;
            return true;
        }
        catch (Exception exception)
        {
            error = exception.Message;
            return false;
        }
    }

    internal static string NormalizeExpressionText(string expression)
    {
        var normalized = expression.Trim();
        normalized = LeadingIfRegex.Replace(normalized, string.Empty);
        var thenIndex = normalized.IndexOf("THEN:", StringComparison.OrdinalIgnoreCase);
        if (thenIndex >= 0)
            normalized = normalized[..thenIndex].Trim();

        normalized = AndRegex.Replace(normalized, "&&");
        normalized = OrRegex.Replace(normalized, "||");
        normalized = NotRegex.Replace(normalized, "!");
        normalized = EqualityRegex.Replace(normalized, "==");
        return normalized;
    }

    internal static string ReplaceToken(string expression, string token, string safeName)
        => Regex.Replace(
            expression,
            $@"(?<![A-Za-z0-9_]){Regex.Escape(token)}(?![A-Za-z0-9_])",
            safeName,
            RegexOptions.IgnoreCase);

    internal static string ToSafeParameterName(string token)
        => "p_" + Regex.Replace(token, @"[^A-Za-z0-9_]", "_");
}