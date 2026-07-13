export type GateTarget = 'open' | 'closed';
export type MotionDirection = 'opening' | 'closing';
export type UnknownOpenPolicy = 'reject' | 'accept_non_closed';
export type UnknownClosePolicy = 'reject' | 'single_pulse_best_effort' | 'seek_closed';

export const enum DoorCurrentState {
  OPEN = 0,
  CLOSED = 1,
  OPENING = 2,
  CLOSING = 3,
  STOPPED = 4,
}

export const enum DoorTargetState {
  OPEN = 0,
  CLOSED = 1,
}

export interface FrontGateConfig {
  fullTravelMs: number;
  reversePauseMs: number;
  minimumPulseGapMs: number;
  unknownOpenPolicy: UnknownOpenPolicy;
  unknownClosePolicy: UnknownClosePolicy;
  seekClosedMaxPulses: number;
  assumeOpenAfterTravel: boolean;
}

export const DEFAULT_FRONT_GATE_CONFIG: FrontGateConfig = {
  fullTravelMs: 25000,
  reversePauseMs: 3000,
  minimumPulseGapMs: 3000,
  unknownOpenPolicy: 'reject',
  unknownClosePolicy: 'reject',
  seekClosedMaxPulses: 3,
  assumeOpenAfterTravel: false,
};

export type FrontGateErrorCode =
  | 'unavailable'
  | 'not_allowed'
  | 'resource_busy'
  | 'communication_failure'
  | 'operation_timed_out';

export class FrontGateError extends Error {
  public constructor(
    public readonly code: FrontGateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FrontGateError';
  }
}

export type PositionEstimateKind =
  | 'closed'
  | 'openingKnown'
  | 'closingKnown'
  | 'reversalPause'
  | 'notClosedUnknown'
  | 'openAssumed';

export type FrontGateOperationKind = 'none' | 'scheduledPulse' | 'reversalPause' | 'seekClosed';

export interface FrontGateSnapshot {
  available: boolean;
  transportConnected: boolean;
  controlConnected: boolean | null;
  sensorConnected: boolean | null;
  closedSensor: boolean | null;
  observationEpoch: number;
  sensorSampleEpoch: number | null;
  currentDoorState?: DoorCurrentState;
  targetDoorState?: DoorTargetState;
  desiredTarget: GateTarget | null;
  positionEstimate: PositionEstimateKind;
  motionDirection: MotionDirection | 'none';
  operationKind: FrontGateOperationKind;
  note: string;
}

export interface FrontGateLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface FrontGateIo {
  pulseMotor(reason: string): Promise<void>;
  publishSnapshot(snapshot: FrontGateSnapshot): void;
  log: FrontGateLogger;
}

export interface FrontGateScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

type PositionEstimate =
  | { kind: 'closed' }
  | { kind: 'openingKnown'; startedAt: number; epoch: number }
  | { kind: 'closingKnown'; startedAt: number; epoch: number }
  | { kind: 'reversalPause' }
  | { kind: 'notClosedUnknown' }
  | { kind: 'openAssumed' };

type PulsePurpose =
  | { kind: 'startOpening' }
  | { kind: 'startClosing' }
  | { kind: 'bestEffortClose' }
  | { kind: 'stopOpeningAtClosed' }
  | { kind: 'stopAndReverse'; finalDirection: MotionDirection }
  | { kind: 'seekClosed'; pulseNumber: number; maxPulses: number };

type ScheduledPulseOperation = {
  kind: 'scheduledPulse';
  id: number;
  epoch: number;
  dueAt: number;
  target: GateTarget;
  expectedPosition: PositionEstimateKind;
  purpose: PulsePurpose;
};

type ReversalPauseOperation = {
  kind: 'reversalPause';
  id: number;
  epoch: number;
  dueAt: number;
  target: GateTarget;
  finalDirection: MotionDirection;
};

type SeekClosedOperation = {
  kind: 'seekClosed';
  id: number;
  epoch: number;
  dueAt: number;
  target: 'closed';
  pulsesUsed: number;
  maxPulses: number;
};

type Operation =
  | { kind: 'none' }
  | ScheduledPulseOperation
  | ReversalPauseOperation
  | SeekClosedOperation;

type GateFacts = {
  transportConnected: boolean;
  controlConnected: boolean | null;
  sensorConnected: boolean | null;
  closedSensor: boolean | null;
};

const SYSTEM_SCHEDULER: FrontGateScheduler = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function targetForDirection(direction: MotionDirection): GateTarget {
  return direction === 'opening' ? 'open' : 'closed';
}

export class FrontGateFsm {
  private readonly config: FrontGateConfig;
  private readonly scheduler: FrontGateScheduler;

  private facts: GateFacts = {
    transportConnected: false,
    controlConnected: null,
    sensorConnected: null,
    closedSensor: null,
  };

  private observationEpoch = 1;
  private sensorSampleEpoch: number | null = null;
  private previousSensorInEpoch: boolean | null = null;
  private desiredTarget: GateTarget | null = null;
  private position: PositionEstimate = { kind: 'notClosedUnknown' };
  private positionGeneration = 0;
  private operation: Operation = { kind: 'none' };
  private nextOperationId = 0;
  private lastPublishedPulseAt = 0;
  private cancelMovementTimer?: () => void;
  private cancelOperationTimer?: () => void;
  private sequence = Promise.resolve<void>(undefined);
  private disposed = false;

  public constructor(
    private readonly io: FrontGateIo,
    config: Partial<FrontGateConfig> = DEFAULT_FRONT_GATE_CONFIG,
    scheduler: FrontGateScheduler = SYSTEM_SCHEDULER,
  ) {
    this.config = {
      fullTravelMs: clampInt(
        config.fullTravelMs ?? DEFAULT_FRONT_GATE_CONFIG.fullTravelMs,
        DEFAULT_FRONT_GATE_CONFIG.fullTravelMs,
        1,
        120000,
      ),
      reversePauseMs: clampInt(
        config.reversePauseMs ?? DEFAULT_FRONT_GATE_CONFIG.reversePauseMs,
        DEFAULT_FRONT_GATE_CONFIG.reversePauseMs,
        0,
        15000,
      ),
      minimumPulseGapMs: clampInt(
        config.minimumPulseGapMs ?? DEFAULT_FRONT_GATE_CONFIG.minimumPulseGapMs,
        DEFAULT_FRONT_GATE_CONFIG.minimumPulseGapMs,
        0,
        15000,
      ),
      unknownOpenPolicy: config.unknownOpenPolicy ?? DEFAULT_FRONT_GATE_CONFIG.unknownOpenPolicy,
      unknownClosePolicy: config.unknownClosePolicy ?? DEFAULT_FRONT_GATE_CONFIG.unknownClosePolicy,
      seekClosedMaxPulses: clampInt(
        config.seekClosedMaxPulses ?? DEFAULT_FRONT_GATE_CONFIG.seekClosedMaxPulses,
        DEFAULT_FRONT_GATE_CONFIG.seekClosedMaxPulses,
        1,
        3,
      ),
      assumeOpenAfterTravel: config.assumeOpenAfterTravel ?? DEFAULT_FRONT_GATE_CONFIG.assumeOpenAfterTravel,
    };
    this.scheduler = scheduler;
    this.emitSnapshot('fsm-initialized');
  }

  public dispose(): void {
    this.disposed = true;
    this.clearMovementTimer();
    this.clearOperation();
  }

  public handleTransportConnectedChange(connected: boolean): void {
    void this.enqueue(`transport-connected=${connected}`, () => {
      this.applyTransportConnectedChange(connected);
    });
  }

  public handleControlConnectedChange(connected: boolean): void {
    void this.enqueue(`control-connected=${connected}`, () => {
      this.applyControlConnectedChange(connected);
    });
  }

  public handleSensorConnectedChange(connected: boolean): void {
    void this.enqueue(`sensor-connected=${connected}`, () => {
      this.applySensorConnectedChange(connected);
    });
  }

  public handleClosedSensorChange(closed: boolean): void {
    void this.enqueue(`closed-sensor=${closed}`, () => {
      this.applyClosedSensorChange(closed);
    });
  }

  public handleObservedExternalPulse(reason = 'mqtt-execute_action'): void {
    void this.enqueue(`external-pulse=${reason}`, () => {
      this.applyObservedExternalPulse(reason);
    });
  }

  public requestHomeKitTarget(target: GateTarget): Promise<void> {
    return this.enqueue(`homekit-target=${target}`, async () => {
      await this.applyHomeKitTarget(target);
    });
  }

  public getSnapshot(): FrontGateSnapshot {
    return this.buildSnapshot('snapshot-requested');
  }

  public whenIdle(): Promise<void> {
    return this.sequence;
  }

  private enqueue(label: string, task: () => Promise<void> | void): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const run = this.sequence.then(async () => {
      if (!this.disposed) {
        await task();
      }
    });

    this.sequence = run.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.io.log.warn(`front-gate sequence '${label}' failed: ${message}`);
    });

    return run;
  }

  private applyTransportConnectedChange(connected: boolean): void {
    if (this.facts.transportConnected === connected) {
      return;
    }

    this.facts.transportConnected = connected;
    if (!connected) {
      this.facts.controlConnected = null;
      this.facts.sensorConnected = null;
      this.advanceObservationEpoch('mqtt-transport-offline');
      return;
    }

    this.io.log.info('front gate MQTT transport connected');
    this.emitSnapshot('mqtt-transport-online-awaiting-channel-state');
  }

  private applyControlConnectedChange(connected: boolean): void {
    if (this.facts.controlConnected === connected) {
      return;
    }

    this.facts.controlConnected = connected;
    if (!connected) {
      this.advanceObservationEpoch('control-channel-offline');
      return;
    }

    this.io.log.info('front gate control channel connected');
    this.emitSnapshot('control-channel-online');
  }

  private applySensorConnectedChange(connected: boolean): void {
    if (this.facts.sensorConnected === connected) {
      return;
    }

    this.facts.sensorConnected = connected;
    if (!connected) {
      this.advanceObservationEpoch('sensor-channel-offline');
      return;
    }

    this.io.log.info('front gate sensor channel connected');
    this.emitSnapshot('sensor-channel-online');
  }

  private applyClosedSensorChange(closed: boolean): void {
    const hadSampleInEpoch = this.sensorSampleEpoch === this.observationEpoch;
    const previous = hadSampleInEpoch ? this.previousSensorInEpoch : null;

    this.facts.closedSensor = closed;
    this.sensorSampleEpoch = this.observationEpoch;
    this.previousSensorInEpoch = closed;

    if (!hadSampleInEpoch) {
      this.clearOperation();
      if (closed) {
        this.setPosition({ kind: 'closed' });
        if (this.desiredTarget === 'closed') {
          this.desiredTarget = null;
        }
      } else {
        this.setPosition({ kind: 'notClosedUnknown' });
      }
      this.emitSnapshot('sensor-baseline-established');
      return;
    }

    if (previous === closed) {
      return;
    }

    this.clearOperation();
    if (closed) {
      this.io.log.info('closed sensor is TRUE -> gate is fully closed');
      this.setPosition({ kind: 'closed' });
      if (this.desiredTarget === 'closed') {
        this.desiredTarget = null;
      }
      this.emitSnapshot('closed-sensor-true');
      return;
    }

    this.io.log.info('closed sensor changed TRUE -> FALSE in the current observation epoch');
    this.setKnownMovement('opening');
    this.emitSnapshot('closed-sensor-opening-edge');
  }

  private async applyHomeKitTarget(target: GateTarget): Promise<void> {
    if (!this.isAvailableForHomeKit()) {
      throw new FrontGateError('unavailable', 'front gate controller is not available');
    }

    if (this.operation.kind !== 'none') {
      if (this.operation.target === target) {
        this.desiredTarget = target;
        this.emitSnapshot(`homekit-${target}-already-accepted`);
        return;
      }
      this.cancelConflictingOperation();
    }

    const previousTarget = this.desiredTarget;
    try {
      const note = target === 'open'
        ? await this.acceptOpenRequest()
        : await this.acceptCloseRequest();
      this.desiredTarget = this.position.kind === 'closed' && target === 'closed' ? null : target;
      this.emitSnapshot(note);
    } catch (error) {
      this.desiredTarget = previousTarget;
      this.emitSnapshot(`homekit-${target}-rejected`);
      throw error;
    }
  }

  private async acceptOpenRequest(): Promise<string> {
    switch (this.position.kind) {
      case 'closed':
        return this.acceptPulse({ kind: 'startOpening' }, 'open');
      case 'openingKnown':
      case 'openAssumed':
        return 'open-request-already-satisfied-or-in-progress';
      case 'closingKnown':
        return this.acceptPulse({ kind: 'stopAndReverse', finalDirection: 'opening' }, 'open');
      case 'reversalPause':
      case 'notClosedUnknown':
        if (this.config.unknownOpenPolicy === 'accept_non_closed') {
          return 'unknown-open-request-accepted-as-non-closed';
        }
        throw new FrontGateError(
          'not_allowed',
          'cannot safely open the front gate because its direction and position are unknown',
        );
    }
  }

  private async acceptCloseRequest(): Promise<string> {
    switch (this.position.kind) {
      case 'closed':
        return 'close-request-already-satisfied';
      case 'closingKnown':
        return 'close-request-already-in-progress';
      case 'openingKnown':
        if (this.facts.closedSensor === true) {
          return this.acceptPulse({ kind: 'stopOpeningAtClosed' }, 'closed');
        }
        return this.acceptPulse({ kind: 'stopAndReverse', finalDirection: 'closing' }, 'closed');
      case 'openAssumed':
        return this.acceptPulse({ kind: 'startClosing' }, 'closed');
      case 'reversalPause':
      case 'notClosedUnknown':
        return this.acceptUnknownCloseRequest();
    }
  }

  private async acceptUnknownCloseRequest(): Promise<string> {
    if (this.desiredTarget === 'closed') {
      throw new FrontGateError(
        'not_allowed',
        'the previous close request remains unconfirmed; refusing to repeat a non-idempotent toggle',
      );
    }

    switch (this.config.unknownClosePolicy) {
      case 'single_pulse_best_effort':
        return this.acceptPulse({ kind: 'bestEffortClose' }, 'closed');
      case 'seek_closed':
        return this.acceptPulse({
          kind: 'seekClosed',
          pulseNumber: 1,
          maxPulses: this.config.seekClosedMaxPulses,
        }, 'closed');
      case 'reject':
        throw new FrontGateError(
          'not_allowed',
          'cannot safely close the front gate because its direction and position are unknown',
        );
    }
  }

  private async acceptPulse(purpose: PulsePurpose, target: GateTarget): Promise<string> {
    const now = this.scheduler.now();
    const dueAt = Math.max(now, this.lastPublishedPulseAt + this.config.minimumPulseGapMs);
    const operation: ScheduledPulseOperation = {
      kind: 'scheduledPulse',
      id: ++this.nextOperationId,
      epoch: this.observationEpoch,
      dueAt,
      target,
      expectedPosition: this.position.kind,
      purpose,
    };

    this.setOperation(operation);
    if (dueAt > now) {
      this.scheduleOperationTimer(operation);
      return `${purpose.kind}-scheduled`;
    }

    await this.executeScheduledPulse(operation, true);
    return `${purpose.kind}-published`;
  }

  private async executeScheduledPulse(operation: ScheduledPulseOperation, propagateError: boolean): Promise<void> {
    if (!this.validateScheduledPulse(operation, !propagateError)) {
      return;
    }

    try {
      this.io.log.info(`motor pulse -> ${operation.purpose.kind}`);
      await this.io.pulseMotor(operation.purpose.kind);
      if (this.disposed || !this.hasCurrentOperation(operation.id)) {
        return;
      }
      this.lastPublishedPulseAt = this.scheduler.now();
      this.applySuccessfulPulse(operation);
      if (!propagateError) {
        this.emitSnapshot(`${operation.purpose.kind}-published`);
      }
    } catch (error) {
      if (!this.disposed && this.hasCurrentOperation(operation.id)) {
        this.clearOperation();
        if (operation.purpose.kind === 'stopAndReverse' || this.facts.closedSensor !== true) {
          this.setPosition({ kind: 'notClosedUnknown' });
        } else {
          this.setPosition({ kind: 'closed' });
        }
        if (!propagateError) {
          this.io.log.warn(`scheduled front-gate pulse failed: ${this.errorMessage(error)}`);
          this.emitSnapshot(`${operation.purpose.kind}-publish-failed`);
        }
      }

      if (propagateError) {
        if (error instanceof FrontGateError) {
          throw error;
        }
        throw new FrontGateError(
          'communication_failure',
          `failed to publish front-gate pulse: ${this.errorMessage(error)}`,
          { cause: error },
        );
      }
    }
  }

  private applySuccessfulPulse(operation: ScheduledPulseOperation): void {
    switch (operation.purpose.kind) {
      case 'startOpening':
        this.clearOperation();
        this.setKnownMovement('opening');
        return;
      case 'startClosing':
        this.clearOperation();
        this.setKnownMovement('closing');
        return;
      case 'bestEffortClose':
        this.clearOperation();
        this.setPosition({ kind: 'notClosedUnknown' });
        return;
      case 'stopOpeningAtClosed':
        this.clearOperation();
        this.setPosition({ kind: 'closed' });
        return;
      case 'stopAndReverse':
        this.startReversalPause(operation.purpose.finalDirection, operation.target);
        return;
      case 'seekClosed':
        this.setPosition({ kind: 'notClosedUnknown' });
        this.startSeekClosedWait(operation.purpose.pulseNumber, operation.purpose.maxPulses);
    }
  }

  private startReversalPause(finalDirection: MotionDirection, target: GateTarget): void {
    this.setPosition({ kind: 'reversalPause' });
    const now = this.scheduler.now();
    const operation: ReversalPauseOperation = {
      kind: 'reversalPause',
      id: ++this.nextOperationId,
      epoch: this.observationEpoch,
      dueAt: Math.max(
        now + this.config.reversePauseMs,
        this.lastPublishedPulseAt + this.config.minimumPulseGapMs,
      ),
      target,
      finalDirection,
    };
    this.setOperation(operation);
    this.scheduleOperationTimer(operation);
  }

  private startSeekClosedWait(pulsesUsed: number, maxPulses: number): void {
    const operation: SeekClosedOperation = {
      kind: 'seekClosed',
      id: ++this.nextOperationId,
      epoch: this.observationEpoch,
      dueAt: this.scheduler.now() + this.config.fullTravelMs,
      target: 'closed',
      pulsesUsed,
      maxPulses,
    };
    this.setOperation(operation);
    this.scheduleOperationTimer(operation);
  }

  private scheduleOperationTimer(operation: Exclude<Operation, { kind: 'none' }>): void {
    this.clearOperationTimer();
    const delayMs = Math.max(0, operation.dueAt - this.scheduler.now());
    this.cancelOperationTimer = this.scheduler.schedule(() => {
      void this.enqueue(`operation-timer-${operation.id}`, async () => {
        await this.handleOperationTimer(operation.id);
      });
    }, delayMs);
  }

  private async handleOperationTimer(operationId: number): Promise<void> {
    if (this.operation.kind === 'none' || this.operation.id !== operationId) {
      return;
    }

    const operation = this.operation;
    if (!this.validateOperationContext(operation)) {
      this.cancelInvalidOperation('scheduled-operation-guard-failed');
      return;
    }

    if (operation.kind === 'scheduledPulse') {
      await this.executeScheduledPulse(operation, false);
      return;
    }

    if (operation.kind === 'reversalPause') {
      await this.executeReversalPulse(operation);
      return;
    }

    await this.advanceSeekClosed(operation);
  }

  private async executeReversalPulse(operation: ReversalPauseOperation): Promise<void> {
    if (this.position.kind !== 'reversalPause') {
      this.cancelInvalidOperation('reversal-position-changed');
      return;
    }

    try {
      this.io.log.info(`motor pulse -> finish-reversal-${operation.finalDirection}`);
      await this.io.pulseMotor(`finish-reversal-${operation.finalDirection}`);
      if (this.disposed || !this.hasCurrentOperation(operation.id)) {
        return;
      }
      this.lastPublishedPulseAt = this.scheduler.now();
      this.clearOperation();
      this.setKnownMovement(operation.finalDirection);
      this.emitSnapshot(`reversal-second-pulse-${operation.finalDirection}`);
    } catch (error) {
      if (this.disposed || !this.hasCurrentOperation(operation.id)) {
        return;
      }
      this.io.log.warn(`front-gate reversal pulse failed: ${this.errorMessage(error)}`);
      this.clearOperation();
      this.setPosition({ kind: 'notClosedUnknown' });
      this.emitSnapshot('reversal-second-pulse-failed');
    }
  }

  private async advanceSeekClosed(operation: SeekClosedOperation): Promise<void> {
    if (this.facts.closedSensor === true) {
      this.clearOperation();
      this.setPosition({ kind: 'closed' });
      this.desiredTarget = null;
      this.emitSnapshot('seek-closed-succeeded');
      return;
    }

    if (operation.pulsesUsed >= operation.maxPulses) {
      this.io.log.warn(`seek-closed exhausted ${operation.maxPulses} pulse(s) without reaching the sensor`);
      this.clearOperation();
      this.setPosition({ kind: 'notClosedUnknown' });
      this.emitSnapshot('seek-closed-exhausted');
      return;
    }

    try {
      await this.acceptPulse({
        kind: 'seekClosed',
        pulseNumber: operation.pulsesUsed + 1,
        maxPulses: operation.maxPulses,
      }, 'closed');
      this.emitSnapshot('seek-closed-next-pulse-accepted');
    } catch (error) {
      this.io.log.warn(`seek-closed pulse failed: ${this.errorMessage(error)}`);
      this.clearOperation();
      this.setPosition({ kind: 'notClosedUnknown' });
      this.emitSnapshot('seek-closed-pulse-failed');
    }
  }

  private validateScheduledPulse(operation: ScheduledPulseOperation, requireCommittedTarget: boolean): boolean {
    if (this.disposed || this.operation.kind !== 'scheduledPulse' || this.operation.id !== operation.id) {
      return false;
    }
    if (!this.validateOperationContext(operation, requireCommittedTarget)) {
      this.cancelInvalidOperation('scheduled-pulse-context-invalid');
      return false;
    }
    if (this.position.kind !== operation.expectedPosition) {
      this.cancelInvalidOperation('scheduled-pulse-position-invalid');
      return false;
    }

    switch (operation.purpose.kind) {
      case 'startOpening':
      case 'stopOpeningAtClosed':
        if (this.facts.closedSensor !== true) {
          this.cancelInvalidOperation('scheduled-pulse-closed-sensor-invalid');
          return false;
        }
        break;
      case 'startClosing':
      case 'bestEffortClose':
      case 'stopAndReverse':
      case 'seekClosed':
        if (this.facts.closedSensor !== false) {
          this.cancelInvalidOperation('scheduled-pulse-not-closed-sensor-invalid');
          return false;
        }
        break;
    }
    return true;
  }

  private validateOperationContext(
    operation: Exclude<Operation, { kind: 'none' }>,
    requireCommittedTarget = true,
  ): boolean {
    return !this.disposed
      && operation.epoch === this.observationEpoch
      && this.isAvailableForHomeKit()
      && (!requireCommittedTarget || this.desiredTarget === operation.target);
  }

  private hasCurrentOperation(operationId: number): boolean {
    return this.operation.kind !== 'none' && this.operation.id === operationId;
  }

  private cancelConflictingOperation(): void {
    const operation = this.operation;
    this.clearOperation();
    if (operation.kind === 'reversalPause') {
      this.setPosition({ kind: 'notClosedUnknown' });
    }
  }

  private cancelInvalidOperation(note: string): void {
    const operation = this.operation;
    this.clearOperation();
    if (operation.kind === 'reversalPause') {
      this.setPosition({ kind: 'notClosedUnknown' });
    }
    this.io.log.warn(`front-gate scheduled operation cancelled: ${note}`);
    this.emitSnapshot(note);
  }

  private applyObservedExternalPulse(reason: string): void {
    this.clearOperation();
    this.desiredTarget = null;
    if (this.facts.closedSensor === true && this.sensorSampleEpoch === this.observationEpoch) {
      this.setKnownMovement('opening');
      this.emitSnapshot(`external-pulse-from-closed-${reason}`);
      return;
    }

    this.setPosition({ kind: 'notClosedUnknown' });
    this.emitSnapshot(`external-pulse-direction-unknown-${reason}`);
  }

  private advanceObservationEpoch(note: string): void {
    this.observationEpoch += 1;
    this.sensorSampleEpoch = null;
    this.previousSensorInEpoch = null;
    this.desiredTarget = null;
    this.clearOperation();
    this.setPosition({ kind: 'notClosedUnknown' });
    this.io.log.warn(`front-gate observation epoch invalidated: ${note}`);
    this.emitSnapshot(note);
  }

  private setKnownMovement(direction: MotionDirection): void {
    const now = this.scheduler.now();
    this.setPosition(direction === 'opening'
      ? { kind: 'openingKnown', startedAt: now, epoch: this.observationEpoch }
      : { kind: 'closingKnown', startedAt: now, epoch: this.observationEpoch });
  }

  private setPosition(position: PositionEstimate): void {
    this.clearMovementTimer();
    this.position = position;
    const generation = ++this.positionGeneration;
    if (position.kind !== 'openingKnown' && position.kind !== 'closingKnown') {
      return;
    }

    const epoch = position.epoch;
    this.cancelMovementTimer = this.scheduler.schedule(() => {
      void this.enqueue(`movement-timer-${generation}`, () => {
        this.handleMovementTimeout(generation, epoch);
      });
    }, this.config.fullTravelMs);
  }

  private handleMovementTimeout(generation: number, epoch: number): void {
    if (
      generation !== this.positionGeneration
      || epoch !== this.observationEpoch
      || (this.position.kind !== 'openingKnown' && this.position.kind !== 'closingKnown')
    ) {
      return;
    }

    const direction = this.position.kind === 'openingKnown' ? 'opening' : 'closing';
    this.clearOperation();
    if (this.facts.closedSensor === true) {
      this.setPosition({ kind: 'closed' });
      if (this.desiredTarget === 'closed') {
        this.desiredTarget = null;
      }
      this.emitSnapshot(`${direction}-timeout-at-closed-sensor`);
      return;
    }

    if (direction === 'opening' && this.config.assumeOpenAfterTravel) {
      this.setPosition({ kind: 'openAssumed' });
      this.emitSnapshot('opening-timeout-open-assumed');
      return;
    }

    this.setPosition({ kind: 'notClosedUnknown' });
    this.emitSnapshot(`${direction}-timeout-position-unknown`);
  }

  private setOperation(operation: Operation): void {
    this.clearOperationTimer();
    this.operation = operation;
  }

  private clearOperation(): void {
    this.clearOperationTimer();
    this.operation = { kind: 'none' };
  }

  private clearMovementTimer(): void {
    if (this.cancelMovementTimer) {
      this.cancelMovementTimer();
      this.cancelMovementTimer = undefined;
    }
  }

  private clearOperationTimer(): void {
    if (this.cancelOperationTimer) {
      this.cancelOperationTimer();
      this.cancelOperationTimer = undefined;
    }
  }

  private isAvailableForHomeKit(): boolean {
    return this.facts.transportConnected
      && this.facts.controlConnected === true
      && this.facts.sensorConnected === true
      && this.sensorSampleEpoch === this.observationEpoch
      && this.facts.closedSensor !== null;
  }

  private emitSnapshot(note: string): void {
    if (!this.disposed) {
      this.io.publishSnapshot(this.buildSnapshot(note));
    }
  }

  private buildSnapshot(note: string): FrontGateSnapshot {
    const available = this.isAvailableForHomeKit();
    return {
      available,
      transportConnected: this.facts.transportConnected,
      controlConnected: this.facts.controlConnected,
      sensorConnected: this.facts.sensorConnected,
      closedSensor: this.facts.closedSensor,
      observationEpoch: this.observationEpoch,
      sensorSampleEpoch: this.sensorSampleEpoch,
      currentDoorState: available ? this.computeCurrentDoorState() : undefined,
      targetDoorState: available ? this.computeTargetDoorState() : undefined,
      desiredTarget: this.desiredTarget,
      positionEstimate: this.position.kind,
      motionDirection: this.getMotionDirection(),
      operationKind: this.operation.kind,
      note,
    };
  }

  private getMotionDirection(): MotionDirection | 'none' {
    if (this.position.kind === 'openingKnown') {
      return 'opening';
    }
    if (this.position.kind === 'closingKnown') {
      return 'closing';
    }
    return 'none';
  }

  private computeCurrentDoorState(): DoorCurrentState {
    switch (this.position.kind) {
      case 'closed':
        return DoorCurrentState.CLOSED;
      case 'openingKnown':
        return DoorCurrentState.OPENING;
      case 'closingKnown':
        return DoorCurrentState.CLOSING;
      case 'openAssumed':
        return DoorCurrentState.OPEN;
      case 'reversalPause':
      case 'notClosedUnknown':
        return DoorCurrentState.STOPPED;
    }
  }

  private computeTargetDoorState(): DoorTargetState {
    if (this.desiredTarget) {
      return this.desiredTarget === 'closed' ? DoorTargetState.CLOSED : DoorTargetState.OPEN;
    }
    if (this.position.kind === 'closed') {
      return DoorTargetState.CLOSED;
    }
    if (this.position.kind === 'openingKnown' || this.position.kind === 'closingKnown') {
      return targetForDirection(this.position.kind === 'openingKnown' ? 'opening' : 'closing') === 'closed'
        ? DoorTargetState.CLOSED
        : DoorTargetState.OPEN;
    }
    return DoorTargetState.OPEN;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
