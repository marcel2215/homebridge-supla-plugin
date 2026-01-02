import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class RollerShutterAccessory {
  private service: Service;
  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = this.platform.Characteristic.PositionState.STOPPED;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'RollerShutter');

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

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/shut`);
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
      if (topic === `${this.context.topic}/state/connected`) {
        this.connected = message.toString() === 'true';
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.connected ? 0 : 1,
        );
      }
    });
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
    const controlMode = this.platform.getCoveringControlMode();
    const shutValue = this.toShut(this.targetPosition).toString();
    if (controlMode === 'set' || controlMode === 'hybrid') {
      const topic = `${this.context.topic}/${this.platform.getCoveringSetTopicSuffix()}`;
      this.platform.log.debug(`Publishing ${topic} = ${shutValue}`);
      this.platform.MqttClient.client.publish(topic, shutValue, (error) => {
        if (error) {
          this.platform.log.error(`Publish failed for ${topic}: ${error.message}`);
        }
      });
    }
    if (controlMode === 'execute_action' || controlMode === 'hybrid') {
      if (this.targetPosition === 0 || this.targetPosition === 100) {
        const action = this.targetPosition === 0 ? 'close' : 'open';
        const actionTopic = `${this.context.topic}/execute_action`;
        this.platform.log.debug(`Publishing ${actionTopic} = ${action}`);
        this.platform.MqttClient.client.publish(actionTopic, action, (error) => {
          if (error) {
            this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
          }
        });
      } else if (controlMode === 'execute_action') {
        this.platform.log.warn(
          `Covering control mode execute_action does not support partial positions (${this.targetPosition}).`,
        );
      }
    }
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    return this.positionState;
  }

  private toPosition(shutValue: number): number {
    return this.clamp(100 - shutValue, 0, 100);
  }

  private toShut(position: number): number {
    return this.clamp(100 - position, 0, 100);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
