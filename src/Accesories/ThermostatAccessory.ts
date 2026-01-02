import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ThermostatAccessory {
  private service: Service;
  private currentTemperature = 20;
  private targetTemperature = 20;
  private targetState = this.platform.Characteristic.TargetHeatingCoolingState.OFF;
  private currentState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
  private connected = true;
  private isOn = false;
  private hasCurrentTemperature = false;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'Thermostat');

    this.service = this.accessory.getService(this.platform.Service.Thermostat)
      || this.accessory.addService(this.platform.Service.Thermostat);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetStateGet.bind(this))
      .onSet(this.handleTargetStateSet.bind(this));

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/temperature_setpoint`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/mode`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/action`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/is_on`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/temperature`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
    this.platform.MqttClient.client.on('message', (topic, message) => {
      if (topic === `${this.context.topic}/state/temperature_setpoint`) {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.targetTemperature = this.clamp(value, 5, 35);
          this.service.updateCharacteristic(
            this.platform.Characteristic.TargetTemperature,
            this.targetTemperature,
          );
          if (!this.hasCurrentTemperature) {
            this.currentTemperature = this.targetTemperature;
            this.service.updateCharacteristic(
              this.platform.Characteristic.CurrentTemperature,
              this.currentTemperature,
            );
          }
        }
      }
      if (topic === `${this.context.topic}/state/temperature`) {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.currentTemperature = this.clamp(value, -50, 100);
          this.hasCurrentTemperature = true;
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            this.currentTemperature,
          );
        }
      }
      if (topic === `${this.context.topic}/state/mode`) {
        const mode = message.toString();
        this.targetState = this.toTargetState(mode, this.isOn);
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.targetState,
        );
      }
      if (topic === `${this.context.topic}/state/action`) {
        const action = message.toString();
        this.currentState = this.toCurrentState(action, this.isOn);
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentHeatingCoolingState,
          this.currentState,
        );
      }
      if (topic === `${this.context.topic}/state/is_on`) {
        this.isOn = message.toString() === 'true';
        this.targetState = this.toTargetState(undefined, this.isOn, this.targetState);
        this.currentState = this.toCurrentState(undefined, this.isOn, this.currentState);
        this.service.updateCharacteristic(
          this.platform.Characteristic.TargetHeatingCoolingState,
          this.targetState,
        );
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentHeatingCoolingState,
          this.currentState,
        );
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

  async handleCurrentTemperatureGet(): Promise<CharacteristicValue> {
    return this.currentTemperature;
  }

  async handleTargetTemperatureGet(): Promise<CharacteristicValue> {
    return this.targetTemperature;
  }

  async handleTargetTemperatureSet(value: CharacteristicValue) {
    const target = this.clamp(value as number, 5, 35);
    this.targetTemperature = target;
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/temperature_setpoint = ${target.toString()}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/temperature_setpoint`,
      target.toString(),
    );
  }

  async handleCurrentStateGet(): Promise<CharacteristicValue> {
    return this.currentState;
  }

  async handleTargetStateGet(): Promise<CharacteristicValue> {
    return this.targetState;
  }

  async handleTargetStateSet(value: CharacteristicValue) {
    const state = value as number;
    this.targetState = state;
    if (state === this.platform.Characteristic.TargetHeatingCoolingState.OFF) {
      this.platform.log.debug(
        `Publishing ${this.context.topic}/set/is_on = false`,
      );
      this.platform.MqttClient.client.publish(`${this.context.topic}/set/is_on`, 'false');
      return;
    }
    const mode = this.fromTargetState(state);
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/is_on = true`,
    );
    this.platform.MqttClient.client.publish(`${this.context.topic}/set/is_on`, 'true');
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/mode = ${mode}`,
    );
    this.platform.MqttClient.client.publish(`${this.context.topic}/set/mode`, mode);
  }

  private toTargetState(
    mode?: string,
    isOn?: boolean,
    fallback?: number,
  ): number {
    if (isOn === false) {
      return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    if (!mode) {
      return fallback ?? this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
    switch (mode.toLowerCase()) {
      case 'heat':
        return this.platform.Characteristic.TargetHeatingCoolingState.HEAT;
      case 'cool':
        return this.platform.Characteristic.TargetHeatingCoolingState.COOL;
      case 'auto':
        return this.platform.Characteristic.TargetHeatingCoolingState.AUTO;
      case 'off':
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
      default:
        return this.platform.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }

  private toCurrentState(
    action?: string,
    isOn?: boolean,
    fallback?: number,
  ): number {
    if (isOn === false) {
      return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
    if (!action) {
      return fallback ?? this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
    switch (action.toLowerCase()) {
      case 'heating':
        return this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
      case 'cooling':
        return this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
      default:
        return this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
    }
  }

  private fromTargetState(state: number): string {
    switch (state) {
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'heat';
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        return 'cool';
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'auto';
      default:
        return 'off';
    }
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
