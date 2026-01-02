import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class FacadeBlindAccessory {
  private service: Service;
  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = this.platform.Characteristic.PositionState.STOPPED;
  private currentTiltAngle = 0;
  private targetTiltAngle = 0;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'FacadeBlind');

    this.service = this.accessory.getService(this.platform.Service.WindowCovering)
      || this.accessory.addService(this.platform.Service.WindowCovering);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.handleCurrentPositionGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHorizontalTiltAngle)
      .onGet(this.handleCurrentTiltGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle)
      .onGet(this.handleTargetTiltGet.bind(this))
      .onSet(this.handleTargetTiltSet.bind(this));

    setTimeout(() => {
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/shut`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/tilt`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
      this.platform.MqttClient.client.on('message', (topic, message) => {
        if (topic === `${this.context.topic}/state/shut`) {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.currentPosition = this.toPosition(value);
            if (Math.abs(this.targetPosition - this.currentPosition) <= 1) {
              this.targetPosition = this.currentPosition;
            }
            this.positionState = this.platform.Characteristic.PositionState.STOPPED;
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentPosition,
              this.currentPosition,
            );
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetPosition,
              this.targetPosition,
            );
            this.service.updateCharacteristic(
              this.platform.Characteristic.PositionState,
              this.positionState,
            );
          }
        }
        if (topic === `${this.context.topic}/state/tilt`) {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.currentTiltAngle = this.toTiltAngle(value);
            if (Math.abs(this.targetTiltAngle - this.currentTiltAngle) <= 2) {
              this.targetTiltAngle = this.currentTiltAngle;
            }
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentHorizontalTiltAngle,
              this.currentTiltAngle,
            );
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetHorizontalTiltAngle,
              this.targetTiltAngle,
            );
          }
        }
        if (topic === `${this.context.topic}/state/connected`) {
          this.connected = message.toString() === 'true';
          this.service.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            this.connected ? 0 : 1,
          );
        }
      });
    }, 3000);
  }

  async handleCurrentPositionGet(): Promise<CharacteristicValue> {
    return this.currentPosition;
  }

  async handleTargetPositionGet(): Promise<CharacteristicValue> {
    return this.targetPosition;
  }

  async handleTargetPositionSet(value: CharacteristicValue) {
    const target = value as number;
    this.targetPosition = this.clamp(target, 0, 100);
    if (this.targetPosition > this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.INCREASING;
    } else if (this.targetPosition < this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.DECREASING;
    } else {
      this.positionState = this.platform.Characteristic.PositionState.STOPPED;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/shut`,
      this.toShut(this.targetPosition).toString(),
    );
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    return this.positionState;
  }

  async handleCurrentTiltGet(): Promise<CharacteristicValue> {
    return this.currentTiltAngle;
  }

  async handleTargetTiltGet(): Promise<CharacteristicValue> {
    return this.targetTiltAngle;
  }

  async handleTargetTiltSet(value: CharacteristicValue) {
    const target = value as number;
    this.targetTiltAngle = this.clamp(target, -90, 90);
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHorizontalTiltAngle,
      this.targetTiltAngle,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/tilt`,
      this.toTiltValue(this.targetTiltAngle).toString(),
    );
  }

  private toPosition(shutValue: number): number {
    return this.clamp(100 - shutValue, 0, 100);
  }

  private toShut(position: number): number {
    return this.clamp(100 - position, 0, 100);
  }

  private toTiltAngle(value: number): number {
    return this.clamp((value - 50) * 1.8, -90, 90);
  }

  private toTiltValue(angle: number): number {
    return this.clamp(Math.round((angle + 90) / 1.8), 0, 100);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
