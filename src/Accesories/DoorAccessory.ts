import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class DoorAccessory {
  private service: Service;
  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = this.platform.Characteristic.PositionState.STOPPED;
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
      .setCharacteristic(this.platform.Characteristic.Model, 'DoorController');

    const legacyGarage = this.accessory.getService(this.platform.Service.GarageDoorOpener);
    if (legacyGarage) {
      this.accessory.removeService(legacyGarage);
    }

    this.service = this.accessory.getService(this.platform.Service.Door)
      || this.accessory.addService(this.platform.Service.Door);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleCurrentPositionGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        this.hi = this.platform.parseBoolean(message.toString());
        this.updatePositionsFromState();
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/partial_hi`,
      (message) => {
        this.partialHi = this.platform.parseBoolean(message.toString());
        this.updatePositionsFromState();
      },
      this.accessory.UUID,
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
      this.accessory.UUID,
    );
  }

  async handleCurrentPositionGet(): Promise<CharacteristicValue> {
    return this.currentPosition;
  }

  async handleTargetPositionGet(): Promise<CharacteristicValue> {
    return this.targetPosition;
  }

  async handleTargetPositionSet(value: CharacteristicValue) {
    const target = this.clamp(value as number, 0, 100);
    this.targetPosition = target;
    if (this.targetPosition > this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.INCREASING;
    } else if (this.targetPosition < this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.DECREASING;
    } else {
      this.positionState = this.platform.Characteristic.PositionState.STOPPED;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);

    const action = this.targetPosition <= 10 ? 'close' : 'open';
    this.platform.log.debug(`Publishing ${this.context.topic}/execute_action = ${action}`);
    this.platform.publishCommand(
      `${this.context.topic}/execute_action`,
      action,
    );
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    return this.positionState;
  }

  private updatePositionsFromState() {
    if (this.hi) {
      this.currentPosition = 0;
    } else if (this.partialHi) {
      this.currentPosition = 50;
    } else {
      this.currentPosition = 100;
    }
    this.targetPosition = this.currentPosition;
    this.positionState = this.platform.Characteristic.PositionState.STOPPED;
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, this.currentPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
