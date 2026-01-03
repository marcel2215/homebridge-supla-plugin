import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';

import {SuplaChannelContext} from '../Heplers/SuplaChannelContext';

export class LightAccesory {
  private service: Service;
  private state = false;
  private connected = true;
  private overcurrent = false;

  constructor(
        private readonly platform: SuplaPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly context: SuplaChannelContext,
  ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
          .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
          .setCharacteristic(this.platform.Characteristic.Model, 'LightController');

        this.service = this.accessory.getService(this.platform.Service.Lightbulb)
            || this.accessory.addService(this.platform.Service.Lightbulb);

        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.On)
          .onGet(this.handleOnGet.bind(this))
          .onSet(this.handleOnSet.bind(this));

        this.platform.registerMqttHandler(
          `${this.context.topic}/state/on`,
          (message) => {
            this.platform.log.info(`Light ${this.context.channelCaption} state changed to ${message.toString()}`);
            this.state = this.platform.parseBoolean(message.toString());
            this.service.updateCharacteristic(this.platform.Characteristic.On, this.state);
          },
          this.accessory.UUID,
        );
        this.platform.registerMqttHandler(
          `${this.context.topic}/state/connected`,
          (message) => {
            this.connected = this.platform.parseBoolean(message.toString());
            this.updateFault();
          },
          this.accessory.UUID,
        );
        this.platform.registerMqttHandler(
          `${this.context.topic}/state/overcurrent_relay_off`,
          (message) => {
            this.overcurrent = this.platform.parseBoolean(message.toString());
            this.updateFault();
          },
          this.accessory.UUID,
        );
  }

  async handleOnGet(): Promise<CharacteristicValue> {
    return this.state;
  }

  async handleOnSet(value: CharacteristicValue) {
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/on = ${value.toString()}`,
    );
    this.platform.publishCommand(
      `${this.context.topic}/set/on`,
      value.toString());
    setTimeout(() => {
      this.service.updateCharacteristic(this.platform.Characteristic.On, this.state);
    }, 300);
  }

  private updateFault() {
    const fault = this.connected && !this.overcurrent ? 0 : 1;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, fault);
  }
}
