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
  private stopTimer?: NodeJS.Timeout;
  private hasReceivedPosition = false;
  private pendingTargetPosition?: number;
  private pendingTargetExpiresAt = 0;
  private pendingTargetTimer?: NodeJS.Timeout;

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

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/shut`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/tilt`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
    this.platform.MqttClient.client.on('message', (topic, message) => {
      if (topic === `${this.context.topic}/state/shut`) {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.currentPosition = this.toPosition(value);
          this.positionState = this.platform.Characteristic.PositionState.STOPPED;
          const now = Date.now();
          if (!this.hasReceivedPosition) {
            this.hasReceivedPosition = true;
            this.clearPendingTarget(false);
            this.targetPosition = this.currentPosition;
          } else if (this.pendingTargetPosition !== undefined) {
            const reached = Math.abs(this.pendingTargetPosition - this.currentPosition) <= 1;
            const expired = this.pendingTargetExpiresAt > 0 && now > this.pendingTargetExpiresAt;
            if (reached || expired) {
              this.clearPendingTarget(false);
              this.targetPosition = this.currentPosition;
            } else {
              this.schedulePendingTimeout(this.pendingTargetPosition, this.currentPosition);
            }
          } else {
            this.targetPosition = this.currentPosition;
          }
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
    if (this.targetPosition !== this.currentPosition) {
      this.pendingTargetPosition = this.targetPosition;
      this.schedulePendingTimeout(this.targetPosition, this.currentPosition);
    } else {
      this.clearPendingTarget(false);
    }
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
      const actionTopic = `${this.context.topic}/execute_action`;
      if (controlMode === 'hybrid' && this.targetPosition !== 0 && this.targetPosition !== 100) {
        return;
      }
      const action = this.resolveAction(this.targetPosition, this.currentPosition);
      if (action) {
        this.platform.log.debug(`Publishing ${actionTopic} = ${action}`);
        this.platform.MqttClient.client.publish(actionTopic, action, (error) => {
          if (error) {
            this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
          }
        });
      }
      if (controlMode === 'execute_action') {
        this.scheduleStopIfNeeded(this.targetPosition, this.currentPosition);
      }
    }
  }

  private schedulePendingTimeout(target: number, current: number) {
    const travelTimeSeconds = this.platform.getCoveringTravelTimeSeconds();
    const delta = Math.abs(target - current);
    let timeoutMs = 15000;
    if (travelTimeSeconds > 0 && delta > 0) {
      timeoutMs = Math.round((delta / 100) * travelTimeSeconds * 1000) + 1000;
    }
    if (timeoutMs <= 0) {
      return;
    }
    this.pendingTargetExpiresAt = Date.now() + timeoutMs;
    if (this.pendingTargetTimer) {
      clearTimeout(this.pendingTargetTimer);
    }
    this.pendingTargetTimer = setTimeout(() => {
      this.pendingTargetTimer = undefined;
      this.pendingTargetPosition = undefined;
      this.pendingTargetExpiresAt = 0;
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
      this.platform.log.debug(
        `No state updates for ${this.accessory.displayName} within ${timeoutMs}ms; marking STOPPED.`,
      );
    }, timeoutMs);
  }

  private clearPendingTarget(syncTarget: boolean) {
    if (this.pendingTargetTimer) {
      clearTimeout(this.pendingTargetTimer);
      this.pendingTargetTimer = undefined;
    }
    this.pendingTargetPosition = undefined;
    this.pendingTargetExpiresAt = 0;
    if (syncTarget) {
      this.targetPosition = this.currentPosition;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    }
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
    const tiltValue = this.toTiltValue(this.targetTiltAngle).toString();
    const tiltTopic = `${this.context.topic}/${this.platform.getCoveringTiltTopicSuffix()}`;
    this.platform.log.debug(`Publishing ${tiltTopic} = ${tiltValue}`);
    this.platform.MqttClient.client.publish(tiltTopic, tiltValue, (error) => {
      if (error) {
        this.platform.log.error(`Publish failed for ${tiltTopic}: ${error.message}`);
      }
    });
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

  private resolveAction(target: number, current: number): string | null {
    if (target > current) {
      return this.platform.getCoveringExecuteActionOpen();
    }
    if (target < current) {
      return this.platform.getCoveringExecuteActionClose();
    }
    const stopAction = this.platform.getCoveringExecuteActionStop();
    return stopAction ? stopAction : null;
  }

  private scheduleStopIfNeeded(target: number, current: number) {
    const travelTimeSeconds = this.platform.getCoveringTravelTimeSeconds();
    const stopAction = this.platform.getCoveringExecuteActionStop();
    if (!travelTimeSeconds || !stopAction || target === current) {
      if (this.stopTimer) {
        clearTimeout(this.stopTimer);
        this.stopTimer = undefined;
      }
      return;
    }
    const proportion = Math.abs(target - current) / 100;
    const delayMs = Math.max(250, Math.round(proportion * travelTimeSeconds * 1000));
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
    }
    this.stopTimer = setTimeout(() => {
      const actionTopic = `${this.context.topic}/execute_action`;
      this.platform.log.debug(`Publishing ${actionTopic} = ${stopAction} (auto-stop)`);
      this.platform.MqttClient.client.publish(actionTopic, stopAction, (error) => {
        if (error) {
          this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
        }
      });
    }, delayMs);
  }
}
