#:property PublishAot=false
#:property TargetFramework=net10.0-windows10.0.19041.0
#nullable enable

using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Numerics;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Storage.Streams;

Console.OutputEncoding = Encoding.UTF8;

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

return await ProgramEntry.RunAsync(args, cts.Token);

// ---------------------------------------------------------------------------
//  Entry point
// ---------------------------------------------------------------------------

static class ProgramEntry
{
    public static async Task<int> RunAsync(string[] args, CancellationToken ct)
    {
        Options opts;
        try { opts = Options.Parse(args); }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.WriteLine();
            Options.PrintHelp(Console.Error);
            return 1;
        }

        if (opts.ShowHelp) { Options.PrintHelp(Console.Out); return 0; }

        var radio = await BluetoothAdapter.GetDefaultAsync().AsTask().WaitAsync(ct);
        if (radio is null || !radio.IsLowEnergySupported)
        {
            Console.Error.WriteLine("Bluetooth LE is unavailable on this machine.");
            return 1;
        }

        try
        {
            var target = await Discovery.ResolveAsync(opts, ct);
            await new JkMonitor(target, opts).RunAsync(ct);
            return 0;
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            Console.WriteLine("\nStopped.");
            return 1;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"\nError: {ex.Message}");
            return 1;
        }
    }
}

// ---------------------------------------------------------------------------
//  Discovery: concurrent scan + probe using WinRT (active scanning)
// ---------------------------------------------------------------------------

static class Discovery
{
    private static bool _screenInit;

    public static async Task<ulong> ResolveAsync(Options opts, CancellationToken ct)
    {
        if (!string.IsNullOrWhiteSpace(opts.Address))
            return await ResolveByAddressAsync(opts, ct);

        return await DiscoverAndProbeAsync(opts, ct);
    }

    private static async Task<ulong> ResolveByAddressAsync(Options opts, CancellationToken ct)
    {
        var devices = new ConcurrentDictionary<ulong, Candidate>();
        var sw = Stopwatch.StartNew();

        var watcher = CreateWatcher();
        watcher.Received += (_, args) =>
            devices.AddOrUpdate(args.BluetoothAddress,
                _ => new Candidate(args), (_, c) => { c.Update(args); return c; });

        watcher.Start();
        try
        {
            while (sw.Elapsed < opts.ScanTimeout)
            {
                Render("Scanning", sw.Elapsed, opts, devices.Count, 0,
                    null, [], $"Scanning for {opts.Address}");
                await Task.Delay(200, ct);
            }
        }
        finally { watcher.Stop(); }

        var matched = devices.Values.FirstOrDefault(c => c.MatchesId(opts.Address!));
        return matched?.Address
            ?? throw new InvalidOperationException(
                $"No BLE device matched '{opts.Address}'. Run without an address to inspect discovered devices.");
    }

    private static async Task<ulong> DiscoverAndProbeAsync(Options opts, CancellationToken ct)
    {
        var devices = new ConcurrentDictionary<ulong, Candidate>();
        var confirmed = new List<Candidate>();
        var attempted = new HashSet<ulong>();
        var sw = Stopwatch.StartNew();

        var watcher = CreateWatcher();
        watcher.Received += (_, args) =>
            devices.AddOrUpdate(args.BluetoothAddress,
                _ => new Candidate(args), (_, c) => { c.Update(args); return c; });

        watcher.Start();
        var scannerActive = true;

        try
        {
            Task<(bool Confirmed, string Status)>? probeTask = null;
            Candidate? probeCandidate = null;
            var status = $"Scanning for up to {opts.ScanTimeout.TotalSeconds:F0}s";

            while (!ct.IsCancellationRequested)
            {
                if (scannerActive && sw.Elapsed >= opts.ScanTimeout)
                {
                    watcher.Stop();
                    scannerActive = false;
                    if (status.StartsWith("Scanning for up to", StringComparison.Ordinal))
                        status = "Scan complete. Finishing probes.";
                }

                if (probeTask is null)
                {
                    var budget = opts.ProbeLimit > 0 ? Math.Max(opts.ProbeLimit - attempted.Count, 0) : int.MaxValue;
                    var next = budget > 0
                        ? devices.Values
                            .Where(c => !attempted.Contains(c.Address))
                            .OrderByDescending(c => c.IsLikelyJk ? 1 : 0)
                            .ThenByDescending(c => c.Rssi)
                            .FirstOrDefault()
                        : null;

                    if (next is not null)
                    {
                        attempted.Add(next.Address);
                        probeCandidate = next;
                        status = $"Probing {next.DisplayName} ({Fmt.Addr(next.Address)})";
                        probeTask = ProbeAsync(next.Address, opts, ct);
                    }
                }

                if (probeTask is { IsCompleted: true })
                {
                    var (ok, msg) = await probeTask;
                    status = msg;
                    if (ok && probeCandidate is not null)
                        confirmed.Add(probeCandidate);
                    probeTask = null;
                    probeCandidate = null;
                }

                Render(scannerActive ? "Scanning" : "Finishing", sw.Elapsed, opts,
                    devices.Count, attempted.Count, probeCandidate, confirmed, status);

                if (!scannerActive && probeTask is null &&
                    !devices.Values.Any(c => !attempted.Contains(c.Address)))
                    break;

                await Task.Delay(200, ct);
            }
        }
        finally { if (scannerActive) watcher.Stop(); }

        if (confirmed.Count == 0)
            throw new InvalidOperationException(
                "No scanned BLE device exposed the JK FFE0/FFE1 service pair. " +
                "If the BMS is nearby, it is not visible to the local BLE stack as a JK-compatible GATT device.");

        Render("Selection", sw.Elapsed, opts, devices.Count, attempted.Count,
            null, confirmed, "Choose a confirmed JK BMS.");

        return ChooseCandidate(confirmed).Address;
    }

    private static async Task<(bool Confirmed, string Status)> ProbeAsync(
        ulong address, Options opts, CancellationToken ct)
    {
        var addrStr = Fmt.Addr(address);
        var last = $"No JK service on {addrStr}.";

        for (var attempt = 1; attempt <= opts.ProbeAttempts; attempt++)
        {
            BluetoothLEDevice? device = null;
            try
            {
                device = await BluetoothLEDevice.FromBluetoothAddressAsync(address)
                    .AsTask().WaitAsync(opts.ProbeTimeout, ct);
                if (device is null) return (false, $"Could not connect to {addrStr}");

                var result = await device.GetGattServicesForUuidAsync(JkProtocol.ServiceUuid)
                    .AsTask().WaitAsync(opts.ProbeTimeout, ct);
                if (result.Status != GattCommunicationStatus.Success || result.Services.Count == 0)
                    return (false, $"No JK service on {addrStr}");

                var charsResult = await result.Services[0].GetCharacteristicsAsync()
                    .AsTask().WaitAsync(opts.ProbeTimeout, ct);
                if (charsResult.Status == GattCommunicationStatus.Success &&
                    charsResult.Characteristics.Any(c => c.Uuid == JkProtocol.CharacteristicUuid))
                    return (true, $"JK service confirmed on {addrStr}");

                return (false, $"No JK characteristic on {addrStr}");
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                last = $"Probe timed out for {addrStr} [{attempt}/{opts.ProbeAttempts}]";
            }
            catch (Exception ex)
            {
                last = $"Probe failed for {addrStr} [{attempt}/{opts.ProbeAttempts}]: {ex.Message}";
            }
            finally { device?.Dispose(); }

            if (attempt < opts.ProbeAttempts)
                await Task.Delay(1500, ct);
        }

        return (false, last);
    }

    private static Candidate ChooseCandidate(IReadOnlyList<Candidate> candidates)
    {
        if (candidates.Count == 1) return candidates[0];

        Console.WriteLine();
        Console.WriteLine("Multiple JK BMS devices confirmed. Choose one:");
        Console.WriteLine();
        PrintTable(candidates);

        if (Console.IsInputRedirected) return candidates[0];

        while (true)
        {
            Console.Write($"Select [1-{candidates.Count}]: ");
            var line = Console.ReadLine()?.Trim();
            if (int.TryParse(line, NumberStyles.None, CultureInfo.InvariantCulture, out var i) &&
                i >= 1 && i <= candidates.Count)
                return candidates[i - 1];
            Console.WriteLine("Invalid selection.");
        }
    }

    private static BluetoothLEAdvertisementWatcher CreateWatcher() => new()
    {
        ScanningMode = BluetoothLEScanningMode.Active,
    };

    private static void Render(
        string stage, TimeSpan elapsed, Options opts, int discovered, int probed,
        Candidate? current, IReadOnlyList<Candidate> confirmed, string status)
    {
        ClearScreen();
        Console.WriteLine("JK BMS discovery. Press Ctrl+C to stop.");
        Console.WriteLine();
        Console.WriteLine($"{"Stage",-18}: {stage}");
        Console.WriteLine($"{"Scan timeout",-18}: {opts.ScanTimeout.TotalSeconds:F1}s");
        Console.WriteLine($"{"Elapsed",-18}: {elapsed.TotalSeconds:F1}s");
        Console.WriteLine($"{"Discovered BLE",-18}: {discovered}");
        Console.WriteLine($"{"Probed",-18}: {probed}");
        if (current is not null)
        {
            Console.WriteLine($"{"Candidate",-18}: {current.DisplayName}");
            Console.WriteLine($"{"Address",-18}: {Fmt.Addr(current.Address)}");
            Console.WriteLine($"{"RSSI",-18}: {Fmt.Rssi(current.Rssi)}");
        }
        Console.WriteLine($"{"Status",-18}: {status}");
        Console.WriteLine();
        Console.WriteLine("Confirmed JK BMS devices");
        Console.WriteLine("------------------------");

        if (confirmed.Count == 0) { Console.WriteLine("None yet."); return; }
        PrintTable(confirmed);
    }

    private static void PrintTable(IReadOnlyList<Candidate> list)
    {
        Console.WriteLine($"{"#",-3} {"Name",-24} {"Address",-20} {"RSSI",-9} Advertised services");
        Console.WriteLine(new string('-', 96));
        for (var i = 0; i < list.Count; i++)
        {
            var c = list[i];
            var svcs = c.ServiceUuids.Count == 0 ? "-" : string.Join(", ", c.ServiceUuids.Take(4));
            Console.WriteLine(
                $"{i + 1,-3} {Fmt.Trunc(c.DisplayName, 24),-24} {Fmt.Addr(c.Address),-20} {Fmt.Rssi(c.Rssi),-9} {svcs}");
        }
    }

    private static void ClearScreen()
    {
        if (!_screenInit) { Console.Write("\u001b[2J\u001b[H"); _screenInit = true; }
        else Console.Write("\u001b[H\u001b[J");
    }
}

// ---------------------------------------------------------------------------
//  Candidate (lightweight, thread-safe)
// ---------------------------------------------------------------------------

sealed class Candidate(BluetoothLEAdvertisementReceivedEventArgs args)
{
    private readonly object _lock = new();

    public ulong Address { get; } = args.BluetoothAddress;
    public string DisplayName { get; private set; } = SafeName(args);
    public short Rssi { get; private set; } = args.RawSignalStrengthInDBm;
    public HashSet<string> ServiceUuids { get; } = new(
        args.Advertisement.ServiceUuids.Select(u => u.ToString()), StringComparer.OrdinalIgnoreCase);

    public bool IsLikelyJk
    {
        get
        {
            lock (_lock)
                return ServiceUuids.Contains(JkProtocol.ServiceUuid.ToString()) ||
                       DisplayName.Contains("jk", StringComparison.OrdinalIgnoreCase) ||
                       DisplayName.Contains("bms", StringComparison.OrdinalIgnoreCase);
        }
    }

    public void Update(BluetoothLEAdvertisementReceivedEventArgs a)
    {
        lock (_lock)
        {
            var name = SafeName(a);
            if (!string.IsNullOrWhiteSpace(name) && name != "<unknown>") DisplayName = name;
            Rssi = a.RawSignalStrengthInDBm;
            foreach (var u in a.Advertisement.ServiceUuids) ServiceUuids.Add(u.ToString());
        }
    }

    public bool MatchesId(string id)
    {
        var target = id.Trim().Replace(":", "").Replace("-", "");
        var myAddr = Fmt.Addr(Address).Replace(":", "");
        return string.Equals(myAddr, target, StringComparison.OrdinalIgnoreCase) ||
               DisplayName.Contains(id.Trim(), StringComparison.OrdinalIgnoreCase);
    }

    private static string SafeName(BluetoothLEAdvertisementReceivedEventArgs a) =>
        string.IsNullOrWhiteSpace(a.Advertisement.LocalName) ? "<unknown>" : a.Advertisement.LocalName.Trim();
}

// ---------------------------------------------------------------------------
//  Options
// ---------------------------------------------------------------------------

sealed record Options(
    string? Address,
    TimeSpan LiveInterval,
    TimeSpan ScanTimeout,
    TimeSpan ProbeTimeout,
    TimeSpan ConnectTimeout,
    int ProbeLimit,
    int ProbeAttempts,
    int ConnectAttempts,
    bool RawOutput,
    bool ShowHelp)
{
    public static Options Parse(string[] args)
    {
        string? address = null;
        double liveS = 0, scanS = 8, probeS = 8, connS = 20;
        int probeLimit = 0, probeAttempts = 3, connAttempts = 3;
        bool raw = false, help = false;

        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "-h" or "--help": help = true; break;
                case "--raw": raw = true; break;
                case "--live-interval": liveS = ReadDouble(args, ref i); break;
                case "--scan-timeout": scanS = ReadDouble(args, ref i); break;
                case "--probe-timeout": probeS = ReadDouble(args, ref i); break;
                case "--connect-timeout": connS = ReadDouble(args, ref i); break;
                case "--probe-limit": probeLimit = ReadInt(args, ref i); break;
                case "--probe-attempts": probeAttempts = ReadInt(args, ref i); break;
                case "--connect-attempts": connAttempts = ReadInt(args, ref i); break;
                default:
                    if (args[i].StartsWith("--", StringComparison.Ordinal))
                        throw new ArgumentException($"Unknown argument '{args[i]}'.");
                    if (address is not null)
                        throw new ArgumentException($"Unexpected positional argument '{args[i]}'.");
                    address = args[i];
                    break;
            }
        }

        return new(address,
            TimeSpan.FromSeconds(Math.Max(liveS, 0)),
            TimeSpan.FromSeconds(Math.Max(scanS, 1)),
            TimeSpan.FromSeconds(Math.Max(probeS, 2)),
            TimeSpan.FromSeconds(Math.Max(connS, 2)),
            Math.Max(probeLimit, 0),
            Math.Max(probeAttempts, 1),
            Math.Max(connAttempts, 1),
            raw, help);
    }

    public static void PrintHelp(TextWriter w)
    {
        w.WriteLine("JK BMS BLE monitor (.NET 10 file-based app, WinRT BLE)");
        w.WriteLine();
        w.WriteLine("Usage:  dotnet run --file \"Docs/jk ble/jk.cs\" -- [address] [options]");
        w.WriteLine();
        w.WriteLine("  --live-interval <s>    Seconds between 0x96 re-requests (default 0)");
        w.WriteLine("  --scan-timeout <s>     Scan duration when no address given (default 8)");
        w.WriteLine("  --probe-timeout <s>    Per-candidate probe timeout (default 8)");
        w.WriteLine("  --connect-timeout <s>  Connect timeout for final session (default 20)");
        w.WriteLine("  --probe-limit <n>      Max candidates to probe, 0 = all (default 0)");
        w.WriteLine("  --probe-attempts <n>   Probe retries per candidate (default 3)");
        w.WriteLine("  --connect-attempts <n> Session connect retries (default 3)");
        w.WriteLine("  --raw                  Raw RX/TX hex instead of dashboard");
        w.WriteLine("  -h, --help             Show this help");
    }

    private static double ReadDouble(string[] a, ref int i)
    {
        var flag = a[i];
        if (++i >= a.Length) throw new ArgumentException($"Missing value for '{flag}'.");
        if (!double.TryParse(a[i], NumberStyles.Float | NumberStyles.AllowThousands, CultureInfo.InvariantCulture, out var v))
            throw new ArgumentException($"Invalid value '{a[i]}' for '{flag}'.");
        return v;
    }

    private static int ReadInt(string[] a, ref int i)
    {
        var flag = a[i];
        if (++i >= a.Length) throw new ArgumentException($"Missing value for '{flag}'.");
        if (!int.TryParse(a[i], NumberStyles.Integer, CultureInfo.InvariantCulture, out var v))
            throw new ArgumentException($"Invalid value '{a[i]}' for '{flag}'.");
        return v;
    }
}

// ---------------------------------------------------------------------------
//  Shared formatting helpers
// ---------------------------------------------------------------------------

static class Fmt
{
    public static string Addr(ulong addr) =>
        string.Join(":", Enumerable.Range(0, 6).Select(i => ((addr >> ((5 - i) * 8)) & 0xFF).ToString("X2")));

    public static string Rssi(short v) => $"{v} dBm";
    public static string Trunc(string v, int len) => v.Length <= len ? v : v[..Math.Max(len - 1, 1)] + "\u2026";
    public static string Ts(DateTimeOffset? v) => v?.LocalDateTime.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture) ?? "n/a";
    public static string TsNow() => DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture);

    public static string Age(DateTimeOffset? v)
    {
        if (v is null) return "n/a";
        return $"{Math.Max((int)(DateTimeOffset.Now - v.Value).TotalSeconds, 0)}s ago";
    }

    public static string Hex(ReadOnlySpan<byte> data) =>
        string.Join(" ", data.ToArray().Select(b => b.ToString("X2", CultureInfo.InvariantCulture)));

    public static string HexDump(ReadOnlySpan<byte> data, int width = 16)
    {
        var sb = new StringBuilder();
        for (var off = 0; off < data.Length; off += width)
        {
            var chunk = data.Slice(off, Math.Min(width, data.Length - off));
            var hex = string.Join(" ", chunk.ToArray().Select(b => b.ToString("X2", CultureInfo.InvariantCulture)));
            var ascii = new string(chunk.ToArray().Select(b => b is >= 32 and <= 126 ? (char)b : '.').ToArray());
            sb.AppendFormat(CultureInfo.InvariantCulture, "{0:X4}  {1,-48}  {2}", off, hex, ascii).AppendLine();
        }
        return sb.ToString().TrimEnd();
    }

    public static string Rows(string title, IReadOnlyList<KeyValuePair<string, string>> rows)
    {
        var sb = new StringBuilder();
        sb.AppendLine(title).AppendLine(new string('-', title.Length));
        foreach (var r in rows)
            sb.AppendFormat(CultureInfo.InvariantCulture, "{0,-22}: {1}", r.Key, r.Value).AppendLine();
        return sb.ToString().TrimEnd();
    }

    public static string Runtime(uint seconds)
    {
        var span = TimeSpan.FromSeconds(seconds);
        if (span.TotalDays >= 1) return $"{(int)span.TotalDays}d {span.Hours:00}h {span.Minutes:00}m {span.Seconds:00}s";
        if (span.TotalHours >= 1) return $"{(int)span.TotalHours}h {span.Minutes:00}m {span.Seconds:00}s";
        if (span.TotalMinutes >= 1) return $"{(int)span.TotalMinutes}m {span.Seconds:00}s";
        return $"{span.Seconds}s";
    }

    public static string Temp(double v) => v <= -199.0 ? "n/a" : $"{v:F1} C";
}

// ---------------------------------------------------------------------------
//  JK Monitor (live BMS session using WinRT GATT)
// ---------------------------------------------------------------------------

sealed class JkMonitor
{
    private readonly ulong _address;
    private readonly Options _opts;
    private readonly object _sync = new();
    private readonly List<byte> _buffer = [];

    private TaskCompletionSource _disconnectTcs = NewTcs();
    private bool _screenInit;
    private string _connState = "Idle";
    private string _status = "Waiting to connect";
    private DateTimeOffset? _statusAt;
    private DateTimeOffset? _lastTxAt;
    private string _lastTx = "n/a";
    private DateTimeOffset? _lastRxAt;
    private string _lastRx = "n/a";
    private DateTimeOffset? _lastFrameAt;
    private string _lastFrameInfo = "n/a";
    private string _liveScreen = "Waiting for first live frame...";
    private string _infoScreen = string.Empty;
    private string _settingsScreen = string.Empty;
    private string? _infoSig;
    private string? _settingsSig;
    private int _rxChunks;
    private int _frames;
    private int _liveFrames;
    private int _infoFrames;
    private int _settingsFrames;
    private int _crcErrors;
    private string _lastError = string.Empty;

    public JkMonitor(ulong address, Options opts)
    {
        _address = address;
        _opts = opts;
    }

    public async Task RunAsync(CancellationToken ct)
    {
        Exception? lastEx = null;
        var failures = 0;

        while (!ct.IsCancellationRequested)
        {
            var attempt = failures + 1;
            BluetoothLEDevice? device = null;
            GattCharacteristic? notifyCh = null;

            try
            {
                _disconnectTcs = NewTcs();
                lock (_sync) { _connState = $"Connecting ({attempt}/{_opts.ConnectAttempts})"; SetStatus($"Connecting to {Fmt.Addr(_address)}"); }

                device = await BluetoothLEDevice.FromBluetoothAddressAsync(_address)
                    .AsTask().WaitAsync(_opts.ConnectTimeout, ct)
                    ?? throw new InvalidOperationException($"Could not open BLE device {Fmt.Addr(_address)}");

                device.ConnectionStatusChanged += OnConnectionStatusChanged;

                var svcResult = await device.GetGattServicesForUuidAsync(JkProtocol.ServiceUuid)
                    .AsTask().WaitAsync(_opts.ConnectTimeout, ct);
                if (svcResult.Status != GattCommunicationStatus.Success || svcResult.Services.Count == 0)
                    throw new InvalidOperationException($"FFE0 service not found (status={svcResult.Status})");

                var charsResult = await svcResult.Services[0].GetCharacteristicsAsync()
                    .AsTask().WaitAsync(_opts.ConnectTimeout, ct);
                if (charsResult.Status != GattCommunicationStatus.Success)
                    throw new InvalidOperationException($"Failed to enumerate characteristics (status={charsResult.Status})");

                GattCharacteristic? writeCh = null;
                foreach (var c in charsResult.Characteristics)
                {
                    if (c.Uuid != JkProtocol.CharacteristicUuid) continue;
                    if (notifyCh is null && c.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Notify))
                        notifyCh = c;
                    if (writeCh is null &&
                        (c.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Write) ||
                         c.CharacteristicProperties.HasFlag(GattCharacteristicProperties.WriteWithoutResponse)))
                        writeCh = c;
                }

                if (notifyCh is null) throw new InvalidOperationException("Notify characteristic FFE1 not found.");
                writeCh ??= (notifyCh.CharacteristicProperties.HasFlag(GattCharacteristicProperties.Write) ||
                             notifyCh.CharacteristicProperties.HasFlag(GattCharacteristicProperties.WriteWithoutResponse))
                    ? notifyCh
                    : throw new InvalidOperationException("No writable JK characteristic.");

                failures = 0;
                lock (_sync) { _connState = "Connected"; SetStatus($"Notify & write on {notifyCh.Uuid}"); }

                notifyCh.ValueChanged += OnNotification;
                var cccd = await notifyCh.WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue.Notify)
                    .AsTask().WaitAsync(_opts.ConnectTimeout, ct);
                if (cccd != GattCommunicationStatus.Success)
                    throw new InvalidOperationException($"Failed to enable notifications (status={cccd})");

                lock (_sync) SetStatus("Notifications enabled");

                await SendAsync(writeCh, JkProtocol.InfoCommand, ct);
                await Task.Delay(TimeSpan.FromSeconds(1), ct);
                await SendAsync(writeCh, JkProtocol.LiveCommand, ct);
                lock (_sync) SetStatus("Initial live stream request sent");

                await WaitForSessionAsync(writeCh, ct);
                return;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                lock (_sync) { _connState = "Stopped"; SetStatus("Stopped"); }
                return;
            }
            catch (Exception ex)
            {
                lastEx = ex;
                failures++;
                lock (_sync)
                {
                    _connState = $"Retrying ({failures}/{_opts.ConnectAttempts})";
                    _lastError = $"{ex.GetType().Name}: {ex.Message}";
                    SetStatus($"Attempt {attempt} failed");
                }
                if (failures >= _opts.ConnectAttempts) break;
                await Task.Delay(TimeSpan.FromSeconds(2), ct);
            }
            finally
            {
                if (notifyCh is not null) notifyCh.ValueChanged -= OnNotification;
                if (device is not null) { device.ConnectionStatusChanged -= OnConnectionStatusChanged; device.Dispose(); }
            }
        }

        lock (_sync) _connState = "Failed";
        throw new InvalidOperationException(
            $"Failed to connect to {Fmt.Addr(_address)} after {_opts.ConnectAttempts} attempts: {lastEx?.Message}");
    }

    private void OnConnectionStatusChanged(BluetoothLEDevice sender, object _)
    {
        if (sender.ConnectionStatus != BluetoothConnectionStatus.Disconnected) return;
        lock (_sync)
        {
            _connState = "Disconnected";
            _lastError = "BLE connection lost.";
            SetStatus("Disconnected, waiting to reconnect");
            _disconnectTcs.TrySetResult();
        }
    }

    private async Task WaitForSessionAsync(GattCharacteristic writeCh, CancellationToken ct)
    {
        if (_opts.LiveInterval > TimeSpan.Zero)
        {
            while (!ct.IsCancellationRequested)
            {
                var done = await Task.WhenAny(_disconnectTcs.Task, Task.Delay(_opts.LiveInterval, ct));
                if (done == _disconnectTcs.Task)
                    throw new InvalidOperationException("BLE connection lost");
                await SendAsync(writeCh, JkProtocol.LiveCommand, ct);
            }
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            if (_disconnectTcs.Task.IsCompleted) throw new InvalidOperationException("BLE connection lost");
            await Task.Delay(500, ct);
        }
    }

    private async Task SendAsync(GattCharacteristic writeCh, byte command, CancellationToken ct)
    {
        var payload = JkProtocol.BuildRequest(command);
        var now = DateTimeOffset.Now;
        lock (_sync)
        {
            _lastTxAt = now;
            _lastTx = $"command=0x{command:X2} len={payload.Length} at {Fmt.Ts(now)} ({Fmt.Age(now)})";
            if (_opts.RawOutput) { Console.WriteLine($"[{Fmt.TsNow()}] TX command=0x{command:X2} len={payload.Length}"); Console.WriteLine(Fmt.Hex(payload)); }
            else Render();
        }

        var writeOption = writeCh.CharacteristicProperties.HasFlag(GattCharacteristicProperties.WriteWithoutResponse)
            ? GattWriteOption.WriteWithoutResponse
            : GattWriteOption.WriteWithResponse;
        var result = await writeCh.WriteValueAsync(payload.AsBuffer(), writeOption)
            .AsTask().WaitAsync(_opts.ConnectTimeout, ct);
        if (result != GattCommunicationStatus.Success)
            throw new InvalidOperationException($"Write failed (status={result})");
    }

    private void OnNotification(GattCharacteristic sender, GattValueChangedEventArgs e)
    {
        lock (_sync)
        {
            var chunk = new byte[e.CharacteristicValue.Length];
            DataReader.FromBuffer(e.CharacteristicValue).ReadBytes(chunk);

            var now = DateTimeOffset.Now;
            _rxChunks++;
            _lastRxAt = now;
            _lastRx = $"uuid={sender.Uuid} len={chunk.Length} at {Fmt.Ts(now)} ({Fmt.Age(now)})";

            if (_opts.RawOutput)
            {
                Console.WriteLine($"[{Fmt.TsNow()}] RX chunk uuid={sender.Uuid} len={chunk.Length}");
                Console.WriteLine(Fmt.Hex(chunk));
            }

            if (chunk.AsSpan().StartsWith(JkProtocol.FramePreamble)) _buffer.Clear();
            _buffer.AddRange(chunk);

            while (_buffer.Count >= JkProtocol.FrameSize)
            {
                var frame = _buffer.Take(JkProtocol.FrameSize).ToArray();
                _buffer.RemoveRange(0, JkProtocol.FrameSize);

                if (!frame.AsSpan(0, JkProtocol.FramePreamble.Length).SequenceEqual(JkProtocol.FramePreamble))
                {
                    var idx = FindPreamble(frame, 1);
                    if (idx >= 0) _buffer.InsertRange(0, frame[idx..]);
                    else _buffer.Clear();
                    continue;
                }

                var crc = JkProtocol.Crc8Sum(frame.AsSpan(0, frame.Length - 1));
                if (crc != frame[^1])
                {
                    _crcErrors++;
                    _lastError = $"CRC mismatch: computed=0x{crc:X2} remote=0x{frame[^1]:X2}";
                    if (_opts.RawOutput) Console.WriteLine($"[{Fmt.TsNow()}] CRC mismatch: 0x{crc:X2} vs 0x{frame[^1]:X2}");
                    else Render();
                    continue;
                }

                HandleFrame(frame);
            }
        }
    }

    private void HandleFrame(byte[] frame)
    {
        _frames++;
        var now = DateTimeOffset.Now;
        _lastFrameAt = now;
        var decoded = JkProtocol.DecodeFrame(frame);
        _lastFrameInfo = $"{decoded.Title} at {Fmt.Ts(now)} ({Fmt.Age(now)})";

        switch (frame[4])
        {
            case 0x01:
                _settingsFrames++;
                var sSig = string.Join('\u001f', decoded.Rows.Select(r => $"{r.Key}={r.Value}"));
                if (sSig != _settingsSig) { _settingsSig = sSig; _settingsScreen = Fmt.Rows($"Pretty Decode: {decoded.Title}", decoded.Rows); }
                break;
            case 0x02:
                _liveFrames++;
                _liveScreen = Fmt.Rows($"Pretty Decode: {decoded.Title}", decoded.Rows);
                break;
            case 0x03:
                _infoFrames++;
                var iSig = string.Join('\u001f', decoded.Rows.Select(r => $"{r.Key}={r.Value}"));
                if (iSig != _infoSig) { _infoSig = iSig; _infoScreen = Fmt.Rows($"Pretty Decode: {decoded.Title}", decoded.Rows); }
                break;
        }

        if (_opts.RawOutput)
        {
            Console.WriteLine();
            Console.WriteLine($"Assembled Frame type=0x{frame[4]:X2} len={frame.Length} crc=0x{frame[^1]:X2}");
            Console.WriteLine(Fmt.HexDump(frame));
            Console.WriteLine();
            Console.WriteLine(Fmt.Rows($"Pretty Decode: {decoded.Title}", decoded.Rows));
        }
        else Render();
    }

    private void SetStatus(string msg) { _status = msg; _statusAt = DateTimeOffset.Now; if (!_opts.RawOutput) Render(); }

    private void Render()
    {
        if (!_screenInit) { Console.Write("\u001b[2J\u001b[H"); _screenInit = true; }
        else Console.Write("\u001b[H\u001b[J");

        Console.WriteLine("JK BMS live monitor. Press Ctrl+C to stop.");
        Console.WriteLine();
        Console.WriteLine($"{"Target",-18}: {Fmt.Addr(_address)}");
        Console.WriteLine($"{"State",-18}: {_connState}");
        Console.WriteLine($"{"Live interval",-18}: {_opts.LiveInterval.TotalSeconds:F1}s");
        Console.WriteLine($"{"Status",-18}: {_status}");
        Console.WriteLine($"{"Status updated",-18}: {Fmt.Ts(_statusAt)} ({Fmt.Age(_statusAt)})");
        Console.WriteLine($"{"Last TX",-18}: {_lastTx}");
        Console.WriteLine($"{"Last RX chunk",-18}: {_lastRx}");
        Console.WriteLine($"{"Last frame",-18}: {_lastFrameInfo}");
        Console.WriteLine(
            $"{"Counters",-18}: chunks={_rxChunks} frames={_frames} live={_liveFrames} " +
            $"info={_infoFrames} settings={_settingsFrames} crc_errors={_crcErrors}");
        if (!string.IsNullOrWhiteSpace(_lastError))
            Console.WriteLine($"{"Last error",-18}: {_lastError}");

        Console.WriteLine();
        if (!string.IsNullOrWhiteSpace(_infoScreen)) { Console.WriteLine(_infoScreen); Console.WriteLine(); }
        if (!string.IsNullOrWhiteSpace(_settingsScreen)) { Console.WriteLine(_settingsScreen); Console.WriteLine(); }
        Console.WriteLine(_liveScreen);
    }

    private static TaskCompletionSource NewTcs() => new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static int FindPreamble(byte[] frame, int start)
    {
        for (var i = start; i <= frame.Length - JkProtocol.FramePreamble.Length; i++)
            if (frame.AsSpan(i, JkProtocol.FramePreamble.Length).SequenceEqual(JkProtocol.FramePreamble)) return i;
        return -1;
    }
}

// ---------------------------------------------------------------------------
//  JK Protocol: constants, frame building, decoding
// ---------------------------------------------------------------------------

static class JkProtocol
{
    public static readonly Guid ServiceUuid = Guid.Parse("0000ffe0-0000-1000-8000-00805f9b34fb");
    public static readonly Guid CharacteristicUuid = Guid.Parse("0000ffe1-0000-1000-8000-00805f9b34fb");
    public static ReadOnlySpan<byte> FramePreamble => [0x55, 0xAA, 0xEB, 0x90];
    public static ReadOnlySpan<byte> RequestPreamble => [0xAA, 0x55, 0x90, 0xEB];
    public const int FrameSize = 300;
    public const byte InfoCommand = 0x97;
    public const byte LiveCommand = 0x96;

    private static readonly LiveLayout[] LiveLayouts =
    [
        new("jk02_24s", "JK02 24S", 24, 54, 58, 60, 64, 134, 136, 0),
        new("jk02_32s", "JK02 32S", 32, 70, 74, 76, 80, 144, 166, 32),
    ];

    public static byte[] BuildRequest(byte command)
    {
        var frame = new byte[20];
        RequestPreamble.CopyTo(frame);
        frame[4] = command;
        frame[19] = Crc8Sum(frame.AsSpan(0, 19));
        return frame;
    }

    public static byte Crc8Sum(ReadOnlySpan<byte> data)
    {
        var sum = 0;
        foreach (var b in data) sum = (sum + b) & 0xFF;
        return (byte)sum;
    }

    public static DecodedFrame DecodeFrame(ReadOnlySpan<byte> frame) => frame[4] switch
    {
        0x01 => DecodeSettingsFrame(frame),
        0x02 => DecodeLiveFrame(frame),
        0x03 => DecodeInfoFrame(frame),
        _ => new("Pretty Decode", [new("frame_type", $"0x{frame[4]:X2}"), new("status", "Unknown frame type")])
    };

    private static DecodedFrame DecodeSettingsFrame(ReadOnlySpan<byte> f) => new(
        "Settings Frame (0x01)",
        [
            new("frame_counter", U8(f, 5).ToString(CultureInfo.InvariantCulture)),
            new("smart_sleep_voltage", FmtV(U32(f, 6))),
            new("cell_uvp", FmtV(U32(f, 10))),
            new("cell_uvpr", FmtV(U32(f, 14))),
            new("cell_ovp", FmtV(U32(f, 18))),
            new("cell_ovpr", FmtV(U32(f, 22))),
            new("balance_trigger", FmtV(U32(f, 26))),
            new("soc_100_voltage", FmtV(U32(f, 30))),
            new("soc_0_voltage", FmtV(U32(f, 34))),
            new("request_charge_voltage", FmtV(U32(f, 38))),
            new("request_float_voltage", FmtV(U32(f, 42))),
            new("max_charge_current", FmtA(U32(f, 50))),
            new("max_discharge_current", FmtA(U32(f, 62))),
            new("max_balance_current", FmtA(U32(f, 78))),
            new("cell_count", U8(f, 114).ToString(CultureInfo.InvariantCulture)),
            new("charge_switch", (U8(f, 118) != 0).ToString()),
            new("discharge_switch", (U8(f, 122) != 0).ToString()),
            new("balancer_switch", (U8(f, 126) != 0).ToString()),
            new("nominal_capacity", FmtAh(U32(f, 130))),
            new("device_address", U8(f, 270).ToString(CultureInfo.InvariantCulture)),
            new("precharge_time", $"{U8(f, 274)} s"),
            new("controls_bitmask", $"0x{U16(f, 282):X4}"),
            new("smart_sleep_hours", U8(f, 286).ToString(CultureInfo.InvariantCulture)),
        ]);

    private static DecodedFrame DecodeLiveFrame(ReadOnlySpan<byte> f)
    {
        var layout = DetectLiveLayout(f);
        var tail = layout.TailOffset;
        var cellV = new List<double>();
        var cellR = new List<double>();

        for (var c = 0; c < layout.CellSlots; c++)
        {
            var mv = U16(f, 6 + c * 2);
            if (mv != 0) cellV.Add(mv / 1000.0);
            var r = U16(f, layout.CellResistanceOffset + c * 2);
            cellR.Add(r == 0 ? 0.0 : r / 1000.0);
        }

        var totalV = U32(f, 118 + tail) / 1000.0;
        var absPower = U32(f, 122 + tail) / 1000.0;
        var current = I32(f, 126 + tail) / 1000.0;
        var power = current >= 0 ? absPower : -absPower;
        var t1 = I16(f, 130 + tail) / 10.0;
        var t2 = I16(f, 132 + tail) / 10.0;
        var tMos = I16(f, layout.MosTemperatureOffset) / 10.0;
        var errMask = U16(f, layout.ErrorMaskOffset);
        var balCur = I16(f, 138 + tail) / 1000.0;
        var balAct = U8(f, 140 + tail);
        var soc = U8(f, 141 + tail);
        var remAh = U32(f, 142 + tail) / 1000.0;
        var nomAh = U32(f, 146 + tail) / 1000.0;
        var cycles = U32(f, 150 + tail);
        var totCycAh = U32(f, 154 + tail) / 1000.0;
        var soh = U8(f, 158 + tail);
        var precharge = U8(f, 159 + tail) != 0;
        var runtime = U32(f, 162 + tail);
        var charging = U8(f, 166 + tail) != 0;
        var discharging = U8(f, 167 + tail) != 0;
        var precharging = U8(f, 168 + tail) != 0;
        var emergency = U16(f, 186 + tail);
        var t5 = I16(f, 222 + tail) / 10.0;
        var t4 = I16(f, 224 + tail) / 10.0;
        var t3 = I16(f, 226 + tail) / 10.0;
        var enMask = U32(f, layout.EnabledMaskOffset);
        var avgV = U16(f, layout.AvgCellVoltageOffset) / 1000.0;
        var deltaV = U16(f, layout.DeltaCellVoltageOffset) / 1000.0;

        var rows = new List<KeyValuePair<string, string>>
        {
            new("frame_counter", U8(f, 5).ToString(CultureInfo.InvariantCulture)),
            new("detected_layout", $"{layout.Label} ({layout.Name})"),
            new("cell_count_detected", cellV.Count.ToString(CultureInfo.InvariantCulture)),
            new("enabled_cells_mask", $"0x{enMask:X8}"),
            new("avg_cell_voltage_hw", $"{avgV:F3} V"),
            new("delta_cell_voltage_hw", $"{deltaV:F3} V"),
            new("total_voltage", $"{totalV:F3} V"),
            new("current", $"{current:F3} A"),
            new("power", $"{power:F1} W"),
            new("state_of_charge", $"{soc} %"),
            new("remaining_capacity", $"{remAh:F3} Ah"),
            new("nominal_capacity", $"{nomAh:F3} Ah"),
            new("cycle_count", cycles.ToString(CultureInfo.InvariantCulture)),
            new("total_cycle_capacity", $"{totCycAh:F3} Ah"),
            new("state_of_health", $"{soh} %"),
            new("mos_temperature", Fmt.Temp(tMos)),
            new("temp_sensor_1", Fmt.Temp(t1)),
            new("temp_sensor_2", Fmt.Temp(t2)),
            new("temp_sensor_3", Fmt.Temp(t3)),
            new("temp_sensor_4", Fmt.Temp(t4)),
            new("temp_sensor_5", Fmt.Temp(t5)),
            new("error_mask", $"0x{errMask:X4}"),
            new("balance_current", $"{balCur:F3} A"),
            new("balance_action", balAct.ToString(CultureInfo.InvariantCulture)),
            new("precharge_status", precharge.ToString()),
            new("charging_mos", charging.ToString()),
            new("discharging_mos", discharging.ToString()),
            new("precharging", precharging.ToString()),
            new("runtime_seconds", $"{runtime} ({Fmt.Runtime(runtime)})"),
            new("emergency_countdown", emergency.ToString(CultureInfo.InvariantCulture)),
        };

        if (cellV.Count > 0)
        {
            rows.Add(new("cell_voltages", string.Join(", ", cellV.Select(v => v.ToString("F3", CultureInfo.InvariantCulture)))));
            rows.Add(new("cell_min_max_delta",
                $"{cellV.Min():F3} / {cellV.Max():F3} / {(cellV.Max() - cellV.Min()) * 1000:F1} mV"));
        }
        rows.Add(new("cell_resistances", string.Join(", ",
            cellR.Take(cellV.Count == 0 ? 32 : cellV.Count).Select(v => v.ToString("F3", CultureInfo.InvariantCulture)))));

        return new("Live Frame (0x02)", rows);
    }

    private static DecodedFrame DecodeInfoFrame(ReadOnlySpan<byte> f) => new(
        "Device Info Frame (0x03)",
        [
            new("frame_counter", U8(f, 5).ToString(CultureInfo.InvariantCulture)),
            new("vendor_id", AsciiField(f, 6, 16)),
            new("hardware_version", AsciiField(f, 22, 8)),
            new("software_version", AsciiField(f, 30, 8)),
            new("device_uptime_s", U32(f, 38).ToString(CultureInfo.InvariantCulture)),
            new("power_on_count", U32(f, 42).ToString(CultureInfo.InvariantCulture)),
            new("device_name", AsciiField(f, 46, 16)),
            new("device_passcode", AsciiField(f, 62, 16)),
            new("manufacturing_date", AsciiField(f, 78, 8)),
            new("serial_number", AsciiField(f, 86, 11)),
            new("passcode", AsciiField(f, 97, 5)),
            new("user_data", AsciiField(f, 102, 16)),
            new("setup_passcode", AsciiField(f, 118, 16)),
            new("uart1_protocol_number", U8(f, 184).ToString(CultureInfo.InvariantCulture)),
            new("can_protocol_number", U8(f, 185).ToString(CultureInfo.InvariantCulture)),
            new("uart2_protocol_number", U8(f, 218).ToString(CultureInfo.InvariantCulture)),
            new("uart2_protocol_enable", U8(f, 219).ToString(CultureInfo.InvariantCulture)),
            new("lcd_buzzer_trigger", U8(f, 234).ToString(CultureInfo.InvariantCulture)),
            new("dry1_trigger", U8(f, 235).ToString(CultureInfo.InvariantCulture)),
            new("dry2_trigger", U8(f, 236).ToString(CultureInfo.InvariantCulture)),
            new("uart_lib_version", U8(f, 237).ToString(CultureInfo.InvariantCulture)),
            new("can_lib_version", U8(f, 268).ToString(CultureInfo.InvariantCulture)),
        ]);

    private static LiveLayout DetectLiveLayout(ReadOnlySpan<byte> frame)
    {
        LiveLayout? best = null;
        var bestScore = int.MinValue;
        var bestCells = int.MinValue;

        foreach (var layout in LiveLayouts)
        {
            var (score, cells) = ScoreLayout(frame, layout);
            if (score > bestScore || (score == bestScore && cells > bestCells))
            {
                best = layout;
                bestScore = score;
                bestCells = cells;
            }
        }

        return best ?? LiveLayouts[0];
    }

    private static (int Score, int ActiveCells) ScoreLayout(ReadOnlySpan<byte> frame, LiveLayout layout)
    {
        var cellMv = new int[layout.CellSlots];
        var active = new List<int>(layout.CellSlots);
        for (var c = 0; c < layout.CellSlots; c++)
        {
            cellMv[c] = U16(frame, 6 + c * 2);
            if (cellMv[c] is >= 2000 and <= 5000) active.Add(cellMv[c]);
        }

        var enMask = U32(frame, layout.EnabledMaskOffset);
        var avgMv = U16(frame, layout.AvgCellVoltageOffset);
        var deltaMv = U16(frame, layout.DeltaCellVoltageOffset);
        var totalMv = U32(frame, 118 + layout.TailOffset);
        var curMa = I32(frame, 126 + layout.TailOffset);

        var score = 0;
        if (avgMv is >= 2000 and <= 5000) score += 4;
        if (deltaMv <= 1000) score += 2;
        if (totalMv is >= 5000 and <= 100000) score += 3;
        if (curMa is >= -1000000 and <= 1000000) score += 2;

        if (active.Count > 0)
        {
            var computedAvg = (int)Math.Round(active.Average());
            var diff = Math.Abs(avgMv - computedAvg);
            score += diff switch { <= 5 => 10, <= 20 => 8, <= 50 => 5, <= 100 => 2, _ => 0 };

            var bits = BitOperations.PopCount(enMask);
            if (bits == active.Count) score += 4;
            else if (bits >= active.Count) score += 2;
        }

        if (layout.CellSlots == 32 && cellMv.Skip(24).Any(v => v != 0))
            score += 6;

        return (score, active.Count);
    }

    private static string FmtV(uint raw) => $"{raw / 1000.0:F3} V";
    private static string FmtA(uint raw) => $"{raw / 1000.0:F3} A";
    private static string FmtAh(uint raw) => $"{raw / 1000.0:F3} Ah";

    private static byte U8(ReadOnlySpan<byte> f, int o) => f[o];
    private static ushort U16(ReadOnlySpan<byte> f, int o) => BinaryPrimitives.ReadUInt16LittleEndian(f[o..(o + 2)]);
    private static short I16(ReadOnlySpan<byte> f, int o) => BinaryPrimitives.ReadInt16LittleEndian(f[o..(o + 2)]);
    private static uint U32(ReadOnlySpan<byte> f, int o) => BinaryPrimitives.ReadUInt32LittleEndian(f[o..(o + 4)]);
    private static int I32(ReadOnlySpan<byte> f, int o) => BinaryPrimitives.ReadInt32LittleEndian(f[o..(o + 4)]);

    private static string AsciiField(ReadOnlySpan<byte> f, int offset, int length)
    {
        var raw = f.Slice(offset, length).ToArray();
        var zero = Array.IndexOf(raw, (byte)0);
        var slice = zero >= 0 ? raw.AsSpan(0, zero) : raw.AsSpan();
        return Encoding.ASCII.GetString(slice).Trim();
    }

    private sealed record LiveLayout(
        string Name, string Label, int CellSlots,
        int EnabledMaskOffset, int AvgCellVoltageOffset, int DeltaCellVoltageOffset,
        int CellResistanceOffset, int MosTemperatureOffset, int ErrorMaskOffset, int TailOffset);
}

sealed record DecodedFrame(string Title, IReadOnlyList<KeyValuePair<string, string>> Rows);
