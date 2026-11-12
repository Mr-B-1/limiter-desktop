import type { ResizeEdge, ResizeRequest } from '../services/resize.js';

// screenX/screenY stay stable while the desktop child moves under a captured pointer.
export function installResize(send: (request: ResizeRequest) => Promise<void>): void {
  let active: { pointer: number; x: number; y: number; handle: HTMLElement } | null = null;
  let pending: { dx: number; dy: number } | null = null;
  let frame = 0;
  const request = (value: ResizeRequest) => { void send(value).catch(() => {
    const message = document.getElementById('message');
    if (message) { message.textContent = 'The widget could not be resized. Try again.'; message.hidden = false; }
  }); };
  const flush = () => {
    cancelAnimationFrame(frame); frame = 0;
    if (pending) { request({ phase: 'move', ...pending }); pending = null; }
  };
  const finish = () => {
    if (!active) return;
    flush();
    const previous = active; active = null;
    if (previous.handle.hasPointerCapture(previous.pointer)) previous.handle.releasePointerCapture(previous.pointer);
    request({ phase: 'end' });
  };
  for (const handle of document.querySelectorAll<HTMLElement>('[data-resize]')) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || active) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      active = { pointer: event.pointerId, x: event.screenX, y: event.screenY, handle };
      request({ phase: 'start', edge: handle.dataset.resize as ResizeEdge });
    });
    handle.addEventListener('pointermove', event => {
      if (!active || active.pointer !== event.pointerId) return;
      if ((event.buttons & 1) === 0) { finish(); return; }
      pending = { dx: event.screenX - active.x, dy: event.screenY - active.y };
      if (!frame) frame = requestAnimationFrame(flush);
    });
    handle.addEventListener('pointerup', event => {
      if (active?.pointer !== event.pointerId) return;
      pending = { dx: event.screenX - active.x, dy: event.screenY - active.y };
      finish();
    });
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      const steps: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };
      const step = steps[event.key];
      if (!step || active) return;
      event.preventDefault();
      request({ phase: 'start', edge: handle.dataset.resize as ResizeEdge });
      request({ phase: 'move', dx: step[0], dy: step[1] });
      request({ phase: 'end' });
    });
  }
  window.addEventListener('blur', finish);
}
