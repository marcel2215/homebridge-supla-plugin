import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

type AirQualityKind = 'pm25' | 'pm10';

export class AirQualityAccessory {
  private service: Service;
  private value = 0;
  private connected = true;
  private kind: AirQualityKind;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.kind = this.resolveKind();
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'AirQualitySensor');

    this.service = this.accessory.getService(this.platform.Service.AirQualitySensor)
      || this.accessory.addService(this.platform.Service.AirQualitySensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.AirQuality)
      .onGet(this.handleAirQualityGet.bind(this));

    setTimeout(() => {
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/value`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
      this.platform.MqttClient.client.on('message', (topic, message) => {
        if (topic === `${this.context.topic}/state/value`) {
          const value = parseFloat(message.toString());
          if (!Number.isNaN(value)) {
            this.value = value;
            this.updateMeasurements();
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
    }, 3000);
  }

  async handleAirQualityGet(): Promise<CharacteristicValue> {
    return this.toAirQuality(this.value);
  }

  private updateMeasurements() {
    if (this.kind === 'pm25') {
      this.service.updateCharacteristic(this.platform.Characteristic.PM2_5Density, this.value);
    } else {
      this.service.updateCharacteristic(this.platform.Characteristic.PM10Density, this.value);
    }
    this.service.updateCharacteristic(this.platform.Characteristic.AirQuality, this.toAirQuality(this.value));
  }

  private resolveKind(): AirQualityKind {
    const caption = (this.context.channelCaption ?? '').toLowerCase();
    if (caption.includes('pm10')) {
      return 'pm10';
    }
    if (caption.includes('pm2.5') || caption.includes('pm2_5') || caption.includes('pm25') || caption.includes('pm2')) {
      return 'pm25';
    }
    return 'pm25';
  }

  private toAirQuality(value: number): number {
    if (this.kind === 'pm10') {
      if (value <= 54) {
        return this.platform.Characteristic.AirQuality.EXCELLENT;
      }
      if (value <= 154) {
        return this.platform.Characteristic.AirQuality.GOOD;
      }
      if (value <= 254) {
        return this.platform.Characteristic.AirQuality.FAIR;
      }
      if (value <= 354) {
        return this.platform.Characteristic.AirQuality.INFERIOR;
      }
      return this.platform.Characteristic.AirQuality.POOR;
    }
    if (value <= 12) {
      return this.platform.Characteristic.AirQuality.EXCELLENT;
    }
    if (value <= 35.4) {
      return this.platform.Characteristic.AirQuality.GOOD;
    }
    if (value <= 55.4) {
      return this.platform.Characteristic.AirQuality.FAIR;
    }
    if (value <= 150.4) {
      return this.platform.Characteristic.AirQuality.INFERIOR;
    }
    return this.platform.Characteristic.AirQuality.POOR;
  }
}
