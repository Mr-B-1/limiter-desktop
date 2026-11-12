# Keeps a CI runner's session active during the packaged smoke test. Limiter pauses network reads after five
# idle minutes, and a runner has no user, so this moves the mouse one pixel and back every 20 seconds until stopped.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LimiterNudge {
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int Dx; public int Dy; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, Input[] inputs, int size);
  // Type 0 is mouse input; flag 1 is a relative move.
  public static uint Move(int dx) {
    var input = new Input { Type = 0, Mouse = new MouseInput { Dx = dx, Flags = 1 } };
    return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input)));
  }
}
'@
while ($true) {
  if ([LimiterNudge]::Move(1) -ne 1) { Write-Warning 'SendInput was refused; the runner session may not be interactive.' }
  Start-Sleep -Milliseconds 200
  [void][LimiterNudge]::Move(-1)
  Start-Sleep -Seconds 20
}
