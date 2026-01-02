import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { HexToRGB, HSVtoRGB, RGBtoHSV, RGBToHex } from '../Heplers/ColorConverters';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';

export class DimmerRgbLightAccessory {
  private service: Service;
  private state = false;
  private hsv = {h: 0, s: 0, v: 0};
  private rgb = {r: 0, g: 0, b: 0};
  private brightness = 0;
  private hasDimmerBrightness = false;
  private connected = true;
  private overcurrent = false;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'DimmerRGBController');

    this.service = this.accessory.getService(this.platform.Service.Lightbulb)
      || this.accessory.addService(this.platform.Service.Lightbulb);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.handleOnGet.bind(this))
      .onSet(this.handleOnSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Brightness)
      .onGet(this.handleBrightnessGet.bind(this))
      .onSet(this.handleBrightnessSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Hue)
      .onGet(this.handleHueGet.bind(this))
      .onSet(this.handleHueSet.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.Saturation)
      .onGet(this.handleSaturationGet.bind(this))
      .onSet(this.handleSaturationSet.bind(this));

    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/on`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/color`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/color_brightness`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/brightness`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/connected`);
    this.platform.MqttClient.client.subscribe(`${this.context.topic}/state/overcurrent_relay_off`);
    this.platform.MqttClient.client.on('message', (topic, message) => {
      switch (topic) {
        case `${this.context.topic}/state/on`:
          this.state = message.toString() === 'true';
          this.service.updateCharacteristic(this.platform.Characteristic.On, this.state);
          break;
        case `${this.context.topic}/state/color`:
          this.rgb = HexToRGB(message.toString());
          this.hsv = RGBtoHSV(this.rgb.r, this.rgb.g, this.rgb.b);
          this.updateColor();
          break;
        case `${this.context.topic}/state/color_brightness`:
          this.hsv.v = parseInt(message.toString(), 10);
          if (!this.hasDimmerBrightness) {
            this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.hsv.v);
          }
          this.updateColor();
          break;
        case `${this.context.topic}/state/brightness`:
          this.brightness = parseInt(message.toString(), 10);
          this.hasDimmerBrightness = true;
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
          break;
        case `${this.context.topic}/state/connected`:
          this.connected = message.toString() === 'true';
          this.updateFault();
          break;
        case `${this.context.topic}/state/overcurrent_relay_off`:
          this.overcurrent = message.toString() === 'true';
          this.updateFault();
          break;
      }
    });
  }

  async handleOnGet(): Promise<CharacteristicValue> {
    return this.state;
  }

  async handleOnSet(value: CharacteristicValue) {
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/on = ${value.toString()}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/on`,
      value.toString(),
    );
  }

  async handleBrightnessGet(): Promise<CharacteristicValue> {
    return this.hasDimmerBrightness ? this.brightness : this.hsv.v;
  }

  async handleBrightnessSet(value: CharacteristicValue) {
    const target = value as number;
    this.brightness = target;
    this.hasDimmerBrightness = true;
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/brightness = ${target.toString()}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/brightness`,
      target.toString(),
    );
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/color_brightness = ${target.toString()}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/color_brightness`,
      target.toString(),
    );
  }

  async handleHueGet(): Promise<CharacteristicValue> {
    return this.hsv.h;
  }

  async handleHueSet(value: CharacteristicValue) {
    this.hsv.h = value as number;
    this.rgb = HSVtoRGB(this.hsv.h, this.hsv.s, this.hsv.v);
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/color = ${RGBToHex(this.rgb.r, this.rgb.g, this.rgb.b)}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/color`,
      RGBToHex(this.rgb.r, this.rgb.g, this.rgb.b),
    );
  }

  async handleSaturationGet(): Promise<CharacteristicValue> {
    return this.hsv.s;
  }

  async handleSaturationSet(value: CharacteristicValue) {
    this.hsv.s = value as number;
    this.rgb = HSVtoRGB(this.hsv.h, this.hsv.s, this.hsv.v);
    this.platform.log.debug(
      `Publishing ${this.context.topic}/set/color = ${RGBToHex(this.rgb.r, this.rgb.g, this.rgb.b)}`,
    );
    this.platform.MqttClient.client.publish(
      `${this.context.topic}/set/color`,
      RGBToHex(this.rgb.r, this.rgb.g, this.rgb.b),
    );
  }

  private updateColor() {
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.hsv.h);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.hsv.s);
    if (!this.hasDimmerBrightness) {
      this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.hsv.v);
    }
  }

  private updateFault() {
    const fault = this.connected && !this.overcurrent ? 0 : 1;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, fault);
  }
}
