namespace FluxMonitor.Backend.Services;

/// <summary>
/// Lightweight signal that lets external callers (e.g. write endpoints)
/// wake the polling loop so the next poll happens immediately.
/// </summary>
public sealed class PollTrigger
{
    private CancellationTokenSource _cts = new();

    /// <summary>
    /// Signal all waiting poll loops to run their next cycle immediately.
    /// </summary>
    public void Signal()
    {
        var old = Interlocked.Exchange(ref _cts, new CancellationTokenSource());
        old.Cancel();
        old.Dispose();
    }

    /// <summary>
    /// Returns a token that cancels when <see cref="Signal"/> is called.
    /// Each call returns a token tied to the current generation;
    /// after a signal fires the next call gets a fresh token.
    /// </summary>
    public CancellationToken GetToken() => _cts.Token;
}
