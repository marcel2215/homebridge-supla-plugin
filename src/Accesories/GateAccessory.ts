import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

type PartialHiMode = 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore';

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
  private readonly reverseToggleDelayMs = 1200;
  private openArrivalDebounceTimer?: NodeJS.Timeout;
  private readonly openArrivalDebounceMs = 450;
  private lastCommandTarget?: number;
  private lastCommandAt = 0;
  private readonly duplicateSetWindowMs = 350;
  private sawPartialMotionDuringPending = false;

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
    });

    this.partialHiMode = this.platform.getGatePartialHiMode();
    this.baseTopic = this.platform.normalizeTopicBase(this.context.topic);

    this.platform.registerMqttHandler(
      `${this.baseTopic}/state/hi`,
      (message) => {
        const next = this.platform.parseBoolean(message.toString());
        const changed = !this.hasClosedSensorState || next !== this.isClosedSensorActive;
        this.isClosedSensorActive = next;
        this.hasClosedSensorState = true;
        this.updateStatesFromSensors(changed);
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.baseTopic}/state/partial_hi`,
      (message) => {
        const next = this.platform.parseBoolean(message.toString());
        const changed = !this.hasPartialSensorState || next !== this.isPartialSensorActive;
        this.isPartialSensorActive = next;
        this.hasPartialSensorState = true;
        if (this.pendingTarget !== undefined && this.isPartialSensorActive) {
          this.sawPartialMotionDuringPending = true;
        }
        this.updateStatesFromSensors(changed);
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
    if (isMoving && motionTarget !== undefined && requestedTarget === motionTarget) {
      if (this.isLikelyDuplicateSet(requestedTarget)) {
        return;
      }
      target = this.oppositeTarget(requestedTarget);
    }
    const previousTarget = this.targetState;
    this.setTargetState(target);
    this.clearReverseToggleTimer();

    if (!this.connected) {
      this.platform.log.warn(`Gate ${this.accessory.displayName} is offline; ignoring command.`);
      this.setTargetState(previousTarget);
      this.updateStatusFault();
      return;
    }

    if (!isMoving && this.isAtTarget(target)) {
      return;
    }

    if (this.pendingTarget === target) {
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
    this.publishGateAction(action, isReversing && mode === 'toggle' ? 'reverse' : undefined);
    if (mode === 'toggle' && isReversing) {
      this.scheduleReverseToggle(action, target);
    }

    this.clearFaults();
    this.setPendingTarget(target);
    this.markCommand(target);
    this.armTransitionTimer();
    this.setCurrentState(this.resolveMovingState(target));
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    return this.obstructionDetected;
  }

  private updateStatesFromSensors(changed: boolean) {
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
    return this.partialHiMode === 'moving'
      && !this.hasPartialSensorState
      && !this.isClosedSensorActive;
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

  private publishGateAction(action: string, note?: string) {
    const suffix = note ? ` (${note})` : '';
    this.platform.log.debug(`Publishing ${this.baseTopic}/execute_action = ${action}${suffix}`);
    this.platform.publishCommand(
      `${this.baseTopic}/execute_action`,
      action,
    );
  }

  private scheduleReverseToggle(action: string, expectedTarget: number) {
    this.clearReverseToggleTimer();
    this.reverseToggleTimer = setTimeout(() => {
      this.reverseToggleTimer = undefined;
      if (!this.connected) {
        return;
      }
      if (this.pendingTarget !== expectedTarget) {
        return;
      }
      this.publishGateAction(action, 'reverse-2');
    }, this.reverseToggleDelayMs);
  }
}
