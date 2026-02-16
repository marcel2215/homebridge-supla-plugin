import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

type PartialHiMode = 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore';
type SensorUpdateContext = {
  closedPrevious?: boolean;
  partialPrevious?: boolean;
};

export class GateAccessory {
  private service: Service;
  private currentState = this.platform.Characteristic.CurrentDoorState.CLOSED;
  private targetState = this.platform.Characteristic.TargetDoorState.CLOSED;
  private connected = true;
  private obstructionDetected = false;
  private isClosedSensorActive = false;
  private isPartialSensorActive = false;
  private hasClosedSensorState = false;
  private hasPartialSensorState = false;
  private pendingTarget?: number;
  private transitionTimer?: NodeJS.Timeout;
  private readonly transitionTimeoutMs = 60000;
  private readonly partialHiMode: PartialHiMode;
  private readonly baseTopic: string;
  private reverseToggleTimer?: NodeJS.Timeout;
  private readonly reverseToggleDelayMs: number;
  private openArrivalDebounceTimer?: NodeJS.Timeout;
  private readonly openArrivalDebounceMs: number;
  private lastCommandTarget?: number;
  private lastCommandAt = 0;
  private readonly duplicateSetWindowMs = 350;
  private sawPartialMotionDuringPending = false;
  private lastClosedReleaseAt = 0;
  private readonly externalDirectionHintWindowMs = 2500;
  private readonly commandCooldownMs: number;
  private readonly publishRetryDelayMs: number;
  private readonly strictReverseDoublePulse: boolean;
  private readonly debugTimeline: boolean;
  private publishRetryTimer?: NodeJS.Timeout;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'GateController');

    const legacyDoor = this.accessory.getService(this.platform.Service.Door);
    if (legacyDoor) {
      this.accessory.removeService(legacyDoor);
    }

    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
      || this.accessory.addService(this.platform.Service.GarageDoorOpener);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleCurrentDoorStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleTargetDoorStateGet.bind(this))
      .onSet(this.handleTargetDoorStateSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.handleObstructionDetectedGet.bind(this));

    this.service.setCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.clearOpenArrivalDebounceTimer();
      this.clearPublishRetryTimer();
    });

    this.partialHiMode = this.platform.getGatePartialHiMode();
    this.baseTopic = this.platform.normalizeTopicBase(this.context.topic);
    this.reverseToggleDelayMs = this.platform.getGateReverseFollowUpDelayMs();
    this.openArrivalDebounceMs = this.platform.getGateOpenAssumeDelayMs();
    this.commandCooldownMs = this.platform.getGateCommandCooldownMs();
    this.publishRetryDelayMs = this.platform.getGatePublishRetryDelayMs();
    this.strictReverseDoublePulse = this.platform.getGateStrictReverseDoublePulse();
    this.debugTimeline = this.platform.getGateDebugTimeline();

    this.platform.registerMqttHandler(
      `${this.baseTopic}/state/hi`,
      (message) => {
        const previous = this.hasClosedSensorState ? this.isClosedSensorActive : undefined;
        const next = this.platform.parseBoolean(message.toString());
        const changed = !this.hasClosedSensorState || next !== this.isClosedSensorActive;
        if (previous === true && next === false) {
          this.lastClosedReleaseAt = Date.now();
        } else if (next) {
          this.lastClosedReleaseAt = 0;
        }
        this.isClosedSensorActive = next;
        this.hasClosedSensorState = true;
        this.updateStatesFromSensors({
          closedPrevious: changed ? previous : undefined,
        });
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.baseTopic}/state/partial_hi`,
      (message) => {
        const previous = this.hasPartialSensorState ? this.isPartialSensorActive : undefined;
        const next = this.platform.parseBoolean(message.toString());
        const changed = !this.hasPartialSensorState || next !== this.isPartialSensorActive;
        if (previous === true && next === false) {
          this.lastClosedReleaseAt = 0;
        }
        this.isPartialSensorActive = next;
        this.hasPartialSensorState = true;
        if (this.pendingTarget !== undefined && this.isPartialSensorActive) {
          this.sawPartialMotionDuringPending = true;
        }
        this.updateStatesFromSensors({
          partialPrevious: changed ? previous : undefined,
        });
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.baseTopic}/state/connected`,
      (message) => {
        this.connected = this.platform.parseBoolean(message.toString());
        this.updateStatusFault();
        if (!this.connected) {
          this.setPendingTarget(undefined);
          this.clearTransitionTimer();
          this.clearReverseToggleTimer();
          this.clearOpenArrivalDebounceTimer();
          this.clearPublishRetryTimer();
        }
      },
      this.accessory.UUID,
    );

    this.updateStatusFault();
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    return this.currentState;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async handleTargetDoorStateSet(value: CharacteristicValue) {
    const requestedTarget = value as number;
    const mode = this.platform.getGateControlMode();
    const motionTarget = this.getMotionTarget();
    const isMoving = motionTarget !== undefined;
    let target = requestedTarget;
    this.logGateTimeline('set-request', {
      requested: this.describeTargetState(requestedTarget),
      motion: this.describeTargetState(motionTarget),
      mode,
    });
    if (isMoving && motionTarget !== undefined && requestedTarget === motionTarget) {
      if (this.isLikelyDuplicateSet(requestedTarget)) {
        this.logGateTimeline('set-ignored-duplicate', {
          requested: this.describeTargetState(requestedTarget),
        });
        return;
      }
      target = this.oppositeTarget(requestedTarget);
    }
    const previousTarget = this.targetState;
    this.setTargetState(target);
    this.clearReverseToggleTimer();
    this.clearPublishRetryTimer();

    if (!this.connected) {
      this.platform.log.warn(`Gate ${this.accessory.displayName} is offline; ignoring command.`);
      this.setTargetState(previousTarget);
      this.updateStatusFault();
      this.logGateTimeline('set-ignored-offline', {
        requested: this.describeTargetState(requestedTarget),
      });
      return;
    }

    if (!isMoving && this.isAtTarget(target)) {
      this.logGateTimeline('set-ignored-at-target', {
        target: this.describeTargetState(target),
      });
      return;
    }

    if (this.pendingTarget === target) {
      this.logGateTimeline('set-ignored-pending', {
        target: this.describeTargetState(target),
      });
      return;
    }

    if (this.isCommandInCooldown(target, motionTarget)) {
      this.setTargetState(previousTarget);
      this.logGateTimeline('set-ignored-cooldown', {
        target: this.describeTargetState(target),
        cooldownMs: this.commandCooldownMs,
      });
      return;
    }

    let action = '';
    if (mode === 'toggle') {
      action = this.platform.getGateExecuteActionToggle();
    } else {
      action = target === this.platform.Characteristic.TargetDoorState.OPEN
        ? this.platform.getGateExecuteActionOpen()
        : this.platform.getGateExecuteActionClose();
    }
    if (!action) {
      this.platform.log.warn(`Gate action not configured for ${this.accessory.displayName}`);
      this.setTargetState(previousTarget);
      return;
    }
    const isReversing = motionTarget !== undefined && motionTarget !== target;
    this.publishGateAction(action, isReversing ? 'reverse' : undefined, target);
    if (isReversing && this.shouldScheduleReverseFollowUp(mode)) {
      this.scheduleReverseToggle(action, target, mode);
    }

    this.clearFaults();
    this.setPendingTarget(target);
    this.markCommand(target);
    this.armTransitionTimer();
    this.setCurrentState(this.resolveMovingState(target));
    this.logGateTimeline('set-applied', {
      action,
      target: this.describeTargetState(target),
      reversing: isReversing,
    });
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    return this.obstructionDetected;
  }

  private updateStatesFromSensors(context: SensorUpdateContext) {
    const changed = (
      (context.closedPrevious !== undefined && context.closedPrevious !== this.isClosedSensorActive)
      || (context.partialPrevious !== undefined && context.partialPrevious !== this.isPartialSensorActive)
    );
    if (changed) {
      this.logGateTimeline('sensor-change', {
        closed: this.describeSensorValue(this.hasClosedSensorState, this.isClosedSensorActive),
        partial: this.describeSensorValue(this.hasPartialSensorState, this.isPartialSensorActive),
      });
    }
    this.clearFaults();
    if (changed) {
      this.touchTransitionTimer();
    }
    if (this.isClosedSensorActive) {
      if (this.pendingTarget === this.platform.Characteristic.TargetDoorState.OPEN) {
        this.setTargetState(this.platform.Characteristic.TargetDoorState.OPEN);
        this.setCurrentState(this.platform.Characteristic.CurrentDoorState.OPENING);
        return;
      }
      this.setPendingTarget(undefined);
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.clearOpenArrivalDebounceTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.CLOSED,
        this.platform.Characteristic.TargetDoorState.CLOSED,
      );
      return;
    }

    if (this.pendingTarget === this.platform.Characteristic.TargetDoorState.OPEN
      && this.shouldDebounceOpenArrival()) {
      this.scheduleOpenArrivalDebounce();
      return;
    }

    if (this.pendingTarget === this.platform.Characteristic.TargetDoorState.OPEN
      && this.isOpenArrivalSignal()) {
      this.setPendingTarget(undefined);
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.clearOpenArrivalDebounceTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.OPEN,
        this.platform.Characteristic.TargetDoorState.OPEN,
      );
      return;
    }

    if (this.pendingTarget !== undefined) {
      this.setTargetState(this.pendingTarget);
      this.setCurrentState(this.resolveMovingState(this.pendingTarget));
      return;
    }

    if (this.shouldAssumeExternalOpeningFromClosed(context)) {
      this.setPendingTarget(this.platform.Characteristic.TargetDoorState.OPEN);
      this.setTargetState(this.platform.Characteristic.TargetDoorState.OPEN);
      this.setCurrentState(this.platform.Characteristic.CurrentDoorState.OPENING);
      this.armTransitionTimer();
      this.scheduleOpenArrivalDebounce();
      return;
    }

    const inferredExternalMotionTarget = this.resolveExternalMotionTarget(context);
    if (inferredExternalMotionTarget !== undefined) {
      this.clearTransitionTimer();
      this.clearOpenArrivalDebounceTimer();
      this.setTargetState(inferredExternalMotionTarget);
      this.setCurrentState(this.resolveMovingState(inferredExternalMotionTarget));
      return;
    }

    this.clearTransitionTimer();
    this.clearReverseToggleTimer();
    this.clearOpenArrivalDebounceTimer();
    this.applyDoorState(
      this.platform.Characteristic.CurrentDoorState.OPEN,
      this.platform.Characteristic.TargetDoorState.OPEN,
    );
  }

  private isAtTarget(target: number): boolean {
    if (target === this.platform.Characteristic.TargetDoorState.CLOSED) {
      if (!this.hasClosedSensorState) {
        return false;
      }
      return this.isClosedSensorActive;
    }
    if (target === this.platform.Characteristic.TargetDoorState.OPEN) {
      return this.isKnownNotClosed()
        && this.currentState === this.platform.Characteristic.CurrentDoorState.OPEN;
    }
    return false;
  }

  private applyDoorState(current: number, target: number) {
    this.setCurrentState(current);
    this.setTargetState(target);
  }

  private setCurrentState(next: number) {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.currentState);
  }

  private setTargetState(next: number) {
    if (this.targetState === next) {
      return;
    }
    this.targetState = next;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.targetState);
  }

  private isKnownNotClosed(): boolean {
    if (this.hasClosedSensorState) {
      return !this.isClosedSensorActive;
    }
    if (this.hasPartialSensorState && this.isPartialSensorActive) {
      return true;
    }
    return this.currentState !== this.platform.Characteristic.CurrentDoorState.CLOSED;
  }

  private updateStatusFault() {
    const fault = !this.connected;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      fault
        ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
        : this.platform.Characteristic.StatusFault.NO_FAULT,
    );
  }

  private clearFaults() {
    if (this.obstructionDetected) {
      this.obstructionDetected = false;
      this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);
    }
    this.updateStatusFault();
  }

  private armTransitionTimer() {
    this.clearTransitionTimer();
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = undefined;
      const target = this.pendingTarget;
      this.setPendingTarget(undefined);
      this.clearReverseToggleTimer();
      this.clearOpenArrivalDebounceTimer();
      if (target === undefined) {
        return;
      }
      const settled = this.resolveTerminalStateFromSensors();
      if (settled !== undefined) {
        this.applyDoorState(settled.current, settled.target);
        return;
      }
      const assumedCurrent = target === this.platform.Characteristic.TargetDoorState.OPEN
        ? this.platform.Characteristic.CurrentDoorState.OPEN
        : this.platform.Characteristic.CurrentDoorState.CLOSED;
      this.applyDoorState(assumedCurrent, target);
      this.platform.log.warn(
        `Gate ${this.accessory.displayName} did not confirm target within ${this.transitionTimeoutMs}ms; assuming ` +
        `${target === this.platform.Characteristic.TargetDoorState.OPEN ? 'open' : 'closed'}.`,
      );
      this.logGateTimeline('transition-timeout-assumed', {
        assumedTarget: this.describeTargetState(target),
      });
    }, this.transitionTimeoutMs);
  }

  private clearTransitionTimer() {
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = undefined;
    }
  }

  private clearReverseToggleTimer() {
    if (this.reverseToggleTimer) {
      clearTimeout(this.reverseToggleTimer);
      this.reverseToggleTimer = undefined;
    }
  }

  private clearOpenArrivalDebounceTimer() {
    if (this.openArrivalDebounceTimer) {
      clearTimeout(this.openArrivalDebounceTimer);
      this.openArrivalDebounceTimer = undefined;
    }
  }

  private clearPublishRetryTimer() {
    if (this.publishRetryTimer) {
      clearTimeout(this.publishRetryTimer);
      this.publishRetryTimer = undefined;
    }
  }

  private touchTransitionTimer() {
    if (this.pendingTarget === undefined) {
      return;
    }
    this.armTransitionTimer();
  }

  private resolveMovingState(target: number): number {
    if (target === this.platform.Characteristic.TargetDoorState.OPEN) {
      return this.platform.Characteristic.CurrentDoorState.OPENING;
    }
    if (target === this.platform.Characteristic.TargetDoorState.CLOSED) {
      return this.platform.Characteristic.CurrentDoorState.CLOSING;
    }
    return this.currentState;
  }

  private getMotionTarget(): number | undefined {
    if (this.pendingTarget !== undefined) {
      return this.pendingTarget;
    }
    if (this.currentState === this.platform.Characteristic.CurrentDoorState.OPENING) {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if (this.currentState === this.platform.Characteristic.CurrentDoorState.CLOSING) {
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }
    return undefined;
  }

  private isOpenArrivalSignal(): boolean {
    if (this.partialHiMode === 'moving') {
      if (!this.hasPartialSensorState) {
        return true;
      }
      return this.hasPartialSensorState
        && this.sawPartialMotionDuringPending
        && !this.isPartialSensorActive;
    }
    if (!this.hasPartialSensorState) {
      return false;
    }
    if (this.partialHiMode === 'open_endstop') {
      return this.isPartialSensorActive;
    }
    if (this.partialHiMode === 'pedestrian_endstop') {
      return this.isPartialSensorActive;
    }
    return false;
  }

  private shouldDebounceOpenArrival(): boolean {
    if (this.isClosedSensorActive) {
      return false;
    }
    if (this.partialHiMode === 'ignore') {
      return true;
    }
    return this.partialHiMode === 'moving' && !this.hasPartialSensorState;
  }

  private shouldAssumeExternalOpeningFromClosed(context: SensorUpdateContext): boolean {
    return context.closedPrevious === true
      && !this.isClosedSensorActive
      && this.shouldDebounceOpenArrival();
  }

  private scheduleOpenArrivalDebounce() {
    if (this.openArrivalDebounceTimer) {
      return;
    }
    this.openArrivalDebounceTimer = setTimeout(() => {
      this.openArrivalDebounceTimer = undefined;
      if (!this.connected) {
        return;
      }
      if (this.pendingTarget !== this.platform.Characteristic.TargetDoorState.OPEN) {
        return;
      }
      if (this.isClosedSensorActive) {
        return;
      }
      this.setPendingTarget(undefined);
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.OPEN,
        this.platform.Characteristic.TargetDoorState.OPEN,
      );
      this.logGateTimeline('open-assumed-arrival', {
        debounceMs: this.openArrivalDebounceMs,
      });
    }, this.openArrivalDebounceMs);
  }

  private resolveTerminalStateFromSensors():
  {current: number; target: number} | undefined {
    if (!this.hasClosedSensorState) {
      return undefined;
    }
    if (this.isClosedSensorActive) {
      return {
        current: this.platform.Characteristic.CurrentDoorState.CLOSED,
        target: this.platform.Characteristic.TargetDoorState.CLOSED,
      };
    }
    return {
      current: this.platform.Characteristic.CurrentDoorState.OPEN,
      target: this.platform.Characteristic.TargetDoorState.OPEN,
    };
  }

  private oppositeTarget(target: number): number {
    return target === this.platform.Characteristic.TargetDoorState.OPEN
      ? this.platform.Characteristic.TargetDoorState.CLOSED
      : this.platform.Characteristic.TargetDoorState.OPEN;
  }

  private markCommand(target: number) {
    this.lastCommandTarget = target;
    this.lastCommandAt = Date.now();
  }

  private setPendingTarget(target: number | undefined) {
    this.pendingTarget = target;
    if (target !== this.platform.Characteristic.TargetDoorState.OPEN) {
      this.clearOpenArrivalDebounceTimer();
    }
    if (target === undefined) {
      this.sawPartialMotionDuringPending = false;
      return;
    }
    this.sawPartialMotionDuringPending = this.hasPartialSensorState && this.isPartialSensorActive;
  }

  private isLikelyDuplicateSet(target: number): boolean {
    if (this.lastCommandTarget !== target) {
      return false;
    }
    return Date.now() - this.lastCommandAt <= this.duplicateSetWindowMs;
  }

  private publishGateAction(action: string, note?: string, expectedTarget?: number, isRetry = false) {
    const suffix = note ? ` (${note})` : '';
    this.platform.log.debug(`Publishing ${this.baseTopic}/execute_action = ${action}${suffix}`);
    this.logGateTimeline(isRetry ? 'publish-retry' : 'publish', {
      action,
      note: note ?? 'none',
      expected: this.describeTargetState(expectedTarget),
    });
    this.platform.publishCommand(`${this.baseTopic}/execute_action`, action, (error) => {
      if (!error) {
        return;
      }
      this.platform.log.warn(
        `Gate ${this.accessory.displayName} publish failed (${action}): ${error.message}`,
      );
      this.logGateTimeline('publish-failed', {
        action,
        retry: !isRetry && this.publishRetryDelayMs > 0,
      });
      if (isRetry || this.publishRetryDelayMs <= 0) {
        return;
      }
      this.schedulePublishRetry(action, note, expectedTarget);
    });
  }

  private schedulePublishRetry(action: string, note?: string, expectedTarget?: number) {
    this.clearPublishRetryTimer();
    this.publishRetryTimer = setTimeout(() => {
      this.publishRetryTimer = undefined;
      if (!this.connected) {
        return;
      }
      if (expectedTarget !== undefined && this.pendingTarget !== expectedTarget) {
        return;
      }
      this.publishGateAction(action, note, expectedTarget, true);
    }, this.publishRetryDelayMs);
    this.logGateTimeline('publish-retry-scheduled', {
      action,
      retryDelayMs: this.publishRetryDelayMs,
      expected: this.describeTargetState(expectedTarget),
    });
  }

  private scheduleReverseToggle(
    action: string,
    expectedTarget: number,
    mode: 'execute_action' | 'toggle',
  ) {
    this.clearReverseToggleTimer();
    this.reverseToggleTimer = setTimeout(() => {
      this.reverseToggleTimer = undefined;
      if (!this.connected) {
        return;
      }
      if (this.pendingTarget !== expectedTarget) {
        return;
      }
      if (!this.strictReverseDoublePulse
        && mode === 'execute_action'
        && this.isOpenCloseExecuteActionPair()
        && !this.shouldPublishExecuteActionReverseFollowUp()) {
        this.logGateTimeline('reverse-2-skipped', {
          reason: 'motion-confirmed',
          strict: this.strictReverseDoublePulse,
        });
        return;
      }
      this.publishGateAction(action, 'reverse-2', expectedTarget);
    }, this.reverseToggleDelayMs);
    this.logGateTimeline('reverse-2-scheduled', {
      action,
      mode,
      delayMs: this.reverseToggleDelayMs,
      expected: this.describeTargetState(expectedTarget),
    });
  }

  private shouldScheduleReverseFollowUp(mode: 'execute_action' | 'toggle'): boolean {
    if (mode === 'toggle') {
      return true;
    }
    return this.isOpenCloseExecuteActionPair() || this.isSingleExecuteActionPair();
  }

  private isOpenCloseExecuteActionPair(): boolean {
    return this.normalizeAction(this.platform.getGateExecuteActionOpen()) === 'open'
      && this.normalizeAction(this.platform.getGateExecuteActionClose()) === 'close';
  }

  private isSingleExecuteActionPair(): boolean {
    const openAction = this.normalizeAction(this.platform.getGateExecuteActionOpen());
    if (!openAction) {
      return false;
    }
    return openAction === this.normalizeAction(this.platform.getGateExecuteActionClose());
  }

  private normalizeAction(value: string): string {
    return value.trim().toLowerCase();
  }

  private shouldPublishExecuteActionReverseFollowUp(): boolean {
    if (this.partialHiMode !== 'moving') {
      return true;
    }
    if (!this.hasPartialSensorState) {
      return true;
    }
    return !this.isPartialSensorActive;
  }

  private resolveExternalMotionTarget(context: SensorUpdateContext): number | undefined {
    if (this.partialHiMode !== 'moving') {
      return undefined;
    }
    if (!this.hasPartialSensorState || !this.isPartialSensorActive) {
      return undefined;
    }
    if (this.hasClosedSensorState && this.isClosedSensorActive) {
      return undefined;
    }

    const closedJustOpened = context.closedPrevious !== undefined
      && context.closedPrevious
      && !this.isClosedSensorActive;
    if (closedJustOpened) {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if (this.wasClosedReleasedRecently()) {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }

    const existingMotionTarget = this.getMotionTarget();
    if (existingMotionTarget !== undefined) {
      return existingMotionTarget;
    }

    if (this.currentState === this.platform.Characteristic.CurrentDoorState.CLOSED) {
      return this.platform.Characteristic.TargetDoorState.OPEN;
    }
    if (this.currentState === this.platform.Characteristic.CurrentDoorState.OPEN) {
      return this.platform.Characteristic.TargetDoorState.CLOSED;
    }

    return this.targetState === this.platform.Characteristic.TargetDoorState.OPEN
      ? this.platform.Characteristic.TargetDoorState.CLOSED
      : this.platform.Characteristic.TargetDoorState.OPEN;
  }

  private wasClosedReleasedRecently(): boolean {
    if (!this.lastClosedReleaseAt) {
      return false;
    }
    return Date.now() - this.lastClosedReleaseAt <= this.externalDirectionHintWindowMs;
  }

  private isCommandInCooldown(target: number, motionTarget: number | undefined): boolean {
    if (this.commandCooldownMs <= 0 || this.lastCommandAt === 0) {
      return false;
    }
    if (Date.now() - this.lastCommandAt > this.commandCooldownMs) {
      return false;
    }
    const isReverse = motionTarget !== undefined && motionTarget !== target;
    return !isReverse;
  }

  private describeTargetState(value: number | undefined): string {
    if (value === undefined) {
      return 'none';
    }
    if (value === this.platform.Characteristic.TargetDoorState.OPEN) {
      return 'open';
    }
    if (value === this.platform.Characteristic.TargetDoorState.CLOSED) {
      return 'closed';
    }
    return `unknown(${value})`;
  }

  private describeCurrentState(value: number): string {
    if (value === this.platform.Characteristic.CurrentDoorState.OPEN) {
      return 'open';
    }
    if (value === this.platform.Characteristic.CurrentDoorState.CLOSED) {
      return 'closed';
    }
    if (value === this.platform.Characteristic.CurrentDoorState.OPENING) {
      return 'opening';
    }
    if (value === this.platform.Characteristic.CurrentDoorState.CLOSING) {
      return 'closing';
    }
    if (value === this.platform.Characteristic.CurrentDoorState.STOPPED) {
      return 'stopped';
    }
    return `unknown(${value})`;
  }

  private describeSensorValue(hasValue: boolean, value: boolean): string {
    if (!hasValue) {
      return 'unknown';
    }
    return value ? 'true' : 'false';
  }

  private logGateTimeline(event: string, context?: Record<string, unknown>) {
    if (!this.debugTimeline) {
      return;
    }
    const snapshot: Record<string, unknown> = {
      event,
      current: this.describeCurrentState(this.currentState),
      target: this.describeTargetState(this.targetState),
      pending: this.describeTargetState(this.pendingTarget),
      connected: this.connected,
      closed: this.describeSensorValue(this.hasClosedSensorState, this.isClosedSensorActive),
      partial: this.describeSensorValue(this.hasPartialSensorState, this.isPartialSensorActive),
    };
    const merged = {
      ...snapshot,
      ...context,
    };
    const details = Object.entries(merged)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    this.platform.log.info(`[GateDebug ${this.accessory.displayName}] ${details}`);
  }
}
