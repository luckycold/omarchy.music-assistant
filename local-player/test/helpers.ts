export class FakeTransport {
  handlers = new Map<string, Set<(...args: any[]) => void>>();
  sent: any[] = [];
  connected = false;
  responder?: (message: any) => void;
  on(event: string, fn: (...args: any[]) => void) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event)!.add(fn); }
  off(event: string, fn: (...args: any[]) => void) { this.handlers.get(event)?.delete(fn); }
  emit(event: string, ...args: any[]) { for (const fn of this.handlers.get(event) ?? []) fn(...args); }
  async connect() { this.connected = true; }
  disconnect() { this.connected = false; this.emit('close', 'sensitive reason'); }
  send(text: string) { const msg = JSON.parse(text); this.sent.push(msg); this.responder?.(msg); }
  reply(request: any, result: unknown) { this.emit('message', JSON.stringify({ message_id: request.message_id, result })); }
  async openDataChannel(label: string) { if (label !== 'sendspin') throw Error('wrong label'); return new FakeChannel() as unknown as RTCDataChannel; }
}
export class FakeChannel extends EventTarget {
  readyState = 'open'; ordered = true; label = 'sendspin'; binaryType = 'blob';
  sent: unknown[] = [];
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
}
export function memoryStorage() {
  const entries = new Map<string,string>();
  return {getItem: (k: string) => entries.get(k) ?? null, setItem: (k: string,v: string) => { entries.set(k,v); }};
}
