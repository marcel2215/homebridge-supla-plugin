import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ContactSensorAccessory {
  private service: Service;
  private state = this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'ContactSensor');

    this.service = this.accessory.getService(this.platform.Service.ContactSensor)
      || this.accessory.addService(this.platform.Service.ContactSensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(this.handleStateGet.bind(this));

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/hi`,
      (message) => {
        const closed = this.platform.parseBoolean(message.toString());
        this.state = closed
          ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
        this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState, this.state);
      },
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
    );
  }

  async handleStateGet(): Promise<CharacteristicValue> {
    return this.state;
  }
}
