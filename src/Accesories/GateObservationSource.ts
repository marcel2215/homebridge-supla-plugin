export interface GateObservationSource {
  readonly coverage: 'native-app-commands-only';
  receive(message: Buffer, retained: boolean): void;
  disconnected(): void;
}

/** Optional read-only sidecar boundary. Native acceptance is interference, never a relay edge. */
export class NativeGateObserver implements GateObservationSource {
  public readonly coverage = 'native-app-commands-only';
  private session?: string;
  private sequence?: number;

  public constructor(
    private readonly deviceId: string,
    private readonly channelId: string,
    private readonly interference: () => void,
    private readonly gap: (reason: string) => void,
    private readonly now = Date.now,
  ) {}

  public receive(message: Buffer, retained: boolean): void {
    if (retained) {
      return;
    }
    try {
      if (message.length > 4096) {
        throw new Error('size');
      }
      const event = JSON.parse(message.toString());
      if (!event || event.version !== 1 || event.source !== 'native-srpc'
        || event.deviceId !== this.deviceId || event.channelId !== this.channelId
        || !['device-accepted', 'gap'].includes(event.kind)) {
        throw new Error('format');
      }
      if (event.kind === 'gap') {
        this.disconnected();
        return;
      }
      if (!Number.isFinite(event.observedAt) || this.now() - event.observedAt > 5000 || event.observedAt - this.now() > 1000) {
        throw new Error('chronology');
      }
      if (event.sessionId !== undefined || event.sequence !== undefined) {
        if (typeof event.sessionId !== 'string' || !event.sessionId || event.sessionId.length > 128
          || !Number.isSafeInteger(event.sequence) || event.sequence < 0) {
          throw new Error('sequence');
        }
        if (this.session === event.sessionId && this.sequence !== undefined && event.sequence <= this.sequence) {
          return;
        }
        const gap = this.session !== event.sessionId || this.sequence === undefined || event.sequence !== this.sequence + 1;
        this.session = event.sessionId;
        this.sequence = event.sequence;
        if (gap) {
          this.gap('native-observer-sequence-baseline-or-gap');
          return;
        }
      }
      this.interference();
    } catch {
      this.gap('native-observer-invalid-event');
    }
  }

  public disconnected(): void {
    this.session = undefined;
    this.sequence = undefined;
    this.gap('native-observer-disconnected');
  }
}
