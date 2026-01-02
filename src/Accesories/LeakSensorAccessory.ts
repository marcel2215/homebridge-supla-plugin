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

    setTimeout(() => {
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/hi`);
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
      this.platform.MqttClient.client.on('message', (topic, message) => {
        if (topic === `${this.context.topic}/state/hi`) {
          const leak = message.toString() === 'true';
          this.state = leak
            ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
            : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
          this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected, this.state);
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

  async handleStateGet(): Promise<CharacteristicValue> {
    return this.state;
  }
}
