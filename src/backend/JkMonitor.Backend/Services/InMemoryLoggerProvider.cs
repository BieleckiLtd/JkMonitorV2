namespace JkMonitor.Backend.Services;

[ProviderAlias("InMemoryLog")]
public sealed class InMemoryLoggerProvider : ILoggerProvider
{
    private readonly InMemoryLogStore _store;

    public InMemoryLoggerProvider(InMemoryLogStore store)
    {
        _store = store;
    }

    public ILogger CreateLogger(string categoryName) => new InMemoryLogger(_store, categoryName);

    public void Dispose() { }

    private sealed class InMemoryLogger(InMemoryLogStore store, string category) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel))
            {
                return;
            }

            store.Add(
                DateTimeOffset.UtcNow,
                logLevel,
                category,
                formatter(state, exception),
                exception?.ToString());
        }
    }
}
