import koffi from 'koffi';

// Returns the PC's own processor type, which an emulated x64 process cannot learn from GetNativeSystemInfo.
// Null when Windows cannot answer; the caller then starts normally.
export function nativeMachine(): number | null {
  try {
    const kernel = koffi.load('kernel32.dll');
    const currentProcess = kernel.func('void* __stdcall GetCurrentProcess()');
    const isWow64Process2 = kernel.func('int __stdcall IsWow64Process2(void*, _Out_ uint16_t*, _Out_ uint16_t*)');
    const processMachine = [0];
    const machine = [0];
    if (!isWow64Process2(currentProcess(), processMachine, machine)) return null;
    return machine[0];
  } catch (error) {
    console.error('Processor check unavailable: ' + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}
