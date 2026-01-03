import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class TemperatureAccessory {
  private service: Service;
  private temperature = 0;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'TemperatureSensor');

    this.service = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleTemperatureGet.bind(this));

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/temperature`,
      (message) => {
        const value = parseFloat(message.toString());
        if (!Number.isNaN(value)) {
          this.temperature = this.clamp(value, -50, 100);
          this.service.updateCharacteristic(
            this.platform.Characteristic.CurrentTemperature,
            this.temperature,
          );
        }
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

  async handleTemperatureGet(): Promise<CharacteristicValue> {
    return this.temperature;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
