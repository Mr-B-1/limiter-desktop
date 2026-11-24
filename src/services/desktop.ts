import koffi from 'koffi';
import { screen, type BrowserWindow } from 'electron';
import type { Bounds, NativePlacement } from './store.js';
import { NativeGuard } from './native-guard.js';
import { MAX_WIDGET_SIZE } from './resize.js';

const user = koffi.load('user32.dll');
const findWindowEx = user.func('void* __stdcall FindWindowExW(void*, void*, str16, str16)');
koffi.proto('int __stdcall LimiterEnumWindow(void*, intptr_t)');
const enumWindows = user.func('int __stdcall EnumWindows(LimiterEnumWindow*, intptr_t)');
const getParent = user.func('void* __stdcall GetParent(void*)');
const getAncestor = user.func('void* __stdcall GetAncestor(void*, uint)');
const setParent = user.func('void* __stdcall SetParent(void*, void*)');
const getStyle = user.func('intptr_t __stdcall GetWindowLongPtrW(void*, int)');
const setStyle = user.func('intptr_t __stdcall SetWindowLongPtrW(void*, int, intptr_t)');
const setPosition = user.func('int __stdcall SetWindowPos(void*, void*, int, int, int, int, uint)');
const isWindow = user.func('int __stdcall IsWindow(void*)');
const isVisible = user.func('int __stdcall IsWindowVisible(void*)');
const getClass = user.func('int __stdcall GetClassNameW(void*, void*, int)');
koffi.struct('LimiterRect', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const getRect = user.func('int __stdcall GetWindowRect(void*, _Out_ LimiterRect*)');
koffi.struct('LimiterPoint', { x: 'int', y: 'int' });
const screenToClient = user.func('int __stdcall ScreenToClient(void*, _Inout_ LimiterPoint*)');
const windowFromPoint = user.func('void* __stdcall WindowFromPoint(LimiterPoint)');
const getForegroundWindow = user.func('void* __stdcall GetForegroundWindow()');

type Handle = bigint | null;
const guard = new NativeGuard();
const send = <T>(call: () => T): T => guard.send(call);
const ready = (): void => guard.ready();
const sameBounds = (left: Bounds, right: Bounds): boolean => left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
// Display-relative coordinates are owned by Electron. A changed mapping invalidates saved physical pixels.
const displayLayout = (): string => JSON.stringify(screen.getAllDisplays().map(display => ({ id: display.id, bounds: display.bounds,
  workArea: display.workArea, scaleFactor: display.scaleFactor, rotation: display.rotation, nativeOrigin: display.nativeOrigin })).sort((left, right) => left.id - right.id));
function logicalBounds(native: Bounds): Bounds {
  const bounds = screen.screenToDipRect(null, native);
  // Enclosing integer edges can add one DIP on each side of a maximum-size resize. Keep only that two-DIP
  // margin within the existing preference limits; position and the separately captured native pixels stay exact.
  for (const dimension of ['width', 'height'] as const) {
    const limit = MAX_WIDGET_SIZE[dimension];
    if (bounds[dimension] > limit && bounds[dimension] <= limit + 2) bounds[dimension] = limit;
  }
  return bounds;
}

function className(handle: Handle): string {
  const buffer = Buffer.alloc(512);
  getClass(handle, buffer, 256);
  return buffer.toString('utf16le').split('\0')[0];
}

function desktopView(): Handle {
  let found: Handle = null;
  enumWindows((root: Handle) => {
    const view = findWindowEx(root, null, 'SHELLDLL_DefView', null) as Handle;
    if (view && ['Progman', 'WorkerW'].includes(className(root))) {
      // Use Explorer's existing icon surface, without creating or hiding WorkerW windows.
      found = isVisible(view) ? view : root;
      return 0;
    }
    return 1;
  }, 0);
  return found;
}

export class DesktopSurface {
  private parent: Handle = null;
  private readonly handle: Handle;
  constructor(private readonly window: BrowserWindow) {
    this.handle = window.getNativeWindowHandle().readBigUInt64LE();
  }
  get attached(): boolean {
    ready();
    return Boolean(this.parent && isWindow(this.parent) && isVisible(this.parent) && isWindow(this.handle) && getParent(this.handle) === this.parent);
  }
  attach(bounds: Bounds, placement?: NativePlacement): boolean {
    ready();
    const parent = desktopView();
    if (!parent || !isWindow(this.handle)) { this.window.hide(); this.parent = null; return false; }
    this.window.setAlwaysOnTop(false);
    this.window.setSkipTaskbar(true);
    // Child coordinates belong to the desktop; remove top-level nonclient framing.
    const style = (Number(getStyle(this.handle, -16)) | 0x40000000) & ~0x80cf0000;
    send(() => setStyle(this.handle, -16, BigInt(style)));
    if (getParent(this.handle) !== parent) send(() => setParent(this.handle, parent));
    this.parent = parent;
    if (!this.attached) { this.window.hide(); return false; }
    this.setBounds(bounds, placement);
    return true;
  }
  setBounds(bounds: Bounds, placement?: NativePlacement, skipUnchanged = false): void {
    ready();
    if (!this.attached) return;
    // Rect conversion encloses fractional pixels and is not an inverse. Restore the captured pixels only while
    // their logical bounds and display mapping still agree; a clamp or display change must take precedence.
    const native = placement && placement.layout === displayLayout() && sameBounds(placement.bounds, bounds) &&
      sameBounds(logicalBounds(placement.native), bounds) ? placement.native : screen.dipToScreenRect(null, bounds);
    if (skipUnchanged && sameBounds(native, this.nativeBounds())) return;
    const origin = { x: native.x, y: native.y };
    if (!screenToClient(this.parent, origin)) throw new Error('Desktop coordinates unavailable');
    if (!send(() => setPosition(this.handle, 0n, origin.x, origin.y, native.width, native.height, 0x10 | 0x20))) throw new Error('Desktop position unavailable');
  }
  // SetWindowPos emits move/resize again. Automatic restoration must settle after one correction.
  restoreBounds(bounds: Bounds, placement?: NativePlacement): void { this.setBounds(bounds, placement, true); }
  private nativeBounds(): Bounds {
    ready();
    const raw = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!getRect(this.handle, raw)) throw new Error('Widget bounds unavailable');
    return { x: raw.left, y: raw.top, width: raw.right - raw.left, height: raw.bottom - raw.top };
  }
  bounds(): Bounds { return logicalBounds(this.nativeBounds()); }
  placement(): NativePlacement {
    const native = this.nativeBounds();
    return { bounds: logicalBounds(native), native, layout: displayLayout() };
  }
  show(): boolean {
    ready();
    if (!this.attached) return false;
    this.window.showInactive();
    // HWND_TOP is relative to the desktop's children, never above application windows.
    send(() => setPosition(this.handle, 0n, 0, 0, 0, 0, 0x1 | 0x2 | 0x10 | 0x40));
    return true;
  }
  inspect(): Record<string, unknown> {
    ready();
    return { attached: this.attached, handle: String(this.handle), parent: String(getParent(this.handle)), parentClass: className(getParent(this.handle)),
      rootClass: className(getAncestor(this.handle, 2)), topmost: Boolean(Number(getStyle(this.handle, -20)) & 0x8),
      childStyle: Boolean(Number(getStyle(this.handle, -16)) & 0x40000000), nativeVisible: Boolean(isVisible(this.handle)), bounds: this.bounds(), nativeBounds: this.nativeBounds() };
  }
  foreground(): string { ready(); return String(getForegroundWindow()); }
  // Read-only smoke evidence. A reference must keep its HWND, root, process and class identity throughout an action.
  inspectForeground() {
    ready();
    const getWindowThreadProcessId = user.func('uint __stdcall GetWindowThreadProcessId(void*, _Out_ uint*)');
    const handle = getForegroundWindow() as Handle, alive = Boolean(handle && isWindow(handle));
    const root = alive ? getAncestor(handle, 2) as Handle : null, pid = [0];
    if (alive) getWindowThreadProcessId(handle, pid);
    const windowClass = alive ? className(handle) : '', rootClass = root ? className(root) : '';
    const visible = Boolean(alive && root && isWindow(root) && isVisible(handle) && isVisible(root));
    const topmost = Boolean(root && (Number(getStyle(root, -20)) & 0x8));
    const excluded = /^(Progman$|WorkerW$|SHELLDLL_DefView$|Shell_TrayWnd$|Shell_SecondaryTrayWnd$|LockScreenBackstopFrame$|Windows\.UI\.Core\.CoreWindow$|Limiter(?:Ambient)?Focus)/;
    const normal = Boolean(visible && pid[0] && root === handle && windowClass && rootClass && !topmost &&
      !excluded.test(windowClass) && !excluded.test(rootClass) && !(Number(getStyle(handle, -16)) & 0x40000000));
    return { handle: String(handle ?? 0n), root: String(root ?? 0n), pid: pid[0], windowClass, rootClass, alive, visible, topmost, normal, ownProcess: pid[0] === process.pid };
  }
  coveredBy(other: BrowserWindow): boolean {
    ready();
    const bounds = this.nativeBounds();
    const hit = send(() => windowFromPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }));
    return getAncestor(hit, 2) === other.getNativeWindowHandle().readBigUInt64LE();
  }
  coveredByNormalApp(): boolean {
    ready();
    const bounds = this.nativeBounds();
    const hit = send(() => windowFromPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }));
    const root = getAncestor(hit, 2) as Handle;
    return Boolean(root && isVisible(root) && !['Progman', 'WorkerW'].includes(className(root)) && !(Number(getStyle(root, -20)) & 0x8));
  }
  occlusionReceipt(other: BrowserWindow): Record<string, unknown> {
    ready();
    const bounds = this.nativeBounds();
    const hit = send(() => windowFromPoint({ x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }));
    return { coverHandle: String(other.getNativeWindowHandle().readBigUInt64LE()), coverVisible: other.isVisible(),
      coverBounds: other.getBounds(), widgetNativeBounds: bounds, hit: String(hit), hitRoot: String(getAncestor(hit, 2)), hitClass: className(hit), hitRootClass: className(getAncestor(hit, 2)), hitRootTopmost: Boolean(Number(getStyle(getAncestor(hit, 2), -20)) & 0x8) };
  }
}
