/**
 * WebRTC Transport
 *
 * Implements the transport interface using WebRTC DataChannel.
 * Used for remote connections to Music Assistant instances via NAT traversal.
 *
 * Security: Uses DTLS certificate pinning for server authentication.
 */

import { BaseTransport, TransportState } from "./transport";
import { SignalingClient, IceServerConfig } from "./signaling";
import {
  verifyAndSanitizeSdp,
  CertificateVerificationError,
} from "./crypto-utils";

// Re-export for convenience
export type { IceServerConfig };
export { CertificateVerificationError };

export interface WebRTCTransportOptions {
  signalingServerUrl: string;
  /**
   * Remote server ID - encoded fingerprint of the server's DTLS certificate.
   * Used for both routing and authentication.
   */
  remoteId: string;
  dataChannelLabel?: string;
  iceTransportPolicy?: RTCIceTransportPolicy;
  reconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  reconnectDelayGrowth?: number;
  maxReconnectAttempts?: number;
  /**
   * Skip certificate verification (for development only - INSECURE)
   * Default: false
   */
  skipCertificateVerification?: boolean;
}

// Fallback ICE servers (only public STUN servers - no TURN)
// These will only be used if the server doesn't provide ICE servers
const FALLBACK_ICE_SERVERS: IceServerConfig[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

// A connection must hold this long before its success resets the backoff,
// otherwise a flapping loop (which briefly connects) keeps backoff flat.
const STABLE_CONNECTION_THRESHOLD_MS = 5000;
// Local hardening: match RpcClient's response ceiling across all pending groups.
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_COUNT = 1024;
const MAX_CHUNK_GROUPS = 32;
const CHUNK_TTL_MS = 30000;

export class WebRTCTransport extends BaseTransport {
  private options: Required<WebRTCTransportOptions>;
  private signaling: SignalingClient;
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private iceCandidateBuffer: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stableConnectionTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  // Serialises connect(); concurrent negotiation corrupts the shared pc/SDP state.
  private connectInFlight = false;
  private connectionGeneration = 0;
  private cancelConnectionWait: (() => void) | null = null;
  private chunkExpiryTimer: ReturnType<typeof setInterval> | null = null;
  // Reassembly buffers for oversized messages the server splits into chunks, keyed by group id.
  // Group ids are unique across channels, so the dispatch of the channel a group started on
  // is kept with it.
  private chunkGroups = new Map<
    number,
    {
      count: number;
      parts: string[];
      received: number;
      bytes: number;
      expiresAt: number;
      dispatch: (data: string) => void;
    }
  >();
  // ICE servers received from the signaling server (provided by MA server)
  private iceServers: IceServerConfig[] = [];

  constructor(options: WebRTCTransportOptions) {
    super();
    this.options = {
      iceTransportPolicy:options.iceTransportPolicy??"all",
      signalingServerUrl: options.signalingServerUrl,
      remoteId: options.remoteId,
      dataChannelLabel: options.dataChannelLabel || "ma-api",
      reconnect: options.reconnect ?? true,
      reconnectDelay: options.reconnectDelay ?? 1000,
      maxReconnectDelay: options.maxReconnectDelay ?? 30000,
      reconnectDelayGrowth: options.reconnectDelayGrowth ?? 1.5,
      maxReconnectAttempts: options.maxReconnectAttempts ?? Infinity,
      skipCertificateVerification: options.skipCertificateVerification ?? false,
    };

    this.signaling = new SignalingClient({
      serverUrl: options.signalingServerUrl, reconnect:false,
    });

    this.setupSignalingHandlers();
  }

  async connect(): Promise<void> {
    // Let the in-flight attempt finish; a concurrent negotiation corrupts pc/SDP state.
    if (this.connectInFlight) {
      return;
    }
    this.connectInFlight = true;
    const generation = ++this.connectionGeneration;
    const assertCurrent = () => {
      if (generation !== this.connectionGeneration || this.intentionalClose) {
        throw new Error("Connection canceled");
      }
    };
    this.intentionalClose = false;
    this.setState(TransportState.CONNECTING);

    try {
      // Connect to signaling server
      await this.signaling.connect();
      assertCurrent();

      // Request connection - receives ICE servers from MA server
      const { iceServers } = await this.signaling.requestConnection(
        this.options.remoteId,
      );
      assertCurrent();

      this.iceServers = iceServers || FALLBACK_ICE_SERVERS;
      this.createPeerConnection();

      // Create data channel (we're the initiator)
      this.createDataChannel();

      // Create and send offer (triggers ICE gathering)
      const offer = await this.peerConnection!.createOffer();
      assertCurrent();
      await this.peerConnection!.setLocalDescription(offer);
      assertCurrent();
      this.signaling.sendOffer(offer);

      // Wait for connection to be established
      await this.waitForConnection();
      assertCurrent();

      // Reset backoff only once the connection proves stable, not on every connect.
      this.scheduleBackoffReset();
      this.setState(TransportState.CONNECTED);
    } catch (error) {
      // Never let a stale attempt clean up or change the state of its successor.
      if (generation !== this.connectionGeneration || this.intentionalClose) throw error;
      console.error("[WebRTCTransport] Connection failed:", error);
      this.cleanup();

      // Only set to FAILED if we're not going to retry
      // During reconnect attempts, keep the RECONNECTING state
      if (this.reconnectAttempts === 0) {
        // This is the initial connection attempt
        this.setState(TransportState.FAILED);
      } else if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
        // Max retries reached
        this.setState(TransportState.FAILED);
      }
      // else: keep RECONNECTING state for next retry

      throw error;
    } finally {
      if (generation === this.connectionGeneration) this.connectInFlight = false;
    }
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.cleanup();
    this.setState(TransportState.DISCONNECTED);
    this.emit("close", "Disconnected by user");
  }

  send(data: string): void {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel is not open");
    }
    this.dataChannel.send(data);
  }

  /** Local extension: allowlisted transport counters, never candidate addresses. */
  async connectionStats():Promise<{localCandidateType:string|null;receivedBytes:number}>{
    const stats=await this.peerConnection?.getStats();let pair:any;
    stats?.forEach(s=>{if(s.type==='transport'&&s.selectedCandidatePairId)pair=stats.get(s.selectedCandidatePairId);});
    if(!pair)stats?.forEach(s=>{if(s.type==='candidate-pair'&&s.nominated&&s.state==='succeeded')pair=s;});
    const type=pair?stats?.get(pair.localCandidateId)?.candidateType:null;
    return {localCandidateType:['host','srflx','prflx','relay'].includes(type)?type:null,receivedBytes:Number.isSafeInteger(pair?.bytesReceived)?pair.bytesReceived:0};
  }

  private setupSignalingHandlers(): void {
    this.signaling.on("answer", (answer) => {
      this.handleAnswer(answer);
    });

    this.signaling.on("ice-candidate", (candidate) => {
      this.handleIceCandidate(candidate);
    });

    this.signaling.on("peer-disconnected", () => {
      this.handlePeerDisconnected();
    });

    this.signaling.on("error", (error) => {
      console.error("[WebRTCTransport] Signaling error:", error);
      this.emit("error", new Error(error));
    });
  }

  private createPeerConnection(): void {
    this.peerConnection = new RTCPeerConnection({
      iceTransportPolicy:this.options.iceTransportPolicy,
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
    });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.signaling.sendIceCandidate(event.candidate.toJSON());
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      // `disconnected` is transient and usually self-heals; only act on the
      // terminal `failed` state (the browser escalates `disconnected` to it).
      if (state === "failed") {
        this.handleConnectionFailure();
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState;
      if (state === "failed") {
        this.handleConnectionFailure();
      }
    };
  }

  private createDataChannel(): void {
    this.dataChannel = this.peerConnection!.createDataChannel(
      this.options.dataChannelLabel,
      {
        ordered: true,
      },
    );

    this.setupDataChannelHandlers();
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      this.setState(TransportState.CONNECTED);
      this.emit("open");
    };

    this.dataChannel.onclose = () => {
      console.log("[WebRTCTransport] Data channel closed");
      if (!this.intentionalClose && this.options.reconnect) {
        this.scheduleReconnect();
      } else {
        this.setState(TransportState.DISCONNECTED);
        this.emit("close", "Data channel closed");
      }
    };

    this.dataChannel.onerror = () => {
      console.error("[WebRTCTransport] Data channel error");
      this.emit("error", new Error("Data channel error"));
    };

    this.attachMessageHandler(this.dataChannel, (data) =>
      this.dispatchMessage(data),
    );
  }

  /**
   * Deliver a channel's incoming messages to a dispatch function.
   *
   * @param channel - Channel to read from.
   * @param dispatch - Receives every whole message from that channel.
   */
  private attachMessageHandler(
    channel: RTCDataChannel,
    dispatch: (data: string) => void,
  ): void {
    channel.onmessage = (event) => {
      // The server splits oversized messages into "__chunk__" frames; reassemble them
      // before dispatching. Everything else is a whole message.
      if (typeof event.data === "string") {
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === "__chunk__") {
            this.handleChunk(frame, dispatch);
            return;
          }
        } catch {
          // not a JSON chunk frame; fall through to normal dispatch
        }
      }
      dispatch(event.data);
    };
  }

  private dispatchMessage(data: string): void {
    this.emit("message", data);
  }

  private handleChunk(
    frame: {
      id: number;
      seq: number;
      count: number;
      b64: string;
    },
    dispatch: (data: string) => void,
  ): void {
    // Validate before allocating. Drop malformed frames silently, without leaking
    // payloads into logs or forwarding them to RPC dispatch.
    if (!Number.isSafeInteger(frame.id) || frame.id < 0 ||
        !Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > MAX_CHUNK_COUNT ||
        !Number.isSafeInteger(frame.seq) || frame.seq < 0 || frame.seq >= frame.count ||
        typeof frame.b64 !== "string" || frame.b64.length === 0 || frame.b64.length > 87384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.b64)) {
      this.dropChunkGroup(frame.id);
      return;
    }
    this.expireChunkGroups();
    let pending = this.chunkGroups.get(frame.id);
    if (pending && (pending.count !== frame.count || pending.dispatch !== dispatch)) {
      this.dropChunkGroup(frame.id);
      return;
    }
    if (pending?.parts[frame.seq] !== undefined) return;
    const bytes = frame.b64.length / 4 * 3 - (frame.b64.endsWith("==") ? 2 : frame.b64.endsWith("=") ? 1 : 0);
    let bufferedBytes = 0;
    for (const group of this.chunkGroups.values()) bufferedBytes += group.bytes;
    if (bufferedBytes + bytes > MAX_CHUNK_BYTES) {
      this.dropChunkGroup(frame.id);
      return;
    }
    if (!pending) {
      if (this.chunkGroups.size >= MAX_CHUNK_GROUPS) return;
      pending = {
        count: frame.count,
        parts: Array.from<string>({ length: frame.count }),
        received: 0,
        bytes: 0,
        expiresAt: Date.now() + CHUNK_TTL_MS,
        dispatch,
      };
      this.chunkGroups.set(frame.id, pending);
      if (this.chunkExpiryTimer === null) {
        this.chunkExpiryTimer = setInterval(() => this.expireChunkGroups(), 1000);
      }
    }
    pending.received++;
    pending.parts[frame.seq] = frame.b64;
    pending.bytes += bytes;
    if (pending.received < pending.count) return;

    this.dropChunkGroup(frame.id);
    let message: string;
    try {
      message = new TextDecoder().decode(this.base64PartsToBytes(pending.parts));
    } catch {
      return;
    }
    pending.dispatch(message);
  }

  private dropChunkGroup(id: number): void {
    this.chunkGroups.delete(id);
    if (this.chunkGroups.size === 0 && this.chunkExpiryTimer !== null) {
      clearInterval(this.chunkExpiryTimer);
      this.chunkExpiryTimer = null;
    }
  }

  private expireChunkGroups(): void {
    const now = Date.now();
    for (const [id, group] of this.chunkGroups) {
      if (group.expiresAt <= now) this.dropChunkGroup(id);
    }
  }

  private base64PartsToBytes(parts: string[]): Uint8Array {
    const chunks = parts.map((b64) => {
      const binary = atob(b64);
      const arr = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) arr[i] = binary.charCodeAt(i);
      return arr;
    });
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection) return;
    const peer = this.peerConnection;
    const generation = this.connectionGeneration;
    const isCurrent = () => generation === this.connectionGeneration && peer === this.peerConnection && !this.intentionalClose;

    try {
      let sdp = answer.sdp;

      // Verify certificate fingerprint from SDP before setting remote description
      // This happens BEFORE the DTLS handshake, providing early rejection of untrusted peers
      if (!this.options.skipCertificateVerification) {
        sdp = verifyAndSanitizeSdp(answer.sdp, this.options.remoteId);
        console.log("[WebRTCTransport] SDP fingerprint verified");
      }

      if (!isCurrent()) return;
      await peer.setRemoteDescription(
        new RTCSessionDescription({ type: answer.type, sdp }),
      );
      if (!isCurrent()) return;
      this.remoteDescriptionSet = true;

      // Process buffered ICE candidates
      for (const candidate of this.iceCandidateBuffer) {
        await peer.addIceCandidate(new RTCIceCandidate(candidate));
        if (!isCurrent()) return;
      }
      this.iceCandidateBuffer = [];
    } catch (error) {
      if (!isCurrent()) return;
      if (error instanceof CertificateVerificationError) {
        console.error(
          "[WebRTCTransport] Certificate verification failed:",
          error.message,
        );
        this.emit("error", error);
        this.cleanup();
        return;
      }
      console.error(
        "[WebRTCTransport] Error setting remote description:",
        error,
      );
    }
  }

  private async handleIceCandidate(
    candidate: RTCIceCandidateInit,
  ): Promise<void> {
    if (!this.peerConnection) return;

    if (this.remoteDescriptionSet) {
      try {
        await this.peerConnection.addIceCandidate(
          new RTCIceCandidate(candidate),
        );
      } catch (error) {
        console.error("[WebRTCTransport] Error adding ICE candidate:", error);
      }
    } else {
      // Buffer the candidate until remote description is set
      this.iceCandidateBuffer.push(candidate);
    }
  }

  private handlePeerDisconnected(): void {
    console.log("[WebRTCTransport] Peer disconnected");
    if (!this.intentionalClose && this.options.reconnect) {
      this.scheduleReconnect();
    } else {
      this.setState(TransportState.DISCONNECTED);
      this.emit("close", "Peer disconnected");
      this.cleanup();
    }
  }

  private handleConnectionFailure(): void {
    console.log("[WebRTCTransport] Connection failure detected");
    if (!this.intentionalClose && this.options.reconnect) {
      this.scheduleReconnect();
    } else {
      this.setState(TransportState.FAILED);
      this.emit("error", new Error("WebRTC connection failed"));
      this.cleanup();
    }
  }

  private waitForConnection(): Promise<void> {
    const dataChannel = this.dataChannel;
    if (!dataChannel) return Promise.reject(new Error("Connection canceled"));
    if (dataChannel.readyState === "open") return Promise.resolve();
    const generation = this.connectionGeneration;
    return new Promise((resolve, reject) => {
      const originalOnOpen = dataChannel.onopen;
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (this.cancelConnectionWait === cancel) this.cancelConnectionWait = null;
        dataChannel.onopen = originalOnOpen;
        if (error) reject(error); else resolve();
      };
      const cancel = () => finish(new Error("Connection canceled"));
      const timeout = setTimeout(() => finish(new Error("Connection timeout")), 30000);
      this.cancelConnectionWait = cancel;
      dataChannel.onopen = (event) => {
        if (generation !== this.connectionGeneration || this.intentionalClose) {
          cancel();
          return;
        }
        finish();
        originalOnOpen?.call(dataChannel, event);
      };
    });
  }

  private scheduleReconnect(): void {
    // Connection is down; cancel any pending backoff reset before we bail or retry.
    this.clearStableConnectionTimer();

    // One reconnect at a time: bail if a timer is pending or a connect is in flight.
    if (this.reconnectTimer || this.connectInFlight) {
      return;
    }

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      console.error(
        "[WebRTCTransport] Max reconnect attempts reached, giving up",
      );
      this.setState(TransportState.FAILED);
      return;
    }

    this.setState(TransportState.RECONNECTING);
    this.emit("close", "Connection lost, reconnecting...");

    const backoff = Math.min(
      this.options.reconnectDelay *
        Math.pow(this.options.reconnectDelayGrowth, this.reconnectAttempts),
      this.options.maxReconnectDelay,
    );
    // Jitter so reconnects don't line up at fixed intervals.
    const delay = Math.round(backoff * (0.5 + Math.random() * 0.5));

    console.log(
      `[WebRTCTransport] Scheduling reconnect attempt ${this.reconnectAttempts + 1} in ${delay}ms`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectAttempts++;
      // Clean up old connection first
      this.cleanup();
      // Attempt reconnection
      try {
        await this.connect();
      } catch (error) {
        console.error("[WebRTCTransport] Reconnect attempt failed:", error);
        // Schedule another reconnect attempt
        if (!this.intentionalClose && this.options.reconnect) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleBackoffReset(): void {
    this.clearStableConnectionTimer();
    this.stableConnectionTimer = setTimeout(() => {
      this.reconnectAttempts = 0;
      this.stableConnectionTimer = null;
    }, STABLE_CONNECTION_THRESHOLD_MS);
  }

  private clearStableConnectionTimer(): void {
    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }
  }

  private cleanup(): void {
    ++this.connectionGeneration;
    this.connectInFlight = false;
    this.cancelConnectionWait?.();
    this.cancelConnectionWait = null;
    // Cancel the pending backoff reset so it can't fire after teardown.
    this.clearStableConnectionTimer();

    if (this.dataChannel) {
      // Detach first so our own close doesn't fire onclose -> scheduleReconnect (the loop).
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onerror = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      // Detach first so close doesn't re-enter handleConnectionFailure().
      this.peerConnection.onicecandidate = null;
      this.peerConnection.oniceconnectionstatechange = null;
      this.peerConnection.onconnectionstatechange = null;
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.signaling.disconnect();
    this.remoteDescriptionSet = false;
    this.iceCandidateBuffer = [];

    this.chunkGroups.clear();
    if (this.chunkExpiryTimer !== null) clearInterval(this.chunkExpiryTimer);
    this.chunkExpiryTimer = null;
  }

  /**
   * Open an additional DataChannel alongside the API one, so a feature can use
   * the existing WebRTC connection for its own stream.
   *
   * @param label - Channel label the server routes on, e.g. "sendspin".
   */
  async openDataChannel(label: string): Promise<RTCDataChannel | null> {
    if (!this.peerConnection) {
      console.warn(
        `[WebRTCTransport] Cannot create ${label} channel: no peer connection`,
      );
      return null;
    }

    if (
      this.peerConnection.connectionState !== "connected" &&
      this.peerConnection.connectionState !== "connecting"
    ) {
      console.warn(
        `[WebRTCTransport] Cannot create ${label} channel: connection state is`,
        this.peerConnection.connectionState,
      );
      return null;
    }

    console.debug(`[WebRTCTransport] Creating ${label} DataChannel`);

    // Ordered for TCP-like behavior
    const channel = this.peerConnection.createDataChannel(label, {
      ordered: true,
    });

    // Wait for the channel to open
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.warn(`[WebRTCTransport] ${label} DataChannel open timeout`);
        reject(new Error(`${label} DataChannel open timeout`));
      }, 10000);

      channel.onopen = () => {
        clearTimeout(timeout);
        console.debug(`[WebRTCTransport] ${label} DataChannel opened`);
        resolve(channel);
      };

      channel.onerror = (event) => {
        clearTimeout(timeout);
        console.error(`[WebRTCTransport] ${label} DataChannel error:`, event);
        reject(new Error(`${label} DataChannel error`));
      };

      // If channel is already open (unlikely but possible), resolve immediately
      if (channel.readyState === "open") {
        clearTimeout(timeout);
        resolve(channel);
      }
    });
  }
}
