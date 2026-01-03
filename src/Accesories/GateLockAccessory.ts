import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class GateLockAccessory {
  private service: Service;
  private currentState = this.platform.Characteristic.LockCurrentState.SECURED;
  private targetState = this.platform.Characteristic.LockTargetState.SECURED;
  private connected = true;
  private pulseTimer?: NodeJS.Timeout;

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

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        const unlocked = this.platform.parseBoolean(message.toString());
        this.currentState = unlocked
          ? this.platform.Characteristic.LockCurrentState.UNSECURED
          : this.platform.Characteristic.LockCurrentState.SECURED;
        this.targetState = this.currentState;
        this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.currentState);
        this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);
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

  async handleCurrentStateGet(): Promise<CharacteristicValue> {
    return this.currentState;
  }

  async handleTargetStateGet(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async handleTargetStateSet(value: CharacteristicValue) {
    const target = value as number;
    this.targetState = target;
    this.service.updateCharacteristic(this.platform.Characteristic.LockTargetState, this.targetState);

    if (target !== this.platform.Characteristic.LockTargetState.UNSECURED) {
      return;
    }
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = undefined;
    }

    const mode = this.platform.getGateLockControlMode();
    if (mode === 'set_on_pulse') {
      const topic = `${this.context.topic}/${this.platform.getGateLockSetTopicSuffix()}`;
      const onPayload = this.platform.getGateLockSetOnPayload();
      const offPayload = this.platform.getGateLockSetOffPayload();
      const pulseSeconds = this.platform.getGateLockPulseSeconds();
      this.platform.log.debug(`Publishing ${topic} = ${onPayload}`);
      this.platform.publishCommand(topic, onPayload);
      if (pulseSeconds > 0) {
        this.pulseTimer = setTimeout(() => {
          this.platform.log.debug(`Publishing ${topic} = ${offPayload} (auto-off)`);
          this.platform.publishCommand(topic, offPayload);
        }, Math.round(pulseSeconds * 1000));
      } else {
        this.platform.log.warn(
          `Gate lock pulseSeconds is 0; leaving ${this.accessory.displayName} in set/on state.`,
        );
      }
      this.currentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
      this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.currentState);
      return;
    }

    const action = this.platform.getGateLockExecuteAction();
    if (!action) {
      this.platform.log.warn(`Gate lock action not configured for ${this.accessory.displayName}`);
      return;
    }
    this.platform.log.debug(`Publishing ${this.context.topic}/execute_action = ${action}`);
    this.platform.publishCommand(
      `${this.context.topic}/execute_action`,
      action,
    );
    this.currentState = this.platform.Characteristic.LockCurrentState.UNSECURED;
    this.service.updateCharacteristic(this.platform.Characteristic.LockCurrentState, this.currentState);
  }
}
