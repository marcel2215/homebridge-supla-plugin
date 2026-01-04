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
  private hasReceivedTilt = false;
  private pendingTargetPosition?: number;
  private pendingTargetExpiresAt = 0;
  private pendingTargetTimer?: NodeJS.Timeout;
  private motionStopTimer?: NodeJS.Timeout;
  private jammed = false;
  private lastTiltCommandAt = 0;

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
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.handleTargetPositionGet.bind(this))
      .onSet(this.handleTargetPositionSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.handlePositionStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHorizontalTiltAngle)
      .onGet(this.handleCurrentTiltGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetHorizontalTiltAngle)
      .setProps({ minValue: -90, maxValue: 90, minStep: 1 })
      .onGet(this.handleTargetTiltGet.bind(this))
      .onSet(this.handleTargetTiltSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.HoldPosition)
      .onSet(this.handleHoldPositionSet.bind(this));
    this.service.setCharacteristic(this.platform.Characteristic.StatusJammed, 0);

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.disposeTimers();
    });

    const statusTopic = `${this.context.topic}/state/shut`;
    const tiltTopic = `${this.context.topic}/state/tilt`;
    const connectedTopic = `${this.context.topic}/state/connected`;

    this.platform.log.debug(
      `FacadeBlind ${this.accessory.displayName} topics: status=${statusTopic}, tilt=${tiltTopic}, connected=${connectedTopic}`,
    );

    this.platform.registerMqttHandler(
      statusTopic,
      (message) => {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.applyShutUpdate(value);
        }
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      tiltTopic,
      (message) => {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          const previousTilt = this.currentTiltAngle;
          const previousTarget = this.targetTiltAngle;
          this.currentTiltAngle = Math.round(this.toTiltAngle(value));
          this.hasReceivedTilt = true;
          const now = Date.now();
          const targetDelta = Math.abs(this.targetTiltAngle - this.currentTiltAngle);
          const commandStale = this.lastTiltCommandAt === 0 || (now - this.lastTiltCommandAt) > 3000;
          if (targetDelta <= 2 || commandStale) {
            this.targetTiltAngle = this.currentTiltAngle;
          }
          if (this.currentTiltAngle !== previousTilt) {
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentHorizontalTiltAngle,
              this.currentTiltAngle,
            );
          }
          if (this.targetTiltAngle !== previousTarget) {
            this.service.updateCharacteristic(
              this.platform.Characteristic.TargetHorizontalTiltAngle,
              this.targetTiltAngle,
            );
          }
        }
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      connectedTopic,
      (message) => {
        this.updateConnection(this.platform.parseBoolean(message.toString()));
      },
      this.accessory.UUID,
    );
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
      this.schedulePendingTimeout(this.targetPosition, this.currentPosition);
    } else {
      this.clearPendingTarget(false);
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
        if (positionChanged || firstUpdate) {
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

  private clearPendingTarget(syncTarget: boolean) {
    if (this.pendingTargetTimer) {
      clearTimeout(this.pendingTargetTimer);
      this.pendingTargetTimer = undefined;
    }
    this.pendingTargetPosition = undefined;
    this.pendingTargetExpiresAt = 0;
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

  private updateConnection(isConnected: boolean) {
    this.connected = isConnected;
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      this.connected ? 0 : 1,
    );
    if (!this.connected) {
      this.setJammed(false);
      this.hasReceivedPosition = false;
      this.hasReceivedTilt = false;
      this.lastTiltCommandAt = 0;
      this.clearPendingTarget(true);
      this.clearStopTimer();
      this.clearMotionStopTimer();
      if (this.positionState !== this.platform.Characteristic.PositionState.STOPPED) {
        this.positionState = this.platform.Characteristic.PositionState.STOPPED;
        this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
      }
    }
  }

  async handlePositionStateGet(): Promise<CharacteristicValue> {
    this.assertPositionAvailable();
    return this.positionState;
  }

  async handleCurrentTiltGet(): Promise<CharacteristicValue> {
    this.assertTiltAvailable();
    return this.currentTiltAngle;
  }

  async handleTargetTiltGet(): Promise<CharacteristicValue> {
    this.assertTiltAvailable();
    return this.targetTiltAngle;
  }

  async handleTargetTiltSet(value: CharacteristicValue) {
    const target = value as number;
    this.targetTiltAngle = Math.round(this.clamp(target, -90, 90));
    this.lastTiltCommandAt = Date.now();
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHorizontalTiltAngle,
      this.targetTiltAngle,
    );
    const tiltValue = this.toTiltValue(this.targetTiltAngle).toString();
    const tiltTopic = `${this.context.topic}/${this.platform.getCoveringTiltTopicSuffix()}`;
    this.platform.log.debug(`Publishing ${tiltTopic} = ${tiltValue}`);
    this.platform.publishCommand(tiltTopic, tiltValue, (error) => {
      if (error) {
        this.platform.log.error(`Publish failed for ${tiltTopic}: ${error.message}`);
      }
    });
  }

  private assertPositionAvailable() {
    if (!this.connected || !this.hasReceivedPosition) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }

  private assertTiltAvailable() {
    if (!this.connected || !this.hasReceivedTilt) {
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
      this.platform.publishCommand(actionTopic, stopAction, (error) => {
        if (error) {
          this.platform.log.error(`Publish failed for ${actionTopic}: ${error.message}`);
        }
      });
    }, delayMs);
  }
}
