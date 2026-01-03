import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class GateAccessory {
  private service: Service;
  private currentState = this.platform.Characteristic.CurrentDoorState.CLOSED;
  private targetState = this.platform.Characteristic.TargetDoorState.CLOSED;
  private connected = true;
  private hi = false;
  private partialHi = false;

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

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        this.hi = this.platform.parseBoolean(message.toString());
        this.updateStates();
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/partial_hi`,
      (message) => {
        this.partialHi = this.platform.parseBoolean(message.toString());
        this.updateStates();
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/connected`,
      (message) => {
        this.connected = this.platform.parseBoolean(message.toString());
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.connected ? 0 : 1,
        );
      },
    );
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    return this.currentState;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async handleTargetDoorStateSet(value: CharacteristicValue) {
    const target = value as number;
    this.targetState = target;
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.targetState);

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
      return;
    }
    this.platform.log.debug(`Publishing ${this.context.topic}/execute_action = ${action}`);
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/execute_action`,
      action,
    );

    this.currentState = target === this.platform.Characteristic.TargetDoorState.OPEN
      ? this.platform.Characteristic.CurrentDoorState.OPENING
      : this.platform.Characteristic.CurrentDoorState.CLOSING;
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentDoorState,
      this.currentState,
    );
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    return 0;
  }

  private updateStates() {
    if (this.partialHi) {
      this.currentState = this.platform.Characteristic.CurrentDoorState.STOPPED;
      this.targetState = this.hi
        ? this.platform.Characteristic.TargetDoorState.CLOSED
        : this.platform.Characteristic.TargetDoorState.OPEN;
    } else if (this.hi) {
      this.currentState = this.platform.Characteristic.CurrentDoorState.CLOSED;
      this.targetState = this.platform.Characteristic.TargetDoorState.CLOSED;
    } else {
      this.currentState = this.platform.Characteristic.CurrentDoorState.OPEN;
      this.targetState = this.platform.Characteristic.TargetDoorState.OPEN;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, this.currentState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, this.targetState);
  }
}
