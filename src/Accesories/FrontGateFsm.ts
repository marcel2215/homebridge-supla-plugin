export type GateTarget = 'open' | 'closed';
export type MotionDirection = 'opening' | 'closing';
export type MotionCertainty = 'known' | 'goalOnly';
export type MotionSource = 'homekit' | 'external' | 'recovery';
export type IdleNotClosedMode = 'openKnown' | 'openishUnknown';
export type NextPulseDirection = MotionDirection | 'unknown';

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

export interface FrontGateTimingConfig {
  fullTravelMs: number;
  reversePauseMs: number;
  wrongDirectionRunMs: number;
  minimumPulseGapMs: number;
  closeRetryLimit: number;
}

export const DEFAULT_FRONT_GATE_TIMINGS: FrontGateTimingConfig = {
  fullTravelMs: 25000,
  reversePauseMs: 3000,
  wrongDirectionRunMs: 0,
  minimumPulseGapMs: 3000,
  closeRetryLimit: 0,
};

export interface PersistedFrontGateState {
  // Intentionally empty.
  // The front gate controller does NOT persist motion/direction state because
  // Supla app / IR remote / HomeKit can invalidate it at any time.
}

export interface FrontGateSnapshot {
  available: boolean;
  controlConnected: boolean | null;
  sensorConnected: boolean | null;
  closedSensor: boolean | null;
  sensorFreshSinceOnline: boolean;
  currentDoorState?: DoorCurrentState;
  targetDoorState?: DoorTargetState;
  requestedTarget: GateTarget | null;
  motionDirection: MotionDirection | 'none';
  motionCertainty: MotionCertainty | 'none';
  planKind: Plan['kind'];
  idleNotClosedMode: IdleNotClosedMode;
  nextPulseDirection: NextPulseDirection;
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

type Plan =
  | { kind: 'idle' }
  | {
      kind: 'moving';
      direction: MotionDirection;
      certainty: MotionCertainty;
      source: MotionSource;
      startedAt: number;
      deadlineAt: number;
    }
  | {
      kind: 'waitingSecondPulse';
      stoppedFrom: MotionDirection;
      finalDirection: MotionDirection;
      source: MotionSource;
      dueAt: number;
      deadlineAt: number;
      reason: 'reverseToOpen' | 'reverseToClose';
    };

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function oppositeDirection(direction: MotionDirection): MotionDirection {
  return direction === 'opening' ? 'closing' : 'opening';
}

export class FrontGateFsm {
  private readonly travelMs: number;
  private readonly pulseGapMs: number;

  private facts: {
    controlConnected: boolean | null;
    sensorConnected: boolean | null;
    closedSensor: boolean | null;
  } = {
    controlConnected: null,
    sensorConnected: null,
    closedSensor: null,
  };

  private sensorFreshSinceOnline = false;
  private requestedTarget: GateTarget | null = null;
  private idleNotClosedMode: IdleNotClosedMode = 'openishUnknown';
  private idleNextPulseDirection: NextPulseDirection = 'unknown';
  private plan: Plan = { kind: 'idle' };
  private lastPulseLikeActivityAt = 0;
  private movementTimer?: ReturnType<typeof setTimeout>;
  private movementTimerToken = 0;
  private phaseTimer?: ReturnType<typeof setTimeout>;
  private phaseTimerToken = 0;
  private sequence = Promise.resolve<void>(undefined);
  private disposed = false;

  public constructor(
    private readonly io: FrontGateIo,
    timings: FrontGateTimingConfig = DEFAULT_FRONT_GATE_TIMINGS,
    _persisted: PersistedFrontGateState = {},
  ) {
    this.travelMs = clampInt(timings.fullTravelMs || DEFAULT_FRONT_GATE_TIMINGS.fullTravelMs, 5000, 120000);
    this.pulseGapMs = Math.max(
      3000,
      clampInt(timings.minimumPulseGapMs || DEFAULT_FRONT_GATE_TIMINGS.minimumPulseGapMs, 0, 15000),
      clampInt(timings.reversePauseMs || DEFAULT_FRONT_GATE_TIMINGS.reversePauseMs, 0, 15000),
    );

    this.emitSnapshot('fsm-initialized');
  }

  public dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  public handleConnectedChange(connected: boolean): void {
    this.handleControlConnectedChange(connected);
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

  public async requestHomeKitTarget(target: GateTarget): Promise<void> {
    return this.enqueue(`homekit-target=${target}`, async () => {
      await this.applyHomeKitTarget(target);
    });
  }

  public getSnapshot(): FrontGateSnapshot {
    return this.buildSnapshot('snapshot-requested');
  }

  private enqueue(label: string, task: () => Promise<void> | void): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    const run = this.sequence.then(async () => {
      if (this.disposed) {
        return;
      }
      await task();
    });

    this.sequence = run.catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.io.log.warn(`front-gate sequence '${label}' failed: ${message}`);
    });

    return run;
  }

  private applyControlConnectedChange(connected: boolean): void {
    if (this.facts.controlConnected === connected) {
      return;
    }

    this.facts.controlConnected = connected;

    if (!connected) {
      this.io.log.warn('front gate control channel went offline');
      this.enterUnavailable('control-offline');
      return;
    }

    this.io.log.info('front gate control channel connected');
    this.clearTimers();
    this.plan = { kind: 'idle' };
    this.sensorFreshSinceOnline = false;
    this.emitSnapshot('control-online-awaiting-fresh-sensor');
  }

  private applySensorConnectedChange(connected: boolean): void {
    if (this.facts.sensorConnected === connected) {
      return;
    }

    this.facts.sensorConnected = connected;

    if (!connected) {
      this.io.log.warn('front gate sensor channel went offline');
      this.enterUnavailable('sensor-offline');
      return;
    }

    this.io.log.info('front gate sensor channel connected');
    this.clearTimers();
    this.plan = { kind: 'idle' };
    this.sensorFreshSinceOnline = false;
    this.emitSnapshot('sensor-online-awaiting-fresh-state');
  }

  private applyClosedSensorChange(closed: boolean): void {
    const previous = this.facts.closedSensor;
    const wasFresh = this.sensorFreshSinceOnline;
    this.facts.closedSensor = closed;

    if (this.facts.controlConnected === true && this.facts.sensorConnected === true) {
      this.sensorFreshSinceOnline = true;
    }

    const becameFresh = !wasFresh && this.sensorFreshSinceOnline;
    if (previous === closed && !becameFresh) {
      return;
    }

    if (closed) {
      this.io.log.info('closed sensor is TRUE -> gate is fully closed');
      this.clearTimers();
      this.plan = { kind: 'idle' };
      this.idleNextPulseDirection = 'opening';
      this.idleNotClosedMode = 'openishUnknown';

      if (this.requestedTarget === 'open' && this.isAvailableForHomeKit()) {
        this.emitSnapshot('closed-sensor-true-but-open-still-requested');
        void this.enqueue('auto-open-after-closed', async () => {
          await this.startOpeningFromClosed('auto-open-after-closed');
        });
        return;
      }

      this.requestedTarget = null;
      this.emitSnapshot('closed-sensor-true');
      return;
    }

    this.io.log.info('closed sensor is FALSE -> gate is not fully closed');

    if (previous === true) {
      // Leaving the closed end-stop is the one fully reliable motion signal we have:
      // the gate is opening.
      this.lastPulseLikeActivityAt = Date.now();
      if (this.requestedTarget !== 'open') {
        this.requestedTarget = null;
      }
      this.startOpeningMotion(
        this.requestedTarget === 'open' ? 'homekit' : 'external',
        'closed-sensor-fell-from-true-to-false',
      );
      return;
    }

    if (this.plan.kind === 'idle' && this.requestedTarget === 'open') {
      this.requestedTarget = null;
    }

    this.emitSnapshot('closed-sensor-false');
  }

  private async applyHomeKitTarget(target: GateTarget): Promise<void> {
    if (!this.isAvailableForHomeKit()) {
      throw new Error('front gate controller is not available');
    }

    this.requestedTarget = target;

    if (target === 'open') {
      await this.handleOpenRequest();
      return;
    }

    await this.handleCloseRequest();
  }

  private async handleOpenRequest(): Promise<void> {
    if (this.facts.closedSensor === true) {
      if (this.plan.kind === 'moving' && this.plan.direction === 'opening') {
        this.emitSnapshot('open-request-already-opening-from-closed');
        return;
      }
      if (this.plan.kind === 'waitingSecondPulse' && this.plan.finalDirection === 'opening') {
        this.emitSnapshot('open-request-already-reversing-to-open');
        return;
      }

      await this.startOpeningFromClosed('homekit-open-from-closed');
      return;
    }

    if (this.plan.kind === 'moving') {
      if (this.plan.direction === 'opening') {
        this.emitSnapshot('open-request-already-opening');
        return;
      }

      if (this.plan.certainty === 'known') {
        await this.reverseKnownMotion('opening', 'homekit-reverse-known-closing-to-open');
        return;
      }

      this.io.log.warn(
        'open requested during ambiguous close attempt; not sending more pulses because the actual motion direction is unknown',
      );
      this.clearTimers();
      this.plan = { kind: 'idle' };
      this.idleNotClosedMode = 'openishUnknown';
      this.idleNextPulseDirection = 'unknown';
      this.requestedTarget = null;
      this.emitSnapshot('open-request-during-ambiguous-close-attempt');
      return;
    }

    if (this.plan.kind === 'waitingSecondPulse') {
      if (this.plan.finalDirection === 'opening') {
        this.emitSnapshot('open-request-already-reversing-to-open');
        return;
      }

      // We already stopped an opening run, so the next pulse can only start closing.
      // To honor the latest OPEN request without leaving the gate stopped in the middle,
      // keep the pending close, let the gate reach the closed end-stop, then auto-open.
      this.io.log.info(
        'open requested while waiting to restart towards close; keeping the pending close and will auto-open from closed',
      );
      this.emitSnapshot('open-request-deferred-until-closed');
      return;
    }

    if (this.idleNextPulseDirection === 'opening') {
      await this.startOpeningFromStoppedState('homekit-open-from-stopped-after-closing');
      return;
    }

    this.requestedTarget = null;
    this.emitSnapshot('open-request-already-satisfied-openish');
  }

  private async handleCloseRequest(): Promise<void> {
    if (this.facts.closedSensor === true) {
      if (this.plan.kind === 'moving' && this.plan.direction === 'opening') {
        // We are still physically on the closed end-stop, so a single pulse cleanly
        // cancels the opening attempt and leaves the gate closed.
        await this.pulseMotor('cancel-opening-while-still-closed');
        this.clearTimers();
        this.plan = { kind: 'idle' };
        this.idleNextPulseDirection = 'opening';
        this.requestedTarget = null;
        this.emitSnapshot('opening-cancelled-before-leaving-closed');
        return;
      }

      this.requestedTarget = null;
      this.emitSnapshot('close-request-already-satisfied');
      return;
    }

    if (this.plan.kind === 'moving') {
      if (this.plan.direction === 'closing') {
        this.emitSnapshot(
          this.plan.certainty === 'known' ? 'close-request-already-closing' : 'close-request-already-close-seeking',
        );
        return;
      }

      await this.reverseKnownMotion('closing', 'homekit-reverse-known-opening-to-close');
      return;
    }

    if (this.plan.kind === 'waitingSecondPulse') {
      if (this.plan.finalDirection === 'closing') {
        this.emitSnapshot('close-request-already-reversing-to-close');
        return;
      }

      // We already stopped a closing run, so the next pulse can only start opening.
      // To honor the latest CLOSE request without leaving the gate stopped in the middle,
      // keep the pending open, let the gate become fully open-ish by timeout, then auto-close.
      this.io.log.info(
        'close requested while waiting to restart towards open; keeping the pending open and will auto-close after the opening run settles',
      );
      this.emitSnapshot('close-request-deferred-until-open');
      return;
    }

    if (this.idleNotClosedMode === 'openKnown' || this.idleNextPulseDirection === 'closing') {
      await this.startKnownCloseFromIdle('homekit-close-from-openish-known');
      return;
    }

    if (this.idleNextPulseDirection === 'opening') {
      this.io.log.warn(
        'close requested while the gate is stopped after a closing run; the next pulse would open, so no corrective pulse is sent',
      );
      this.requestedTarget = null;
      this.emitSnapshot('close-request-not-directly-actionable-from-stopped-closing');
      return;
    }

    await this.startAmbiguousCloseAttempt('homekit-close-from-openish-ambiguous');
  }

  private async startOpeningFromClosed(reason: string): Promise<void> {
    if (this.facts.closedSensor !== true) {
      this.requestedTarget = null;
      this.emitSnapshot(`${reason}-already-openish`);
      return;
    }

    await this.pulseMotor(reason);
    this.startOpeningMotion('homekit', `${reason}-pulse-sent`);
  }

  private async startOpeningFromStoppedState(reason: string): Promise<void> {
    if (this.facts.closedSensor === true) {
      await this.startOpeningFromClosed(`${reason}-closed-fallback`);
      return;
    }

    await this.pulseMotor(reason);
    this.startOpeningMotion('homekit', `${reason}-pulse-sent`);
  }

  private async startKnownCloseFromIdle(reason: string): Promise<void> {
    if (this.facts.closedSensor === true) {
      this.requestedTarget = null;
      this.emitSnapshot(`${reason}-already-closed`);
      return;
    }

    await this.pulseMotor(reason);
    this.startClosingMotion('known', 'homekit', `${reason}-pulse-sent`);
  }

  private async startAmbiguousCloseAttempt(reason: string): Promise<void> {
    if (this.facts.closedSensor === true) {
      this.requestedTarget = null;
      this.emitSnapshot(`${reason}-already-closed`);
      return;
    }

    await this.pulseMotor(reason);
    this.startClosingMotion('goalOnly', 'homekit', `${reason}-pulse-sent`);
  }

  private async reverseKnownMotion(finalDirection: MotionDirection, reason: string): Promise<void> {
    if (this.plan.kind !== 'moving') {
      return;
    }

    const stoppedFrom = this.plan.direction;
    await this.pulseMotor(`${reason}-stop-current-motion`);

    const deadlineAt = Date.now() + this.pulseGapMs + this.travelMs;
    this.clearMovementTimer();
    this.plan = {
      kind: 'waitingSecondPulse',
      stoppedFrom,
      finalDirection,
      source: 'homekit',
      dueAt: Date.now() + this.pulseGapMs,
      deadlineAt,
      reason: finalDirection === 'opening' ? 'reverseToOpen' : 'reverseToClose',
    };
    this.schedulePhaseTimer(this.plan.dueAt);
    this.emitSnapshot(`${reason}-waiting-second-pulse`);
  }

  private startOpeningMotion(source: MotionSource, note: string): void {
    this.clearPhaseTimer();
    this.plan = {
      kind: 'moving',
      direction: 'opening',
      certainty: 'known',
      source,
      startedAt: Date.now(),
      deadlineAt: Date.now() + this.travelMs,
    };
    this.scheduleMovementTimer(this.plan.deadlineAt);
    this.emitSnapshot(note);
  }

  private startClosingMotion(
    certainty: MotionCertainty,
    source: MotionSource,
    note: string,
  ): void {
    this.clearPhaseTimer();
    this.plan = {
      kind: 'moving',
      direction: 'closing',
      certainty,
      source,
      startedAt: Date.now(),
      deadlineAt: Date.now() + this.travelMs,
    };
    this.scheduleMovementTimer(this.plan.deadlineAt);
    this.emitSnapshot(note);
  }

  private scheduleMovementTimer(deadlineAt: number): void {
    this.clearMovementTimer();
    const delayMs = Math.max(0, deadlineAt - Date.now());
    const token = ++this.movementTimerToken;
    this.movementTimer = setTimeout(() => {
      void this.enqueue(`movement-timeout-${token}`, async () => {
        if (token !== this.movementTimerToken) {
          return;
        }
        await this.handleMovementTimeout();
      });
    }, delayMs);
  }

  private schedulePhaseTimer(dueAt: number): void {
    this.clearPhaseTimer();
    const delayMs = Math.max(0, dueAt - Date.now());
    const token = ++this.phaseTimerToken;
    this.phaseTimer = setTimeout(() => {
      void this.enqueue(`phase-timer-${token}`, async () => {
        if (token !== this.phaseTimerToken) {
          return;
        }
        await this.handlePhaseTimer();
      });
    }, delayMs);
  }

  private clearMovementTimer(): void {
    if (this.movementTimer) {
      clearTimeout(this.movementTimer);
      this.movementTimer = undefined;
    }
    this.movementTimerToken += 1;
  }

  private clearPhaseTimer(): void {
    if (this.phaseTimer) {
      clearTimeout(this.phaseTimer);
      this.phaseTimer = undefined;
    }
    this.phaseTimerToken += 1;
  }

  private clearTimers(): void {
    this.clearMovementTimer();
    this.clearPhaseTimer();
  }

  private async handlePhaseTimer(): Promise<void> {
    if (this.plan.kind !== 'waitingSecondPulse') {
      return;
    }

    const finalDirection = this.plan.finalDirection;

    await this.pulseMotor(`second-pulse-${finalDirection}`);

    this.clearPhaseTimer();
    if (finalDirection === 'opening') {
      this.startOpeningMotion(this.plan.source, `second-pulse-fired-${finalDirection}`);
      return;
    }

    this.startClosingMotion('known', this.plan.source, `second-pulse-fired-${finalDirection}`);
  }

  private async handleMovementTimeout(): Promise<void> {
    if (this.plan.kind !== 'moving') {
      return;
    }

    if (this.facts.closedSensor === true) {
      this.clearTimers();
      this.plan = { kind: 'idle' };
      this.idleNextPulseDirection = 'opening';
      this.requestedTarget = null;
      this.emitSnapshot('movement-timeout-but-already-closed');
      return;
    }

    if (this.plan.direction === 'opening') {
      // Fully-open and partially-open look identical to us. Once the opening window
      // expires without any contrary evidence, collapse to the stable open state.
      this.clearTimers();
      this.plan = { kind: 'idle' };
      this.idleNotClosedMode = 'openKnown';
      this.idleNextPulseDirection = 'closing';

      if (this.requestedTarget === 'closed' && this.isAvailableForHomeKit()) {
        this.emitSnapshot('opening-window-elapsed-but-close-still-requested');
        void this.enqueue('auto-close-after-open', async () => {
          await this.startKnownCloseFromIdle('auto-close-after-open');
        });
        return;
      }

      this.requestedTarget = null;
      this.emitSnapshot('opening-window-elapsed-open');
      return;
    }

    this.io.log.warn(
      this.plan.certainty === 'known'
        ? 'closing window elapsed without reaching the closed sensor; leaving gate in generic open-ish state'
        : 'ambiguous close attempt elapsed without reaching the closed sensor; leaving gate in generic open-ish state',
    );
    this.clearTimers();
    this.plan = { kind: 'idle' };
    this.idleNotClosedMode = 'openishUnknown';
    this.idleNextPulseDirection = 'unknown';
    this.requestedTarget = null;
    this.emitSnapshot('closing-window-elapsed-openish');
  }

  private applyObservedExternalPulse(reason: string): void {
    this.lastPulseLikeActivityAt = Date.now();
    this.requestedTarget = null;

    if (this.facts.closedSensor === true) {
      this.startOpeningMotion('external', `external-pulse-observed-while-closed-${reason}`);
      return;
    }

    if (this.plan.kind === 'moving') {
      const currentDirection = this.plan.direction;
      const currentCertainty = this.plan.certainty;
      this.clearTimers();
      this.plan = { kind: 'idle' };
      this.idleNotClosedMode = 'openishUnknown';
      this.idleNextPulseDirection = currentCertainty === 'known'
        ? oppositeDirection(currentDirection)
        : 'unknown';
      this.emitSnapshot(`external-pulse-stopped-${currentDirection}-${reason}`);
      return;
    }

    if (this.plan.kind === 'waitingSecondPulse') {
      const finalDirection = this.plan.finalDirection;
      this.clearTimers();
      if (finalDirection === 'opening') {
        this.startOpeningMotion('external', `external-pulse-fired-pending-opening-${reason}`);
        return;
      }
      this.startClosingMotion('known', 'external', `external-pulse-fired-pending-closing-${reason}`);
      return;
    }

    if (this.idleNextPulseDirection === 'opening') {
      this.startOpeningMotion('external', `external-pulse-started-opening-${reason}`);
      return;
    }

    if (this.idleNextPulseDirection === 'closing') {
      this.startClosingMotion('known', 'external', `external-pulse-started-closing-${reason}`);
      return;
    }

    this.emitSnapshot(`external-pulse-observed-direction-unknown-${reason}`);
  }

  private enterUnavailable(note: string): void {
    this.clearTimers();
    this.plan = { kind: 'idle' };
    this.requestedTarget = null;
    this.sensorFreshSinceOnline = false;
    this.idleNotClosedMode = 'openishUnknown';
    this.idleNextPulseDirection = 'unknown';
    this.emitSnapshot(note);
  }

  private isAvailableForHomeKit(): boolean {
    return this.facts.controlConnected === true
      && this.facts.sensorConnected === true
      && this.sensorFreshSinceOnline
      && this.facts.closedSensor !== null;
  }

  private async pulseMotor(reason: string): Promise<void> {
    const elapsed = Date.now() - this.lastPulseLikeActivityAt;
    if (elapsed < this.pulseGapMs) {
      await delay(this.pulseGapMs - elapsed);
    }

    this.io.log.info(`motor pulse -> ${reason}`);
    await this.io.pulseMotor(reason);
    this.lastPulseLikeActivityAt = Date.now();
  }

  private emitSnapshot(note: string): void {
    if (this.disposed) {
      return;
    }
    this.io.publishSnapshot(this.buildSnapshot(note));
  }

  private buildSnapshot(note: string): FrontGateSnapshot {
    const available = this.isAvailableForHomeKit();

    return {
      available,
      controlConnected: this.facts.controlConnected,
      sensorConnected: this.facts.sensorConnected,
      closedSensor: this.facts.closedSensor,
      sensorFreshSinceOnline: this.sensorFreshSinceOnline,
      currentDoorState: available ? this.computeCurrentDoorState() : undefined,
      targetDoorState: available ? this.computeTargetDoorState() : undefined,
      requestedTarget: this.requestedTarget,
      motionDirection: this.getMotionDirection(),
      motionCertainty: this.getMotionCertainty(),
      planKind: this.plan.kind,
      idleNotClosedMode: this.idleNotClosedMode,
      nextPulseDirection: this.idleNextPulseDirection,
      note,
    };
  }

  private getMotionDirection(): MotionDirection | 'none' {
    if (this.plan.kind === 'moving') {
      return this.plan.direction;
    }
    if (this.plan.kind === 'waitingSecondPulse') {
      return this.plan.finalDirection;
    }
    return 'none';
  }

  private getMotionCertainty(): MotionCertainty | 'none' {
    if (this.plan.kind === 'moving') {
      return this.plan.certainty;
    }
    if (this.plan.kind === 'waitingSecondPulse') {
      return 'known';
    }
    return 'none';
  }

  private computeCurrentDoorState(): DoorCurrentState {
    if (this.plan.kind === 'moving') {
      return this.plan.direction === 'closing' ? DoorCurrentState.CLOSING : DoorCurrentState.OPENING;
    }

    if (this.plan.kind === 'waitingSecondPulse') {
      return this.plan.finalDirection === 'closing' ? DoorCurrentState.CLOSING : DoorCurrentState.OPENING;
    }

    return this.facts.closedSensor ? DoorCurrentState.CLOSED : DoorCurrentState.OPEN;
  }

  private computeTargetDoorState(): DoorTargetState {
    if (this.requestedTarget) {
      return this.requestedTarget === 'closed' ? DoorTargetState.CLOSED : DoorTargetState.OPEN;
    }

    if (this.plan.kind === 'moving') {
      return this.plan.direction === 'closing' ? DoorTargetState.CLOSED : DoorTargetState.OPEN;
    }

    if (this.plan.kind === 'waitingSecondPulse') {
      return this.plan.finalDirection === 'closing' ? DoorTargetState.CLOSED : DoorTargetState.OPEN;
    }

    return this.facts.closedSensor ? DoorTargetState.CLOSED : DoorTargetState.OPEN;
  }
}
