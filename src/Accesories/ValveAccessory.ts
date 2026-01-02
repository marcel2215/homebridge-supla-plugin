import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ValveAccessory {
  private service: Service;
  private active = this.platform.Characteristic.Active.INACTIVE;
  private inUse = this.platform.Characteristic.InUse.NOT_IN_USE;
  private connected = true;
  private flooding = false;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'Valve');

    this.service = this.accessory.getService(this.platform.Service.Valve)
      || this.accessory.addService(this.platform.Service.Valve);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.service.setCharacteristic(this.platform.Characteristic.ValveType, this.platform.Characteristic.ValveType.GENERIC_VALVE);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.handleActiveGet.bind(this))
      .onSet(this.handleActiveSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.InUse)
      .onGet(this.handleInUseGet.bind(this));

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/closed`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/flooding`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
    this.platform.MqttClient.client.on('message', (topic, message) => {
      if (topic === `${this.context.topic}/state/closed`) {
        const closed = message.toString() === 'true';
        this.active = closed
          ? this.platform.Characteristic.Active.INACTIVE
          : this.platform.Characteristic.Active.ACTIVE;
        this.inUse = closed
          ? this.platform.Characteristic.InUse.NOT_IN_USE
          : this.platform.Characteristic.InUse.IN_USE;
        this.service.updateCharacteristic(this.platform.Characteristic.Active, this.active);
        this.service.updateCharacteristic(this.platform.Characteristic.InUse, this.inUse);
      }
      if (topic === `${this.context.topic}/state/flooding`) {
        this.flooding = message.toString() === 'true';
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.flooding ? 1 : 0,
        );
      }
      if (topic === `${this.context.topic}/state/connected`) {
        this.connected = message.toString() === 'true';
        this.service.updateCharacteristic(
          this.platform.Characteristic.StatusFault,
          this.connected && !this.flooding ? 0 : 1,
        );
      }
    });
  }

  async handleActiveGet(): Promise<CharacteristicValue> {
    return this.active;
  }

  async handleActiveSet(value: CharacteristicValue) {
    const active = value === this.platform.Characteristic.Active.ACTIVE;
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/closed = ${(!active).toString()}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/closed`,
      (!active).toString(),
    );
  }

  async handleInUseGet(): Promise<CharacteristicValue> {
    return this.inUse;
  }
}
