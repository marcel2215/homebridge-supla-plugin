import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class RollerShutterAccessory {
  private service: Service;
  private currentPosition = 0;
  private targetPosition = 0;
  private positionState = this.platform.Characteristic.PositionState.STOPPED;
  private connected = true;
  private stopTimer?: NodeJS.Timeout;
  private legacyMode = false;
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

    this.legacyMode = this.isLegacyTopic();
    const statusTopic = this.legacyMode
      ? this.getLegacyStatusTopic()
      : `${this.context.topic}/state/shut`;
    const connectedTopic = this.legacyMode
      ? undefined
      : `${this.context.topic}/state/connected`;

    this.platform.MqttClient.client.subscribe(statusTopic);
    if (connectedTopic) {
      this.platform.MqttClient.client.subscribe(connectedTopic);
    }
    this.platform.MqttClient.client.on('message', (topic, message) => {
      if (topic === statusTopic) {
        if (this.legacyMode) {
          const parsed = this.parseLegacyPayload(message.toString());
          if (parsed?.shut !== undefined) {
            this.applyShutUpdate(parsed.shut);
          }
          if (parsed?.online !== undefined) {
            this.updateConnection(parsed.online);
          }
        } else {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.applyShutUpdate(value);
          }
        }
      }
      if (!this.legacyMode && connectedTopic && topic === connectedTopic) {
        this.updateConnection(message.toString() === 'true');
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
    if (this.legacyMode) {
      this.publishLegacyCommand(this.targetPosition);
      return;
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

  private applyShutUpdate(shutValue: number) {
    this.currentPosition = this.toPosition(shutValue);
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

  private updateConnection(isConnected: boolean) {
    this.connected = isConnected;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      this.connected ? 0 : 1,
    );
  }

  private parseLegacyPayload(payload: string): {shut?: number; online?: boolean} | null {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!data || typeof data !== 'object') {
      return null;
    }
    const record = data as {shut?: unknown; online?: unknown};
    const result: {shut?: number; online?: boolean} = {};
    const shutValue = Number(record.shut);
    if (!Number.isNaN(shutValue)) {
      result.shut = shutValue;
    }
    if (typeof record.online !== 'undefined') {
      result.online = record.online === true
        || record.online === 1
        || record.online === '1'
        || record.online === 'true';
    }
    return result;
  }

  private publishLegacyCommand(targetPosition: number) {
    const channelId = this.getLegacyChannelId();
    if (channelId === null) {
      this.platform.log.warn(`Legacy rollershutter channel id missing for ${this.accessory.displayName}`);
      return;
    }
    const shutValue = Math.round(this.toShut(targetPosition));
    const topic = this.getLegacyCommandTopic();
    const payload = JSON.stringify({id: channelId, shut: shutValue});
    this.platform.log.debug(`Publishing ${topic} = ${payload}`);
    this.platform.MqttClient.client.publish(topic, payload, (error) => {
      if (error) {
        this.platform.log.error(`Publish failed for ${topic}: ${error.message}`);
      }
    });
  }

  private isLegacyTopic(): boolean {
    return this.context.topic.startsWith('supla/channels/status/rollershutter/');
  }

  private getLegacyStatusTopic(): string {
    return this.context.topic;
  }

  private getLegacyCommandTopic(): string {
    if (this.context.topic.includes('/channels/status/rollershutter/')) {
      return this.context.topic.replace(
        '/channels/status/rollershutter/',
        '/channels/command/rollershutter/',
      );
    }
    const channelId = this.getLegacyChannelId();
    if (channelId === null) {
      return 'supla/channels/command/rollershutter/unknown';
    }
    return `supla/channels/command/rollershutter/${channelId}`;
  }

  private getLegacyChannelId(): number | null {
    const idValue = Number(this.context.channelId);
    if (!Number.isNaN(idValue)) {
      return idValue;
    }
    const match = this.context.topic.match(/rollershutter\/(\d+)$/);
    if (!match) {
      return null;
    }
    const parsed = Number(match[1]);
    return Number.isNaN(parsed) ? null : parsed;
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

  private toPosition(shutValue: number): number {
    return this.clamp(100 - shutValue, 0, 100);
  }

  private toShut(position: number): number {
    return this.clamp(100 - position, 0, 100);
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
