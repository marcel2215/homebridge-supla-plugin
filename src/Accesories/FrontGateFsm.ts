import { randomUUID } from 'node:crypto';
import {
  applyEstimatedPulse, canStopBeforeEndpoint, GateEstimate, GateTarget, MotionDirection,
  positionAt, startMotion, targetDirection, unknownEstimate,
} from './GateEstimator';
import { DEFAULT_FRONT_GATE_TIMINGS, FrontGateTimingConfig, normalizeFrontGateTimings } from './FrontGateConfig';

export { DEFAULT_FRONT_GATE_TIMINGS, FrontGateTimingConfig } from './FrontGateConfig';
export { GateTarget, MotionDirection } from './GateEstimator';
export enum DoorCurrentState { OPEN = 0, CLOSED = 1, OPENING = 2, CLOSING = 3, STOPPED = 4 }
export enum DoorTargetState { OPEN = 0, CLOSED = 1 }

export interface GateClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
export const gateClock: GateClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: timer => clearTimeout(timer),
};
export interface FrontGateLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}
export interface GatePulseEffect {
  requestId: number;
  stepId: number;
  generation: number;
  correlationId: string;
}
export interface FrontGateIo {
  // Resolution means publication handling, never motor execution.
  pulseMotor(reason: string, effect: GatePulseEffect): Promise<void>;
  publishSnapshot(snapshot: FrontGateSnapshot): void;
  log: FrontGateLogger;
}
export type RequestOutcome = 'confirmed' | 'estimated' | 'unconfirmed' | 'failed' | 'cancelled' | 'rejected';
type PulseStep = 'start-opening' | 'start-closing' | 'stop-opening' | 'stop-closing' | 'unknown';
type RequestPhase = 'waiting' | 'publishing' | 'observing';
export interface GateRequestResult {
  id: number;
  target: GateTarget;
  attempts: number;
  pulseBudget: number;
  outcome: RequestOutcome;
  reason: string;
  endedAt: number;
}
type ActiveRequest = {
  id: number;
  target: GateTarget;
  generation: number;
  plan: readonly PulseStep[];
  attempts: number;
  nextStep: number;
  phase: RequestPhase;
  deadline: number;
};
export interface FrontGateSnapshot {
  available: boolean;
  transportConnected: boolean;
  controlConnected: boolean | null;
  sensorConnected: boolean | null;
  closedSensor: boolean | null;
  sensorFreshSinceOnline: boolean;
  observationEpoch: number;
  currentDoorState?: DoorCurrentState;
  targetDoorState?: DoorTargetState;
  requestedTarget: GateTarget | null;
  estimate: GateEstimate;
  position: { min: number; max: number };
  nextPulseDirection: MotionDirection | 'stop' | 'unknown';
  activeRequest: {
    id: number; target: GateTarget; attempts: number; pulseBudget: number; phase: RequestPhase; deadline: number;
  } | null;
  lastResult: GateRequestResult | null;
  note: string;
}
export interface ContactMetadata {
  retained?: boolean;
  // Monotonic receive time is not a measurement timestamp.
  receivedAt?: number;
  epoch?: number;
  stale?: boolean;
}
export class GateNotSentError extends Error {}

/** Estimates outlive requests. Only requestHomeKitTarget may create an actuator plan. */
export class FrontGateFsm {
  private readonly instanceId = randomUUID();
  private readonly timings: FrontGateTimingConfig;
  private readonly pulseGapMs: number;
  private transportConnected = false;
  private controlConnected: boolean | null = null;
  private sensorConnected: boolean | null = null;
  private closedSensor: boolean | null = null;
  private sensorFreshSinceOnline = false;
  private observationEpoch = 0;
  private generation = 0;
  private nextRequestId = 0;
  private activeRequest?: ActiveRequest;
  private lastResult: GateRequestResult | null = null;
  private estimate: GateEstimate = unknownEstimate();
  private lastPossibleActuationAt = -Infinity;
  private lastContactAt = -Infinity;
  private contactRevision = 0;
  private lastLocalEffect?: GatePulseEffect & { attemptedAt: number; observed: boolean };
  private movementTimer?: ReturnType<typeof setTimeout>;
  private stepTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private requestTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  public constructor(
    private readonly io: FrontGateIo,
    timings: Partial<FrontGateTimingConfig> = DEFAULT_FRONT_GATE_TIMINGS,
    private readonly clock: GateClock = gateClock,
  ) {
    this.timings = normalizeFrontGateTimings(timings, message => io.log.warn(message));
    this.pulseGapMs = Math.max(
      this.timings.minimumPulseGapMs, this.timings.reversePauseMs,
      this.timings.relayHighMs + this.timings.relayReleaseMarginMs + this.timings.actuationDelayMs,
    );
    this.emitSnapshot('initialized');
  }

  public dispose(): void {
    this.finishRequest('cancelled', 'disposed');
    this.setEstimate(unknownEstimate());
    this.disposed = true;
  }

  public handleTransportConnectedChange(connected: boolean, resetEpoch = false): void {
    if (this.disposed || (this.transportConnected === connected && !resetEpoch)) {
      return;
    }
    this.transportConnected = connected;
    if (!connected) {
      this.controlConnected = null;
      this.sensorConnected = null;
      this.loseObservations('transport-or-subscription-lost');
    } else {
      // Retained baselines may precede SUBACK/connected packets in the same epoch.
      this.emitSnapshot('transport-ready');
    }
  }

  public handleControlConnectedChange(connected: boolean): void {
    if (this.disposed || this.controlConnected === connected) {
      return;
    }
    this.controlConnected = connected;
    if (!connected) {
      this.loseObservations('control-offline');
    } else {
      this.emitSnapshot('control-online');
    }
  }

  public handleSensorConnectedChange(connected: boolean): void {
    if (this.disposed || this.sensorConnected === connected) {
      return;
    }
    this.sensorConnected = connected;
    if (!connected) {
      this.loseObservations('sensor-offline');
    } else {
      this.emitSnapshot('sensor-online');
    }
  }

  public handleInvalidContact(): void {
    if (!this.disposed) {
      this.loseObservations('invalid-contact');
    }
  }

  /** Block a pending reversal immediately while the adapter debounces a contact edge. */
  public handleContactTransition(): void {
    const request = this.activeRequest;
    if (request && request.nextStep < request.plan.length) {
      this.finishRequest('cancelled', 'contact-transition-during-plan');
      this.setEstimate(unknownEstimate());
      this.emitSnapshot('contact-transition-during-plan');
    }
  }

  public handleClosedSensorChange(closed: boolean, metadata: ContactMetadata = {}): void {
    const now = this.clock.now();
    const receivedAt = metadata.receivedAt ?? now;
    if (this.disposed || metadata.stale || (metadata.epoch !== undefined && metadata.epoch !== this.observationEpoch)
      || !Number.isFinite(receivedAt) || receivedAt < this.lastContactAt || receivedAt > now
      || this.controlConnected === false || this.sensorConnected === false) {
      return;
    }
    if (metadata.retained && (this.sensorFreshSinceOnline || this.activeRequest
      || this.estimate.kind === 'moving' || this.estimate.kind === 'stopped')) {
      return;
    }
    const previous = this.closedSensor;
    const wasFresh = this.sensorFreshSinceOnline;
    if (closed && previous === true && this.estimate.kind === 'moving' && this.estimate.direction === 'opening'
      && receivedAt - this.estimate.startedAt < this.timings.departureGraceMs) {
      return;
    }
    this.closedSensor = closed;
    this.contactRevision += 1;
    this.lastContactAt = receivedAt;
    this.sensorFreshSinceOnline = true;
    if (closed) {
      this.setEstimate({ kind: 'closed', evidence: 'contact-confirmed' });
      const target = this.activeRequest?.target;
      this.finishRequest(target === 'closed' ? 'confirmed' : 'failed', target === 'closed' ? 'closed-contact' : 'target-mismatch-closed');
      // CLOSED is a terminal barrier, including when OPEN was requested.
      this.generation += 1;
      this.emitSnapshot('closed-contact');
      return;
    }
    if (wasFresh && previous === true && !metadata.retained) {
      if (this.estimate.kind === 'moving' && this.estimate.direction === 'opening') {
        this.setEstimate({ ...this.estimate, evidence: 'departure-observed' });
      } else if (this.estimate.kind === 'closed') {
        this.lastPossibleActuationAt = now;
        this.finishRequest('cancelled', 'external-departure');
        const maximumDeparturePosition = Math.min(1,
          this.timings.sensorDelayMs / (this.timings.openingTravelMs * (1 - this.timings.travelUncertainty)),
        );
        this.setEstimate(startMotion(
          { min: 0, max: maximumDeparturePosition }, 'opening', receivedAt, this.timings, 'departure-observed', 0,
        ));
      } else {
        this.finishRequest('cancelled', 'unexpected-contact-release');
        this.setEstimate(unknownEstimate());
      }
    } else if (!wasFresh || this.estimate.kind === 'closed') {
      this.setEstimate(unknownEstimate());
    }
    this.emitSnapshot('not-closed-contact');
  }

  public handleCommandIntent(origin: 'external' | 'ambiguous', reason = 'mqtt-intent'): void {
    if (this.disposed) {
      return;
    }
    this.lastPossibleActuationAt = this.clock.now();
    this.finishRequest('cancelled', `${origin}-${reason}`);
    this.generation += 1;
    this.setEstimate(unknownEstimate());
    this.emitSnapshot(`${origin}-${reason}`);
  }

  public handleObservationGap(reason = 'observer-gap'): void {
    this.handleCommandIntent('ambiguous', reason);
  }

  /** Genuinely observed motor-input edges only; raw MQTT intents must never call this. */
  public handleAppliedPulse(correlationId?: string, occurredAt = this.clock.now()): void {
    if (this.disposed) {
      return;
    }
    const now = this.clock.now();
    if (correlationId && correlationId === this.lastLocalEffect?.correlationId) {
      if (this.lastLocalEffect.observed || this.lastLocalEffect.generation !== this.generation) {
        return;
      }
      if (occurredAt < this.lastLocalEffect.attemptedAt || occurredAt > this.lastLocalEffect.attemptedAt + this.timings.actuationDelayMs
        || occurredAt > now || now - occurredAt > 250) {
        this.handleObservationGap('own-relay-edge-outside-timing-window');
        return;
      }
      this.lastLocalEffect.observed = true;
      this.lastPossibleActuationAt = now;
      if (this.estimate.kind !== 'unknown' && this.estimate.kind !== 'closed') {
        this.setEstimate({ ...this.estimate, evidence: 'relay-observed' });
        this.emitSnapshot('own-relay-edge');
      }
      return;
    }
    const previousPossibleActuationAt = this.lastPossibleActuationAt;
    this.lastPossibleActuationAt = now;
    const inFlight = this.activeRequest?.phase === 'publishing';
    this.finishRequest('cancelled', 'external-relay-edge');
    this.generation += 1;
    const overlapsDeparture = this.estimate.kind === 'moving' && this.estimate.evidence === 'departure-observed'
      && occurredAt <= this.estimate.startedAt;
    if (!this.isAvailable() || inFlight || occurredAt > now || now - occurredAt > 250
      || occurredAt < previousPossibleActuationAt || overlapsDeparture) {
      this.setEstimate(unknownEstimate());
    } else {
      this.setEstimate(applyEstimatedPulse(this.estimate, occurredAt, this.timings, 'relay-observed', 0));
    }
    this.emitSnapshot('external-relay-edge');
  }

  /** Finite SET response: resolve on acceptance; subsequent publication/travel results use snapshots. */
  public async requestHomeKitTarget(target: GateTarget): Promise<void> {
    if (this.disposed) {
      throw new Error('front gate controller is disposed');
    }
    this.expireMovement();
    if (this.activeRequest?.target === target) {
      return;
    }
    if (this.activeRequest?.phase === 'publishing') {
      this.setEstimate(unknownEstimate());
    }
    this.finishRequest('cancelled', 'superseded');
    const id = ++this.nextRequestId;
    let plan: readonly PulseStep[];
    try {
      if (!this.isAvailable()) {
        throw new Error('front gate controller is unavailable');
      }
      plan = this.planRequest(target);
    } catch (error) {
      this.lastResult = {
        id, target, attempts: 0, pulseBudget: 0, outcome: 'rejected', endedAt: this.clock.now(), reason: (error as Error).message,
      };
      this.io.log.warn(`gate request ${JSON.stringify(this.lastResult)}`);
      this.emitSnapshot('request-rejected');
      throw error;
    }
    const maximumTravel = Math.max(this.timings.openingTravelMs, this.timings.closingTravelMs) * (1 + this.timings.travelUncertainty);
    const deadline = this.clock.now() + maximumTravel + this.timings.actuationDelayMs
      + this.timings.sensorDelayMs + this.timings.sensorDebounceMs
      + (plan.length + 1) * (this.pulseGapMs + this.timings.publishTimeoutMs);
    const request: ActiveRequest = {
      id, target, generation: ++this.generation, plan: Object.freeze([...plan]), attempts: 0, nextStep: 0, phase: 'waiting', deadline,
    };
    this.activeRequest = request;
    this.requestTimer = this.clock.setTimeout(() => {
      if (this.isCurrent(request)) {
        this.setEstimate(unknownEstimate());
        this.finishRequest('unconfirmed', 'request-deadline');
      }
    }, deadline - this.clock.now());
    if (!plan.length) {
      if (this.estimate.kind === 'closed' || this.estimate.kind === 'open') {
        this.finishRequest(this.estimate.kind === 'closed' ? 'confirmed' : 'estimated', 'already-at-target');
      } else {
        request.phase = 'observing';
      }
    } else {
      this.scheduleStep(request);
    }
    this.emitSnapshot('request-accepted');
  }

  public getSnapshot(): FrontGateSnapshot {
    const estimate = this.estimate;
    const request = this.activeRequest;
    const available = this.isAvailable();
    const current = estimate.kind === 'closed' ? DoorCurrentState.CLOSED
      : estimate.kind === 'open' ? DoorCurrentState.OPEN
        : estimate.kind === 'moving' ? (estimate.direction === 'opening' ? DoorCurrentState.OPENING : DoorCurrentState.CLOSING)
          : DoorCurrentState.STOPPED;
    return {
      available, transportConnected: this.transportConnected,
      controlConnected: this.controlConnected, sensorConnected: this.sensorConnected,
      closedSensor: this.closedSensor, sensorFreshSinceOnline: this.sensorFreshSinceOnline, observationEpoch: this.observationEpoch,
      currentDoorState: available ? current : undefined,
      targetDoorState: available ? (request ? (request.target === 'closed' ? DoorTargetState.CLOSED : DoorTargetState.OPEN)
        : estimate.kind === 'closed' ? DoorTargetState.CLOSED : DoorTargetState.OPEN) : undefined,
      requestedTarget: request?.target ?? null,
      estimate: structuredClone(estimate), position: positionAt(estimate, this.clock.now(), this.timings),
      nextPulseDirection: estimate.kind === 'closed' ? 'opening' : estimate.kind === 'open' ? 'closing'
        : estimate.kind === 'stopped' ? estimate.nextDirection : estimate.kind === 'moving' ? 'stop' : 'unknown',
      activeRequest: request ? {
        id: request.id, target: request.target, attempts: request.attempts, pulseBudget: request.plan.length,
        phase: request.phase, deadline: request.deadline,
      } : null,
      lastResult: this.lastResult ? { ...this.lastResult } : null, note: 'snapshot',
    };
  }

  private planRequest(target: GateTarget): readonly PulseStep[] {
    const direction = targetDirection(target);
    switch (this.estimate.kind) {
      case 'closed': return target === 'closed' ? [] : ['start-opening'];
      case 'open': return target === 'open' ? [] : ['start-closing'];
      case 'unknown':
        if (this.timings.unknownTargetPolicy === 'single_pulse_best_effort') {
          return ['unknown'];
        }
        throw new Error('direction unknown; a fresh closed anchor or explicit single-pulse policy is required');
      case 'stopped':
        if (this.estimate.nextDirection === direction && this.estimate.position.min > 0 && this.estimate.position.max < 1) {
          return [`start-${direction}`];
        }
        throw new Error('stopped next direction or endpoint is uncertain; wrong-way maneuvers are disabled');
      case 'moving':
        if (this.estimate.direction === direction) {
          return [];
        }
        if (this.timings.allowSpeculativeSequences && canStopBeforeEndpoint(this.estimate, this.clock.now(), this.timings)) {
          return [`stop-${this.estimate.direction}`, `start-${direction}`];
        }
        throw new Error('reversal requires speculative-sequence opt-in and an unambiguous remaining-travel interval');
    }
  }

  private scheduleStep(request: ActiveRequest): void {
    if (!this.isCurrent(request)) {
      return;
    }
    request.phase = 'waiting';
    const delay = Math.max(0, this.lastPossibleActuationAt + this.pulseGapMs - this.clock.now());
    if (delay === 0) {
      this.executeStep(request);
    } else {
      this.stepTimer = this.clock.setTimeout(() => {
        this.stepTimer = undefined;
        this.executeStep(request);
      }, delay);
    }
  }

  private stepStillValid(step: PulseStep): boolean {
    const estimate = this.estimate;
    if (step === 'unknown') {
      return estimate.kind === 'unknown';
    }
    if (step.startsWith('stop-')) {
      return estimate.kind === 'moving' && step === `stop-${estimate.direction}`
        && canStopBeforeEndpoint(estimate, this.clock.now(), this.timings);
    }
    if (estimate.kind === 'closed') {
      return step === 'start-opening';
    }
    if (estimate.kind === 'open') {
      return step === 'start-closing';
    }
    return estimate.kind === 'stopped' && step === `start-${estimate.nextDirection}`
      && estimate.position.min > 0 && estimate.position.max < 1;
  }

  private executeStep(request: ActiveRequest): void {
    this.expireMovement();
    if (!this.isCurrent(request)) {
      return;
    }
    const step = request.plan[request.nextStep];
    if (!this.isAvailable() || this.clock.now() >= request.deadline || !step || request.attempts >= request.plan.length
      || !this.stepStillValid(step)) {
      this.finishRequest('cancelled', 'step-precondition-changed');
      return;
    }
    if (this.clock.now() < this.lastPossibleActuationAt + this.pulseGapMs) {
      this.scheduleStep(request);
      return;
    }
    const before = this.estimate;
    const contactRevision = this.contactRevision;
    request.phase = 'publishing';
    request.attempts += 1;
    request.nextStep += 1;
    const effect = {
      requestId: request.id, stepId: request.nextStep, generation: request.generation,
      correlationId: `${this.instanceId}:${request.generation}:${request.id}:${request.nextStep}`,
    };
    this.lastLocalEffect = { ...effect, attemptedAt: this.clock.now(), observed: false };
    this.lastPossibleActuationAt = this.clock.now();
    this.setEstimate(applyEstimatedPulse(before, this.clock.now(), this.timings, 'attempted-unconfirmed'));
    this.io.log.info(`gate publication attempt ${JSON.stringify({ ...effect, step, pulseBudget: request.plan.length })}`);
    this.publishTimer = this.clock.setTimeout(() => {
      if (this.isCurrent(request) && request.phase === 'publishing') {
        this.setEstimate(unknownEstimate());
        this.finishRequest('unconfirmed', 'publication-timeout-delivery-ambiguous');
      }
    }, this.timings.publishTimeoutMs);
    let publication: Promise<void>;
    try {
      publication = this.io.pulseMotor(step, effect);
    } catch (error) {
      publication = Promise.reject(error);
    }
    void publication.then(() => {
      if (!this.isCurrent(request)) {
        return;
      }
      this.clearTimer('publishTimer');
      request.phase = 'observing';
      if (this.estimate.evidence === 'attempted-unconfirmed') {
        this.setEstimate({ ...this.estimate, evidence: 'published-unconfirmed' });
      }
      if (request.nextStep < request.plan.length) {
        this.scheduleStep(request);
      }
      this.emitSnapshot('published-unconfirmed');
    }, error => {
      if (!this.isCurrent(request)) {
        return;
      }
      this.setEstimate(error instanceof GateNotSentError && contactRevision === this.contactRevision ? before : unknownEstimate());
      this.finishRequest('unconfirmed', error instanceof GateNotSentError ? 'not-sent' : 'publication-error-delivery-ambiguous');
    });
    this.emitSnapshot('publication-started');
  }

  /** Terminal barrier: this function cannot plan, schedule, or send a pulse. */
  private finishRequest(outcome: RequestOutcome, reason: string): void {
    const request = this.activeRequest;
    this.clearTimer('stepTimer');
    this.clearTimer('publishTimer');
    this.clearTimer('requestTimer');
    if (!request) {
      return;
    }
    this.activeRequest = undefined;
    this.generation += 1;
    this.lastResult = {
      id: request.id, target: request.target, attempts: request.attempts, pulseBudget: request.plan.length,
      outcome, reason, endedAt: this.clock.now(),
    };
    this.io.log.info(`gate request ${JSON.stringify(this.lastResult)}`);
    this.emitSnapshot(reason);
  }

  private isCurrent(request: ActiveRequest): boolean {
    return !this.disposed && this.activeRequest === request && this.generation === request.generation;
  }

  private isAvailable(): boolean {
    return !this.disposed && this.transportConnected && this.controlConnected === true && this.sensorConnected === true
      && this.sensorFreshSinceOnline && this.closedSensor !== null;
  }

  private loseObservations(reason: string): void {
    this.finishRequest('cancelled', reason);
    this.generation += 1;
    this.observationEpoch += 1;
    this.sensorFreshSinceOnline = false;
    this.closedSensor = null;
    this.lastContactAt = -Infinity;
    this.setEstimate(unknownEstimate());
    this.emitSnapshot(reason);
  }

  private setEstimate(estimate: GateEstimate): void {
    this.clearTimer('movementTimer');
    this.estimate = estimate;
    if (estimate.kind === 'moving' && !this.disposed) {
      this.movementTimer = this.clock.setTimeout(() => {
        if (this.estimate === estimate) {
          if (this.clock.now() < this.movementDeadline(estimate)) {
            // Runtime timers may truncate fractional milliseconds or wake early.
            this.setEstimate(estimate);
          } else {
            this.expireMovement();
          }
        }
      }, Math.max(1, this.movementDeadline(estimate) - this.clock.now()));
    }
  }

  private expireMovement(): void {
    const estimate = this.estimate;
    if (estimate.kind !== 'moving' || this.clock.now() < this.movementDeadline(estimate)) {
      return;
    }
    const estimatedOpen = estimate.direction === 'opening' && this.timings.assumeOpenAfterTravel
      && this.closedSensor === false && this.activeRequest?.phase !== 'publishing';
    this.setEstimate(estimatedOpen ? { kind: 'open', evidence: estimate.evidence } : unknownEstimate());
    if (estimatedOpen && this.activeRequest?.target === 'closed') {
      this.finishRequest('failed', 'target-mismatch-open');
    } else {
      this.finishRequest(estimatedOpen ? 'estimated' : 'unconfirmed', estimatedOpen ? 'estimated-open' : 'travel-ended-unconfirmed');
    }
    this.emitSnapshot('travel-ended');
  }

  private movementDeadline(estimate: Extract<GateEstimate, { kind: 'moving' }>): number {
    return estimate.latestEnd + (estimate.direction === 'closing' ? this.timings.sensorDelayMs + this.timings.sensorDebounceMs : 0);
  }

  private clearTimer(name: 'movementTimer' | 'stepTimer' | 'publishTimer' | 'requestTimer'): void {
    const timer = this[name];
    if (timer !== undefined) {
      this.clock.clearTimeout(timer);
      this[name] = undefined;
    }
  }

  private emitSnapshot(note: string): void {
    if (!this.disposed) {
      this.io.publishSnapshot({ ...this.getSnapshot(), note });
    }
  }
}
