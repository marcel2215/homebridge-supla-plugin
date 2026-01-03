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
    this.metricPriority.forEach((key, metricIndex) => {
      this.platform.registerMqttHandler(
        `${this.context.topic}/state/${key}`,
        (message) => {
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
        },
        this.accessory.UUID,
      );
    });
  }

  async handleValueGet(): Promise<CharacteristicValue> {
    return this.value;
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
