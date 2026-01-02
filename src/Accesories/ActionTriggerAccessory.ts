import { Service, PlatformAccessory } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class ActionTriggerAccessory {
  private service: Service;

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

    setTimeout(() => {
      this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/action`);
      this.platform.MqttClient.client.on('message', (topic, message) => {
        if (topic !== `${this.context.topic}/state/action`) {
          return;
        }
        const event = this.parseEvent(message.toString());
        this.service.updateCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent, event);
      });
    }, 3000);
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
