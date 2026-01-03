import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';

import {SuplaChannelContext} from '../Heplers/SuplaChannelContext';

export class WicketAccesory {
  private service: Service;
  private connected = true;

  constructor(
        private readonly platform: SuplaPlatform,
        private readonly accessory: PlatformAccessory,
        private readonly context: SuplaChannelContext,
  ) {
        this.accessory.getService(this.platform.Service.AccessoryInformation)!
          .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
          .setCharacteristic(this.platform.Characteristic.Model, 'GarageDoorOpener');

        this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
            || this.accessory.addService(this.platform.Service.GarageDoorOpener);

        this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

        this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
          .onGet(this.handleCurrentDoorStateGet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
          .onGet(this.handleTargetDoorStateGet.bind(this))
          .onSet(this.handleTargetDoorStateSet.bind(this));

        this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
          .onGet(this.handleObstructionDetectedGet.bind(this));

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

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.TargetDoorState.CLOSED;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    return this.platform.Characteristic.TargetDoorState.CLOSED;
  }

  async handleTargetDoorStateSet() {
    this.platform.log.debug(
      `Publishing ${this.context.topic}/execute_action = open`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/execute_action`,
      'open');
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentDoorState,
      this.platform.Characteristic.CurrentDoorState.OPEN);
    setTimeout(() => {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentDoorState,
        this.platform.Characteristic.CurrentDoorState.CLOSED);
    }, 1000);
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    const state = 0;
    return state;
  }

}
