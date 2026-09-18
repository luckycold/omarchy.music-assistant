import { SpikeError, type ErrorCode } from './errors';
/** SDK 5 adoption only requires WebSocket's callback surface, send/close, binaryType and readyState.
 * Own implementation inspired by frontend sendspin-connection.ts; never proxy-auth this channel.
 * It may be constructed before network work so player.unlock() retains the user's gesture.
 */
export class ChannelSocket {
  readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSING = 2; readonly CLOSED = 3;
  binaryType: BinaryType = 'arraybuffer';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  private channel?: RTCDataChannel;
  private closed = false;
  private counts = {rxText:0, txText:0, rxBinary:0, txBinary:0, rxBytes:0, txBytes:0};
  constructor(private fault: (code: ErrorCode) => void = () => {}) {}
  get readyState(): number {
    if (this.closed) return this.CLOSED;
    return ({connecting:0,open:1,closing:2,closed:3} as const)[this.channel?.readyState ?? 'connecting'];
  }
  stats() { return {...this.counts}; }
  attach(channel: RTCDataChannel) {
    if (this.closed) { channel.close(); throw new SpikeError('CHANNEL_CLOSED'); }
    if (this.channel || channel.label !== 'sendspin' || !channel.ordered || channel.readyState !== 'open') {
      channel.close(); throw new SpikeError('CHANNEL_INVALID');
    }
    this.channel = channel; channel.binaryType = 'arraybuffer';
    channel.addEventListener('message', this.message);
    channel.addEventListener('error', this.error);
    channel.addEventListener('close', this.ended);
    this.invoke(() => this.onopen?.(new Event('open')));
  }
  private invoke(fn: () => unknown) {
    try {
      const result = fn();
      // SDK currently uses synchronous handlers; guard thenables too.
      if (result && typeof (result as Promise<unknown>).then === 'function') void Promise.resolve(result).catch(() => this.fault('SDK_EVENT'));
    } catch { this.fault('SDK_EVENT'); }
  }
  private message = (event: MessageEvent) => {
    if (this.closed) return;
    if (typeof event.data === 'string') this.counts.rxText++;
    else if (event.data instanceof ArrayBuffer) { this.counts.rxBinary++; this.counts.rxBytes += event.data.byteLength; }
    else { this.fault('CHANNEL_ERROR'); return; }
    this.invoke(() => this.onmessage?.(event));
  };
  private error = () => { this.fault('CHANNEL_ERROR'); this.invoke(() => this.onerror?.(new Event('error'))); };
  private ended = () => {
    if (this.closed) return;
    this.closed = true; this.detach();
    // Never forward raw close reason or RTC error objects into logs/status.
    this.invoke(() => this.onclose?.(new Event('close') as CloseEvent)); this.fault('SENDSPIN_CLOSED');
  };
  private detach() {
    this.channel?.removeEventListener('message', this.message);
    this.channel?.removeEventListener('error', this.error);
    this.channel?.removeEventListener('close', this.ended);
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== this.OPEN || !this.channel) throw new SpikeError('CHANNEL_CLOSED');
    try {
      if (typeof data === 'string') { this.channel.send(data); this.counts.txText++; }
      else { this.channel.send(data as ArrayBuffer); this.counts.txBinary++; this.counts.txBytes += data.byteLength; }
    } catch { this.fault('CHANNEL_ERROR'); throw new SpikeError('CHANNEL_ERROR'); }
  }
  close(_code?: number, _reason?: string) {
    if (this.closed) return;
    this.closed = true; this.detach(); this.channel?.close();
    this.invoke(() => this.onclose?.(new Event('close') as CloseEvent));
    this.fault('SENDSPIN_CLOSED');
  }
  asWebSocket(): WebSocket { return this as unknown as WebSocket; }
}
