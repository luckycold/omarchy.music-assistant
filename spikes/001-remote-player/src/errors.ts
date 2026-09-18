export type ErrorCode = 'RPC_REMOTE' | 'RPC_SEND' | 'RPC_TIMEOUT' | 'RPC_CLOSED' | 'RPC_PROTOCOL' |
  'CHANNEL_CLOSED' | 'CHANNEL_INVALID' | 'CHANNEL_ERROR' | 'SDK_EVENT' | 'SENDSPIN_CLOSED' |
  'CONFIG_INVALID' | 'AUTH_FAILED' | 'CONNECT_FAILED' | 'CONNECT_TIMEOUT' | 'CANCELLED' |
  'PAIRING_ABORTED' | 'PAIRING_UNAVAILABLE' | 'PLAYER_NOT_READY' | 'API_CLOSED' | 'API_ERROR' |
  'NOT_READY' | 'RPC_RESERVED' | 'TEST_URL_REQUIRED';
// Never retain request args, response details, URL, error cause or arbitrary error text.
export class SpikeError extends Error {
  constructor(readonly code: ErrorCode, readonly remoteCode?: number) { super(code); this.name = 'SpikeError'; }
}
export const safeError = (error: unknown): SpikeError => error instanceof SpikeError ? error : new SpikeError('CONNECT_FAILED');
