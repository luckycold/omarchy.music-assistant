import {MAX_REQUEST,MAX_RESPONSE,MAX_PENDING} from './protocol';
import { PlayerError } from './errors';
import type { ITransport } from './vendor/frontend/transport';
export type RpcTransport = Pick<ITransport, 'send' | 'on' | 'off'>;
type Pending = { resolve: (result: unknown) => void; reject: (error: PlayerError) => void;
  timer: ReturnType<typeof setTimeout>; bytes:number;parts: unknown[] | null };
export class RpcClient {
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  constructor(private transport: RpcTransport, private timeoutMs = 30000) {
    transport.on('message', this.receive); transport.on('close', this.close); transport.on('error', this.close);
  }
  request(command: string, args: Record<string, unknown> = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.closed) return Promise.reject(new PlayerError('RPC_CLOSED'));
    if(this.pending.size>=MAX_PENDING||JSON.stringify({command,args}).length>MAX_REQUEST)return Promise.reject(new PlayerError('RPC_LIMIT'));
    const message_id = `player-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(message_id, new PlayerError('RPC_TIMEOUT')), timeoutMs);
      this.pending.set(message_id, { resolve, reject, timer, bytes:0, parts: null });
      try { this.transport.send(JSON.stringify({message_id, command, args})); }
      catch { this.finish(message_id, new PlayerError('RPC_SEND')); }
    });
  }
  private receive = (text: string): void => {
    if(typeof text!=='string'||text.length>MAX_RESPONSE){this.close();return;}
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg.message_id !== 'string') return;
    const entry = this.pending.get(msg.message_id); if (!entry) return;
    entry.bytes+=text.length;if(entry.bytes>MAX_RESPONSE){this.finish(msg.message_id,new PlayerError('RPC_LIMIT'));return;}
    if (Object.hasOwn(msg, 'error_code')) {
      this.finish(msg.message_id, new PlayerError('RPC_REMOTE', Number.isSafeInteger(msg.error_code) ? msg.error_code : undefined)); return;
    }
    if (!Object.hasOwn(msg, 'result')) { this.finish(msg.message_id, new PlayerError('RPC_PROTOCOL')); return; }
    if (msg.partial === true || entry.parts !== null) {
      if (!Array.isArray(msg.result)) { this.finish(msg.message_id, new PlayerError('RPC_PROTOCOL')); return; }
      entry.parts = (entry.parts ?? []).concat(msg.result);
      if (msg.partial === true) return;
    }
    this.finish(msg.message_id, undefined, entry.parts ?? msg.result);
  };
  private finish(id: string, error?: PlayerError, result?: unknown) {
    const entry = this.pending.get(id); if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(id);
    if (error) entry.reject(error); else entry.resolve(result);
  }
  private close = () => { this.closed = true; for (const id of this.pending.keys()) this.finish(id, new PlayerError('RPC_CLOSED')); };
  dispose() {
    this.close(); this.transport.off('message', this.receive); this.transport.off('close', this.close); this.transport.off('error', this.close);
  }
}
