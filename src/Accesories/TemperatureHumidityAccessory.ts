import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class TemperatureHumidityAccessory {
  private temperatureService: Service;
  private humidityService: Service;
  private temperature = 0;
  private humidity = 0;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'HumidityTemperatureSensor');

    this.temperatureService = this.accessory.getService(this.platform.Service.TemperatureSensor)
      || this.accessory.addService(this.platform.Service.TemperatureSensor);
    this.temperatureService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(this.handleTemperatureGet.bind(this));

    this.humidityService = this.accessory.getService(this.platform.Service.HumiditySensor)
      || this.accessory.addService(this.platform.Service.HumiditySensor);
    this.humidityService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.humidityService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(this.handleHumidityGet.bind(this));

    setTimeout(() => {
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/temperature`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/humidity`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
      this.platform.MqttClient.client.on('message', (topic, message) => {
        if (topic === `${this.context.topic}/state/temperature`) {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.temperature = this.clamp(value, -50, 100);
            this.temperatureService.updateCharacteristic(
              this.platform.Characteristic.CurrentTemperature,
              this.temperature,
            );
          }
        }
        if (topic === `${this.context.topic}/state/humidity`) {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.humidity = this.clamp(value, 0, 100);
            this.humidityService.updateCharacteristic(
              this.platform.Characteristic.CurrentRelativeHumidity,
              this.humidity,
            );
          }
        }
        if (topic === `${this.context.topic}/state/connected`) {
          this.connected = message.toString() === 'true';
          const faultValue = this.connected ? 0 : 1;
          this.temperatureService.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            faultValue,
          );
          this.humidityService.updateCharacteristic(
            this.platform.Characteristic.StatusFault,
            faultValue,
          );
        }
      });
    }, 3000);
  }

  async handleTemperatureGet(): Promise<CharacteristicValue> {
    return this.temperature;
  }

  async handleHumidityGet(): Promise<CharacteristicValue> {
    return this.humidity;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
