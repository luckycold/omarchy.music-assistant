export type ErrorCode = 'RPC_REMOTE' | 'RPC_SEND' | 'RPC_TIMEOUT' | 'RPC_CLOSED' | 'RPC_PROTOCOL' |
  'CHANNEL_CLOSED' | 'CHANNEL_INVALID' | 'CHANNEL_ERROR' | 'SDK_EVENT' | 'SENDSPIN_CLOSED' |
  'CONFIG_INVALID' | 'AUTH_FAILED' | 'CONNECT_FAILED' | 'CONNECT_TIMEOUT' | 'CANCELLED' |
  'PAIRING_ABORTED' | 'PAIRING_UNAVAILABLE' | 'PLAYER_NOT_READY' | 'API_CLOSED' | 'API_ERROR' |
  'NOT_READY' | 'RPC_RESERVED' | 'RPC_LIMIT' | 'HEALTH_FAILED';
// Never retain request args, response details, URL, error cause or arbitrary error text.
export class PlayerError extends Error {
  constructor(readonly code: ErrorCode, readonly remoteCode?: number) { super(code); this.name = 'PlayerError'; }
}
export const safeError = (error: unknown): PlayerError => error instanceof PlayerError ? error : new PlayerError('CONNECT_FAILED');
