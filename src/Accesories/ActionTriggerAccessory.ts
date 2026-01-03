import { Service, PlatformAccessory } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ActionTriggerAccessory {
  private service: Service;
  private connected = true;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'ActionTrigger');

    this.service = this.accessory.getService(this.platform.Service.StatelessProgrammableSwitch)
      || this.accessory.addService(this.platform.Service.StatelessProgrammableSwitch);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/action`,
      (message) => {
        const event = this.parseEvent(message.toString());
        this.platform.log.debug(
          `Action trigger ${this.context.channelCaption} event=${event}`,
        );
        this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, event);
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

  private parseEvent(payload: string): number {
    const value = payload.trim().toLowerCase();
    if (value === '1' || value.includes('double')) {
      return this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS;
    }
    if (value === '2' || value.includes('long') || value.includes('hold')) {
      return this.platform.Characteristic.ProgrammableSwitchEvent.LONG_PRESS;
    }
    return this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS;
  }
}
