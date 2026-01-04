import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

type PartialHiMode = 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore';

export class GateAccessory {
  private service: Service;
  private currentState = this.platform.Characteristic.CurrentDoorState.CLOSED;
  private targetState = this.platform.Characteristic.TargetDoorState.CLOSED;
  private connected = true;
  private hasFault = false;
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
  private readonly reverseToggleDelayMs = 350;

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
          this.pendingTarget = undefined;
          this.clearTransitionTimer();
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
    const target = value as number;
    const previousTarget = this.targetState;
    this.setTargetState(target);
    this.clearReverseToggleTimer();

    if (!this.connected) {
      this.platform.log.warn(`Gate ${this.accessory.displayName} is offline; ignoring command.`);
      this.setTargetState(previousTarget);
      this.updateStatusFault();
      return;
    }

    const mode = this.platform.getGateControlMode();
    if (mode === 'toggle' && this.isAtTarget(target)) {
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
    const motionTarget = this.getMotionTarget();
    const isReversing = motionTarget !== undefined && motionTarget !== target;
    this.publishGateAction(action, isReversing && mode === 'toggle' ? 'reverse' : undefined);
    if (mode === 'toggle' && isReversing) {
      this.scheduleReverseToggle(action, target);
    }

    this.clearFaults();
    this.pendingTarget = target;
    this.armTransitionTimer();
    const nextState = target === this.platform.Characteristic.TargetDoorState.OPEN
      ? this.platform.Characteristic.CurrentDoorState.OPENING
      : this.platform.Characteristic.CurrentDoorState.CLOSING;
    this.setCurrentState(nextState);
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
        this.setCurrentState(this.platform.Characteristic.CurrentDoorState.OPENING);
        return;
      }
      this.pendingTarget = undefined;
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.CLOSED,
        this.platform.Characteristic.TargetDoorState.CLOSED,
      );
      return;
    }

    if (this.partialHiMode === 'moving') {
      if (this.isPartialSensorActive) {
        this.setCurrentState(this.resolveMovingState());
        return;
      }
      this.setCurrentState(this.platform.Characteristic.CurrentDoorState.STOPPED);
      return;
    }

    if (this.partialHiMode === 'open_endstop') {
      if (this.isPartialSensorActive) {
        this.pendingTarget = undefined;
        this.clearTransitionTimer();
        this.clearReverseToggleTimer();
        this.applyDoorState(
          this.platform.Characteristic.CurrentDoorState.OPEN,
          this.platform.Characteristic.TargetDoorState.OPEN,
        );
        return;
      }
      if (this.pendingTarget !== undefined) {
        this.setCurrentState(this.resolveMovingState());
        return;
      }
      this.setCurrentState(this.platform.Characteristic.CurrentDoorState.STOPPED);
      return;
    }

    if (this.partialHiMode === 'pedestrian_endstop') {
      if (this.isPartialSensorActive) {
        this.pendingTarget = undefined;
        this.clearTransitionTimer();
        this.clearReverseToggleTimer();
        this.setCurrentState(this.platform.Characteristic.CurrentDoorState.STOPPED);
        return;
      }
      if (this.pendingTarget !== undefined) {
        this.setCurrentState(this.resolveMovingState());
        return;
      }
      this.pendingTarget = undefined;
      this.clearTransitionTimer();
      this.clearReverseToggleTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.OPEN,
        this.platform.Characteristic.TargetDoorState.OPEN,
      );
      return;
    }

    this.pendingTarget = undefined;
    this.clearTransitionTimer();
    this.clearReverseToggleTimer();
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
      if (this.partialHiMode === 'moving') {
        return false;
      }
      if (this.partialHiMode === 'open_endstop') {
        if (!this.hasPartialSensorState) {
          return false;
        }
        return this.isPartialSensorActive;
      }
      if (this.partialHiMode === 'pedestrian_endstop') {
        if (!this.hasClosedSensorState && !this.hasPartialSensorState) {
          return false;
        }
        if (this.hasClosedSensorState && this.isClosedSensorActive) {
          return false;
        }
        if (this.hasPartialSensorState && this.isPartialSensorActive) {
          return false;
        }
        return true;
      }
      if (!this.hasClosedSensorState) {
        return false;
      }
      return !this.isClosedSensorActive;
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

  private updateStatusFault() {
    const fault = !this.connected || this.hasFault;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      fault
        ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
        : this.platform.Characteristic.StatusFault.NO_FAULT,
    );
  }

  private clearFaults() {
    if (this.hasFault) {
      this.hasFault = false;
    }
    if (this.obstructionDetected) {
      this.obstructionDetected = false;
      this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);
    }
    if (this.connected) {
      this.updateStatusFault();
    }
  }

  private armTransitionTimer() {
    this.clearTransitionTimer();
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = undefined;
      this.pendingTarget = undefined;
      this.hasFault = true;
      this.obstructionDetected = true;
      this.updateStatusFault();
      this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, true);
      this.setCurrentState(this.platform.Characteristic.CurrentDoorState.STOPPED);
      this.platform.log.warn(`Gate ${this.accessory.displayName} did not reach target within ${this.transitionTimeoutMs}ms.`);
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

  private touchTransitionTimer() {
    if (this.pendingTarget === undefined) {
      return;
    }
    this.armTransitionTimer();
  }

  private resolveMovingState(): number {
    if (this.pendingTarget === this.platform.Characteristic.TargetDoorState.OPEN) {
      return this.platform.Characteristic.CurrentDoorState.OPENING;
    }
    if (this.pendingTarget === this.platform.Characteristic.TargetDoorState.CLOSED) {
      return this.platform.Characteristic.CurrentDoorState.CLOSING;
    }
    return this.platform.Characteristic.CurrentDoorState.STOPPED;
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
