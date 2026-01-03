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
  private pendingTarget?: number;
  private transitionTimer?: NodeJS.Timeout;
  private readonly transitionTimeoutMs = 60000;
  private readonly partialHiMode: PartialHiMode;

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
    });

    this.partialHiMode = this.platform.getGatePartialHiMode();

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        this.isClosedSensorActive = this.platform.parseBoolean(message.toString());
        this.updateStatesFromSensors();
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/partial_hi`,
      (message) => {
        this.isPartialSensorActive = this.platform.parseBoolean(message.toString());
        this.updateStatesFromSensors();
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/connected`,
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

    if (!this.connected) {
      this.platform.log.warn(`Gate ${this.accessory.displayName} is offline; ignoring command.`);
      this.setTargetState(previousTarget);
      this.updateStatusFault();
      return;
    }

    if (this.isAtTarget(target)) {
      return;
    }

    if (this.pendingTarget === target) {
      return;
    }

    const mode = this.platform.getGateControlMode();
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
    this.platform.log.debug(`Publishing ${this.context.topic}/execute_action = ${action}`);
    this.platform.publishCommand(
      `${this.context.topic}/execute_action`,
      action,
    );

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

  private updateStatesFromSensors() {
    this.clearFaults();
    this.touchTransitionTimer();
    if (this.isClosedSensorActive) {
      this.pendingTarget = undefined;
      this.clearTransitionTimer();
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
      this.pendingTarget = undefined;
      this.clearTransitionTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.OPEN,
        this.platform.Characteristic.TargetDoorState.OPEN,
      );
      return;
    }

    if (this.partialHiMode === 'open_endstop') {
      if (this.isPartialSensorActive) {
        this.pendingTarget = undefined;
        this.clearTransitionTimer();
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
        this.setCurrentState(this.platform.Characteristic.CurrentDoorState.STOPPED);
        return;
      }
      if (this.pendingTarget !== undefined) {
        this.setCurrentState(this.resolveMovingState());
        return;
      }
      this.pendingTarget = undefined;
      this.clearTransitionTimer();
      this.applyDoorState(
        this.platform.Characteristic.CurrentDoorState.OPEN,
        this.platform.Characteristic.TargetDoorState.OPEN,
      );
      return;
    }

    this.pendingTarget = undefined;
    this.clearTransitionTimer();
    this.applyDoorState(
      this.platform.Characteristic.CurrentDoorState.OPEN,
      this.platform.Characteristic.TargetDoorState.OPEN,
    );
  }

  private isAtTarget(target: number): boolean {
    if (target === this.platform.Characteristic.TargetDoorState.CLOSED) {
      return this.isClosedSensorActive;
    }
    if (target === this.platform.Characteristic.TargetDoorState.OPEN) {
      if (this.partialHiMode === 'open_endstop') {
        return this.isPartialSensorActive;
      }
      if (this.partialHiMode === 'moving' || this.partialHiMode === 'pedestrian_endstop') {
        return !this.isClosedSensorActive && !this.isPartialSensorActive;
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
}
