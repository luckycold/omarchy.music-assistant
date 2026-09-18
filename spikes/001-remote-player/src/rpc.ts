import { SpikeError } from './errors';
import type { ITransport } from './vendor/frontend/transport';
export type RpcTransport = Pick<ITransport, 'send' | 'on' | 'off'>;
type Pending = { resolve: (result: unknown) => void; reject: (error: SpikeError) => void;
  timer: ReturnType<typeof setTimeout>; parts: unknown[] | null };
export class RpcClient {
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  constructor(private transport: RpcTransport, private timeoutMs = 30000) {
    transport.on('message', this.receive); transport.on('close', this.close); transport.on('error', this.close);
  }
  request(command: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new SpikeError('RPC_CLOSED'));
    const message_id = `spike-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(message_id, new SpikeError('RPC_TIMEOUT')), timeoutMs);
      this.pending.set(message_id, { resolve, reject, timer, parts: null });
      try { this.transport.send(JSON.stringify({message_id, command, args})); }
      catch { this.finish(message_id, new SpikeError('RPC_SEND')); }
    });
  }
  private receive = (text: string): void => {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.message_id !== 'string') return;
    const entry = this.pending.get(msg.message_id); if (!entry) return;
    if (Object.hasOwn(msg, 'error_code')) {
      this.finish(msg.message_id, new SpikeError('RPC_REMOTE', Number.isSafeInteger(msg.error_code) ? msg.error_code : undefined)); return;
    }
    if (!Object.hasOwn(msg, 'result')) { this.finish(msg.message_id, new SpikeError('RPC_PROTOCOL')); return; }
    if (msg.partial === true || entry.parts !== null) {
      if (!Array.isArray(msg.result)) { this.finish(msg.message_id, new SpikeError('RPC_PROTOCOL')); return; }
      entry.parts = (entry.parts ?? []).concat(msg.result);
      if (msg.partial === true) return;
    }
    this.finish(msg.message_id, undefined, entry.parts ?? msg.result);
  };
  private finish(id: string, error?: SpikeError, result?: unknown) {
    const entry = this.pending.get(id); if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(id);
    if (error) entry.reject(error); else entry.resolve(result);
  }
  private close = () => { this.closed = true; for (const id of this.pending.keys()) this.finish(id, new SpikeError('RPC_CLOSED')); };
  dispose() {
    this.close(); this.transport.off('message', this.receive); this.transport.off('close', this.close); this.transport.off('error', this.close);
  }
}
