import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ElectricityMeterAccessory {
  private service: Service;
  private value = 0.0001;
  private connected = true;
  private selectedMetricIndex = Number.MAX_SAFE_INTEGER;
  private readonly metricPriority = [
    'total_forward_active_power',
    'active_power',
    'power',
    'total_forward_active_energy',
    'energy',
    'current',
    'voltage',
    'frequency',
    'value',
  ];

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'ElectricityMeter');

    this.service = this.accessory.getService(this.platform.Service.LightSensor)
      || this.accessory.addService(this.platform.Service.LightSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentAmbientLightLevel)
      .onGet(this.handleValueGet.bind(this));

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/#`);
    this.platform.MqttClient.client.on('message', (topic, message) => {
      if (topic === `${this.context.topic}/state/connected`) {
        this.connected = message.toString() === 'true';
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.connected ? 0 : 1,
        );
        return;
      }
      if (!topic.startsWith(`${this.context.topic}/state/`)) {
        return;
      }
      const key = topic.substring(`${this.context.topic}/state/`.length);
      const metricIndex = this.metricPriority.indexOf(key);
      if (metricIndex === -1) {
        return;
      }
      const value = parseFloat(message.toString());
      if (Number.isNaN(value)) {
        return;
      }
      if (metricIndex <= this.selectedMetricIndex) {
        this.selectedMetricIndex = metricIndex;
        this.value = this.clamp(value, 0.0001, 100000);
        this.service.updateCharacteristic(
          this.platform.Characteristic.CurrentAmbientLightLevel,
          this.value,
        );
      }
    });
  }

  async handleValueGet(): Promise<CharacteristicValue> {
    return this.value;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
