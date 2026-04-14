# JK BLE File-Based App

`jk.cs` is a native .NET 10 file-based app that replaces the Python `jk.py` BLE monitor.

## Run

```powershell
dotnet run --file "Docs/jk ble/jk.cs" -- --help
dotnet run --file "Docs/jk ble/jk.cs" -- --scan-timeout 10
dotnet run --file "Docs/jk ble/jk.cs" -- AA:BB:CC:DD:EE:FF --raw
```

## Build

```powershell
dotnet build "Docs/jk ble/jk.cs"
```

## Notes

- Requires the .NET 10 SDK.
- Uses `InTheHand.BluetoothLE` for native cross-platform BLE access.
- On Linux and macOS, BLE availability still depends on local OS permissions and stack support.
- The current NuGet dependency graph emits a restore warning for `Tmds.DBus` on Linux. That warning comes from the upstream package dependency, not from local project code.
