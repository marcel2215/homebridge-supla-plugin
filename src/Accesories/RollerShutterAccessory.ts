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
  private pendingNoProgressTimer?: NodeJS.Timeout;
  private pendingLastDistance?: number;
  private motionStopTimer?: NodeJS.Timeout;
  private jammed = false;

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
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.handleHoldPositionSet.bind(this));
    this.service.setCharacteristic(this.platform.Characteristic.StatusJammed, 0);

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.disposeTimers();
    });

    this.legacyMode = this.isLegacyTopic();
    const statusTopic = this.legacyMode
      ? this.getLegacyStatusTopic()
      : `${this.context.topic}/state/shut`;
    const connectedTopic = this.legacyMode
      ? undefined
      : `${this.context.topic}/state/connected`;

    this.platform.log.debug(
      `RollerShutter ${this.accessory.displayName} topics: status=${statusTopic}, connected=${connectedTopic ?? 'n/a'}, legacy=${this.legacyMode}`,
    );

    this.platform.registerMqttHandler(
      statusTopic,
      (message) => {
        if (this.legacyMode) {
          const parsed = this.parseLegacyPayload(message.toString());
          if (parsed?.shut !== undefined) {
            this.applyShutUpdate(parsed.shut);
          }
          if (parsed?.online !== undefined) {
            this.updateConnection(parsed.online);
          }
          return;
        }
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.applyShutUpdate(value);
        }
      },
      this.accessory.UUID,
    );
    if (connectedTopic) {
      this.platform.registerMqttHandler(
        connectedTopic,
        (message) => {
          this.updateConnection(this.platform.parseBoolean(message.toString()));
        },
        this.accessory.UUID,
      );
    }
  }

  async handleCurrentPositionGet(): Promise<CharacteristicValue> {
    this.assertPositionAvailable();
    return this.currentPosition;
  }

  async handleTargetPositionGet(): Promise<CharacteristicValue> {
    this.assertPositionAvailable();
    return this.targetPosition;
  }

  async handleTargetPositionSet(value: CharacteristicValue) {
    const target = value as number;
    this.setJammed(false);
    this.clearMotionStopTimer();
    this.targetPosition = Math.round(this.clamp(target, 0, 100));
    const commandTarget = this.targetPosition;
    if (this.targetPosition > this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.INCREASING;
    } else if (this.targetPosition < this.currentPosition) {
      this.positionState = this.platform.Characteristic.PositionState.DECREASING;
    } else {
      this.positionState = this.platform.Characteristic.PositionState.STOPPED;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    if (this.hasReceivedPosition && this.targetPosition === this.currentPosition) {
      this.clearPendingTarget(false);
      this.clearStopTimer();
      return;
    }
    if (this.targetPosition !== this.currentPosition) {
      this.pendingTargetPosition = this.targetPosition;
      this.pendingLastDistance = Math.abs(this.pendingTargetPosition - this.currentPosition);
      this.schedulePendingNoProgressTimeout();
      this.schedulePendingTimeout(this.targetPosition, this.currentPosition);
    } else {
      this.clearPendingTarget(false);
    }
    if (this.legacyMode) {
      this.publishLegacyCommand(this.targetPosition);
      return;
    }
    const controlMode = this.platform.getCoveringControlMode();
    const shutValue = Math.round(this.toShut(this.targetPosition)).toString();
    const isEndpoint = this.targetPosition === 0 || this.targetPosition === 100;
    if ((controlMode === 'set' || controlMode === 'hybrid')
      && !(controlMode === 'hybrid' && isEndpoint)) {
      const topic = `${this.context.topic}/${this.platform.getCoveringSetTopicSuffix()}`;
      this.platform.log.debug(`Publishing ${topic} = ${shutValue}`);
      this.platform.publishCommand(topic, shutValue, (error) => {
        if (error) {
          this.handleCommandPublishError(commandTarget, topic, error);
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
        this.platform.publishCommand(actionTopic, action, (error) => {
          if (error) {
            this.handleCommandPublishError(commandTarget, actionTopic, error);
          }
        });
      }
      if (controlMode === 'execute_action') {
        this.scheduleStopIfNeeded(this.targetPosition, this.currentPosition);
      }
    }
  }

  async handleHoldPositionSet(value: CharacteristicValue) {
    if (!value) {
      return;
    }
    if (this.legacyMode) {
      this.platform.log.debug(`HoldPosition ignored for legacy rollershutter ${this.accessory.displayName}`);
      this.service.updateCharacteristic(this.platform.Characteristic.HoldPosition, 0);
      return;
    }
    const controlMode = this.platform.getCoveringControlMode();
    if (controlMode === 'set') {
      this.platform.log.debug(`HoldPosition ignored (set mode) for ${this.accessory.displayName}`);
      this.service.updateCharacteristic(this.platform.Characteristic.HoldPosition, 0);
      return;
    }
    const stopAction = this.platform.getCoveringExecuteActionStop();
    if (!stopAction) {
      this.platform.log.debug(`HoldPosition ignored (no stop action) for ${this.accessory.displayName}`);
      this.service.updateCharacteristic(this.platform.Characteristic.HoldPosition, 0);
      return;
    }
    const actionTopic = `${this.context.topic}/execute_action`;
    this.platform.log.debug(`Publishing ${actionTopic} = ${stopAction} (hold)`);
    this.platform.publishCommand(actionTopic, stopAction, (error) => {
      if (error) {
        this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
      }
    });
    this.service.updateCharacteristic(this.platform.Characteristic.HoldPosition, 0);
    this.clearPendingTarget(true);
    this.clearStopTimer();
    this.clearMotionStopTimer();
    this.setJammed(false);
    if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
      this.positionState = this.platform.Characteristic.PositionState.STOPPED;
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    }
  }

  private applyShutUpdate(shutValue: number) {
    const previousTarget = this.targetPosition;
    const previousState = this.positionState;
    const rawPosition = this.toPosition(shutValue);
    const previousPosition = this.currentPosition;
    this.currentPosition = Math.round(rawPosition);
    const positionDelta = this.currentPosition - previousPosition;
    const positionChanged = positionDelta !== 0;
    let nextPositionState = this.platform.Characteristic.PositionState.STOPPED;
    const now = Date.now();
    const firstUpdate = !this.hasReceivedPosition;
    if (firstUpdate) {
      this.hasReceivedPosition = true;
    }
    if (positionChanged) {
      this.setJammed(false);
    }
    if (this.pendingTargetPosition !== undefined) {
      this.clearMotionStopTimer();
      const reached = Math.abs(this.pendingTargetPosition - this.currentPosition) <= 1;
      const expired = this.pendingTargetExpiresAt > 0 && now > this.pendingTargetExpiresAt;
      if (reached || expired) {
        this.clearStopTimer();
        this.clearPendingTarget(false);
        this.targetPosition = this.currentPosition;
        if (expired) {
          this.setJammed(true);
        }
      } else {
        const distance = Math.abs(this.pendingTargetPosition - this.currentPosition);
        const progressed = this.pendingLastDistance === undefined || distance < this.pendingLastDistance;
        if (progressed) {
          this.pendingLastDistance = distance;
          this.schedulePendingNoProgressTimeout();
        }
        if (progressed && (positionChanged || firstUpdate)) {
          this.schedulePendingTimeout(this.pendingTargetPosition, this.currentPosition);
        }
        if (this.pendingTargetPosition > this.currentPosition) {
          nextPositionState = this.platform.Characteristic.PositionState.INCREASING;
        } else if (this.pendingTargetPosition < this.currentPosition) {
          nextPositionState = this.platform.Characteristic.PositionState.DECREASING;
        }
      }
    } else {
      this.clearPendingTarget(false);
      this.clearStopTimer();
      this.targetPosition = this.currentPosition;
      if (positionChanged) {
        nextPositionState = positionDelta > 0
          ? this.platform.Characteristic.PositionState.INCREASING
          : this.platform.Characteristic.PositionState.DECREASING;
        this.scheduleMotionStopTimer();
      } else {
        this.clearMotionStopTimer();
      }
    }
    this.positionState = nextPositionState;
    if (this.currentPosition !== previousPosition) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentPosition,
        this.currentPosition,
      );
    }
    if (this.targetPosition !== previousTarget) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.TargetPosition,
        this.targetPosition,
      );
    }
    if (this.positionState !== previousState) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.PositionState,
        this.positionState,
      );
    }
  }

  private updateConnection(isConnected: boolean) {
    this.connected = isConnected;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      this.connected ? 0 : 1,
    );
    if (!this.connected) {
      this.setJammed(false);
      this.hasReceivedPosition = false;
      this.clearPendingTarget(true);
      this.clearStopTimer();
      this.clearMotionStopTimer();
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
    }
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
    if (record.shut !== null && typeof record.shut !== 'undefined') {
      const shutValue = Number(record.shut);
      if (!Number.isNaN(shutValue)) {
        result.shut = shutValue;
      }
    }
    if (typeof record.online !== 'undefined') {
      result.online = this.platform.parseBoolean(record.online);
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
    this.platform.publishCommand(topic, payload, (error) => {
      if (error) {
        this.handleCommandPublishError(targetPosition, topic, error);
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
      const computed = Math.round((delta / 100) * travelTimeSeconds * 1000) + 1000;
      timeoutMs = Math.max(5000, computed);
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
      this.setJammed(true);
      this.clearPendingTarget(true);
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
      this.clearStopTimer();
      this.platform.log.debug(
        `No state updates for ${this.accessory.displayName} within ${timeoutMs}ms; marking STOPPED.`,
      );
    }, timeoutMs);
  }

  private schedulePendingNoProgressTimeout() {
    const travelTimeSeconds = this.platform.getCoveringTravelTimeSeconds();
    let timeoutMs = 10000;
    if (travelTimeSeconds > 0) {
      const computed = Math.round(travelTimeSeconds * 250);
      timeoutMs = Math.min(15000, Math.max(5000, computed));
    }
    if (timeoutMs <= 0) {
      return;
    }
    if (this.pendingNoProgressTimer) {
      clearTimeout(this.pendingNoProgressTimer);
    }
    this.pendingNoProgressTimer = setTimeout(() => {
      this.pendingNoProgressTimer = undefined;
      if (this.pendingTargetPosition === undefined) {
        return;
      }
      this.setJammed(true);
      this.clearPendingTarget(true);
      this.clearStopTimer();
      this.clearMotionStopTimer();
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
      this.platform.log.debug(
        `No progress for ${this.accessory.displayName} within ${timeoutMs}ms; forcing STOPPED.`,
      );
    }, timeoutMs);
  }

  private clearPendingNoProgressTimeout() {
    if (this.pendingNoProgressTimer) {
      clearTimeout(this.pendingNoProgressTimer);
      this.pendingNoProgressTimer = undefined;
    }
  }

  private clearPendingTarget(syncTarget: boolean) {
    if (this.pendingTargetTimer) {
      clearTimeout(this.pendingTargetTimer);
      this.pendingTargetTimer = undefined;
    }
    this.clearPendingNoProgressTimeout();
    this.pendingTargetPosition = undefined;
    this.pendingTargetExpiresAt = 0;
    this.pendingLastDistance = undefined;
    if (syncTarget && this.targetPosition !== this.currentPosition) {
      this.targetPosition = this.currentPosition;
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
    }
  }

  private clearStopTimer() {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
  }

  private scheduleMotionStopTimer() {
    const quietMs = 2500;
    if (this.motionStopTimer) {
      clearTimeout(this.motionStopTimer);
    }
    this.motionStopTimer = setTimeout(() => {
      this.motionStopTimer = undefined;
      if (this.pendingTargetPosition !== undefined) {
        return;
      }
      if (this.targetPosition !== this.currentPosition) {
        this.targetPosition = this.currentPosition;
        this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
      }
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
    }, quietMs);
  }

  private clearMotionStopTimer() {
    if (this.motionStopTimer) {
      clearTimeout(this.motionStopTimer);
      this.motionStopTimer = undefined;
    }
  }

  private disposeTimers() {
    this.clearPendingTarget(false);
    this.clearStopTimer();
    this.clearMotionStopTimer();
  }

  private setJammed(isJammed: boolean) {
    if (this.jammed === isJammed) {
      return;
    }
    this.jammed = isJammed;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusJammed,
      this.jammed ? 1 : 0,
    );
  }

  private handleCommandPublishError(target: number, topic: string, error: Error) {
    this.platform.log.error(`Publish failed for ${topic}: ${error.message}`);
    if (this.pendingTargetPosition !== target) {
      return;
    }
    this.setJammed(true);
    this.clearPendingTarget(true);
    this.clearStopTimer();
    this.clearMotionStopTimer();
    if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
      this.positionState = this.platform.Characteristic.PositionState.STOPPED;
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    }
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    this.assertPositionAvailable();
    return this.positionState;
  }

  private assertPositionAvailable() {
    if (!this.connected || !this.hasReceivedPosition) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
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
      this.platform.publishCommand(actionTopic, stopAction, (error) => {
        if (error) {
          this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
        }
      });
    }, delayMs);
  }
}
