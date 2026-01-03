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

    this.platform.registerMqttHandler(
      `${this.context.topic}/state/on`,
      (message) => {
        this.state = this.platform.parseBoolean(message.toString());
        this.service.updateCharacteristic(this.platform.Characteristic.On, this.state);
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/color`,
      (message) => {
        this.rgb = HexToRGB(message.toString());
        this.hsv = RGBtoHSV(this.rgb.r, this.rgb.g, this.rgb.b);
        this.updateColor();
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/color_brightness`,
      (message) => {
        this.hsv.v = parseInt(message.toString(), 10);
        if (!this.hasDimmerBrightness) {
          this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.hsv.v);
        }
        this.updateColor();
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/brightness`,
      (message) => {
        this.brightness = parseInt(message.toString(), 10);
        this.hasDimmerBrightness = true;
        this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.brightness);
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/connected`,
      (message) => {
        this.connected = this.platform.parseBoolean(message.toString());
        this.updateFault();
      },
    );
    this.platform.registerMqttHandler(
      `${this.context.topic}/state/overcurrent_relay_off`,
      (message) => {
        this.overcurrent = this.platform.parseBoolean(message.toString());
        this.updateFault();
      },
    );
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
