import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class GateLockAccessory {
  private service: Service;
  private currentState = this.platform.Characteristic.LockCurrentState.UNKNOWN;
  private targetState = this.platform.Characteristic.LockTargetState.SECURED;
  private connected = true;
  private hasFault = false;
  private pendingTarget?: number;
  private pulseTimer?: NodeJS.Timeout;
  private transitionTimer?: NodeJS.Timeout;
  private readonly transitionTimeoutMs = 15000;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'GateLock');

    const legacyDoor = this.accessory.getService(this.platform.Service.Door);
    if (legacyDoor) {
      this.accessory.removeService(legacyDoor);
    }
    const legacyGarage = this.accessory.getService(this.platform.Service.GarageDoorOpener);
    if (legacyGarage) {
      this.accessory.removeService(legacyGarage);
    }

    this.service = this.accessory.getService(this.platform.Service.LockMechanism)
      || this.accessory.addService(this.platform.Service.LockMechanism);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.LockCurrentState)
      .onGet(this.handleCurrentStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.LockTargetState)
      .onGet(this.handleTargetStateGet.bind(this))
      .onSet(this.handleTargetStateSet.bind(this));

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.clearPulseTimer();
      this.clearTransitionTimer();
    });

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        const unlocked = this.platform.parseBoolean(message.toString());
        const reachedPending = this.pendingTarget !== undefined
          && ((this.pendingTarget === this.platform.Characteristic.LockTargetState.UNSECURED && unlocked)
            || (this.pendingTarget === this.platform.Characteristic.LockTargetState.SECURED && !unlocked));
        if (this.pendingTarget !== undefined && !reachedPending) {
          this.setCurrentState(this.platform.Characteristic.LockCurrentState.UNKNOWN);
          return;
        }
        this.clearFaults();
        const nextCurrent = unlocked
          ? this.platform.Characteristic.LockCurrentState.UNSECURED
          : this.platform.Characteristic.LockCurrentState.SECURED;
        this.setCurrentState(nextCurrent);
        if (reachedPending) {
          this.pendingTarget = undefined;
          this.clearTransitionTimer();
        }
        if (this.pendingTarget === undefined) {
          const nextTarget = unlocked
            ? this.platform.Characteristic.LockTargetState.UNSECURED
            : this.platform.Characteristic.LockTargetState.SECURED;
          this.setTargetState(nextTarget);
          this.clearPulseTimer();
        }
      },
      this.accessory.UUID,
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/connected`,
      (message) => {
        this.connected = this.platform.parseBoolean(message.toString());
        if (!this.connected) {
          this.clearPulseTimer();
          this.clearTransitionTimer();
          this.pendingTarget = undefined;
          this.setCurrentState(this.platform.Characteristic.LockCurrentState.UNKNOWN);
        }
        this.updateStatusFault();
      },
      this.accessory.UUID,
    );

    this.updateStatusFault();
  }

  async handleCurrentStateGet(): Promise<CharacteristicValue> {
    return this.currentState;
  }

  async handleTargetStateGet(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async handleTargetStateSet(value: CharacteristicValue) {
    const target = value as number;
    if (target === this.targetState) {
      return;
    }
    const previousTarget = this.targetState;
    const previousCurrent = this.currentState;
    this.setTargetState(target);

    if (!this.connected) {
      this.platform.log.warn(`Gate lock ${this.accessory.displayName} is offline; ignoring command.`);
      this.setTargetState(previousTarget);
      this.updateStatusFault();
      return;
    }

    if (target !== this.platform.Characteristic.LockTargetState.UNSECURED) {
      this.clearPulseTimer();
      this.clearTransitionTimer();
      this.pendingTarget = undefined;
      if (this.connected && this.platform.getGateLockControlMode() === 'set_on_pulse') {
        const topic = `${this.context.topic}/${this.platform.getGateLockSetTopicSuffix()}`;
        const offPayload = this.platform.getGateLockSetOffPayload();
        this.platform.log.debug(`Publishing ${topic} = ${offPayload} (manual secure)`);
        this.platform.publishCommand(topic, offPayload);
      }
      this.setTargetState(previousTarget);
      return;
    }
    this.clearPulseTimer();
    if (this.pendingTarget === target) {
      return;
    }

    const mode = this.platform.getGateLockControlMode();
    if (mode === 'set_on_pulse') {
      this.pendingTarget = target;
      this.clearFaults();
      this.armTransitionTimer();
      const topic = `${this.context.topic}/${this.platform.getGateLockSetTopicSuffix()}`;
      const onPayload = this.platform.getGateLockSetOnPayload();
      const offPayload = this.platform.getGateLockSetOffPayload();
      const pulseSeconds = this.platform.getGateLockPulseSeconds();
      this.platform.log.debug(`Publishing ${topic} = ${onPayload}`);
      this.platform.publishCommand(topic, onPayload);
      if (pulseSeconds > 0) {
        this.pulseTimer = setTimeout(() => {
          if (!this.connected) {
            this.platform.log.debug(`Skipping auto-off publish for ${topic} (offline).`);
            return;
          }
          this.platform.log.debug(`Publishing ${topic} = ${offPayload} (auto-off)`);
          this.platform.publishCommand(topic, offPayload);
        }, Math.round(pulseSeconds * 1000));
      } else {
        this.platform.log.warn(
          `Gate lock pulseSeconds is 0; leaving ${this.accessory.displayName} in set/on state.`,
        );
      }
      this.setCurrentState(this.platform.Characteristic.LockCurrentState.UNKNOWN);
      return;
    }

    const action = this.platform.getGateLockExecuteAction();
    if (!action) {
      this.platform.log.warn(`Gate lock action not configured for ${this.accessory.displayName}`);
      this.pendingTarget = undefined;
      this.clearPulseTimer();
      this.clearTransitionTimer();
      this.setTargetState(previousTarget);
      this.setCurrentState(previousCurrent);
      return;
    }
    this.pendingTarget = target;
    this.clearFaults();
    this.armTransitionTimer();
    this.platform.log.debug(`Publishing ${this.context.topic}/execute_action = ${action}`);
    this.platform.publishCommand(
      `${this.context.topic}/execute_action`,
      action,
    );
    this.setCurrentState(this.platform.Characteristic.LockCurrentState.UNKNOWN);
  }

  private setCurrentState(next: number) {
    if (this.currentState === next) {
      return;
    }
    this.currentState = next;
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.currentState);
  }

  private setTargetState(next: number) {
    if (this.targetState === next) {
      return;
    }
    this.targetState = next;
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
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
    if (!this.hasFault) {
      return;
    }
    this.hasFault = false;
    this.updateStatusFault();
  }

  private armTransitionTimer() {
    this.clearTransitionTimer();
    this.transitionTimer = setTimeout(() => {
      this.transitionTimer = undefined;
      this.pendingTarget = undefined;
      this.hasFault = true;
      this.updateStatusFault();
      this.setCurrentState(this.platform.Characteristic.LockCurrentState.UNKNOWN);
      this.platform.log.warn(
        `Gate lock ${this.accessory.displayName} did not reach target within ${this.transitionTimeoutMs}ms.`,
      );
    }, this.transitionTimeoutMs);
  }

  private clearPulseTimer() {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }
  }

  private clearTransitionTimer() {
    if (this.transitionTimer) {
      clearTimeout(this.transitionTimer);
      this.transitionTimer = undefined;
    }
  }
}
