import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class LeakSensorAccessory {
  private service: Service;
  private state = this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'LeakSensor');

    this.service = this.accessory.getService(this.platform.Service.LeakSensor)
      || this.accessory.addService(this.platform.Service.LeakSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.LeakDetected)
      .onGet(this.handleStateGet.bind(this));

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        const leak = this.platform.parseBoolean(message.toString());
        this.state = leak
          ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
          : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
        this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, this.state);
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

  async handleStateGet(): Promise<CharacteristicValue> {
    return this.state;
  }
}
