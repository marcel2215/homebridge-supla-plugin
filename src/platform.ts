import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { GarageDoorOpenerAccesory } from './Accesories/GarageDoorOpenerAccesory';
import { LightAccesory } from './Accesories/LightBulbAccesory';
import * as fs from 'fs';
import {SuplaMqttClient} from './Heplers/SuplaMqttClient';
import {RGBLightAccesory} from './Accesories/RGBLightBulbAccesory';
import {GateAccessory} from './Accesories/GateAccessory';
import {GateLockAccessory} from './Accesories/GateLockAccessory';
import {SuplaMqttClientContext} from './Heplers/SuplaMqttClientContext';
import {SuplaChannelContext} from './Heplers/SuplaChannelContext';
import {DimmerAccessory} from './Accesories/DimmerAccessory';
import {SwitchAccessory} from './Accesories/SwitchAccessory';
import {RollerShutterAccessory} from './Accesories/RollerShutterAccessory';
import {FacadeBlindAccessory} from './Accesories/FacadeBlindAccessory';
import {ContactSensorAccessory} from './Accesories/ContactSensorAccessory';
import {LeakSensorAccessory} from './Accesories/LeakSensorAccessory';
import {TemperatureAccessory} from './Accesories/TemperatureAccessory';
import {TemperatureHumidityAccessory} from './Accesories/TemperatureHumidityAccessory';
import {AirQualityAccessory} from './Accesories/AirQualityAccessory';
import {PressureAccessory} from './Accesories/PressureAccessory';
import {ValveAccessory} from './Accesories/ValveAccessory';
import {ThermostatAccessory} from './Accesories/ThermostatAccessory';
import {ElectricityMeterAccessory} from './Accesories/ElectricityMeterAccessory';
import {DimmerRgbLightAccessory} from './Accesories/DimmerRgbLightAccessory';
import {ActionTriggerAccessory} from './Accesories/ActionTriggerAccessory';


/**
 * HomebridgePlatform
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 */
export class SuplaPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public MqttClient!: SuplaMqttClient;

  public readonly accessories: PlatformAccessory[] = [];
  private readonly coveringControlMode: 'set' | 'execute_action' | 'hybrid';
  private readonly coveringSetTopicSuffix: string;
  private readonly coveringTiltTopicSuffix: string;
  private readonly coveringExecuteActionOpen: string;
  private readonly coveringExecuteActionClose: string;
  private readonly coveringExecuteActionStop: string;
  private readonly coveringTravelTimeSeconds: number;
  private readonly gateControlMode: 'execute_action' | 'toggle';
  private readonly gateExecuteActionOpen: string;
  private readonly gateExecuteActionClose: string;
  private readonly gateExecuteActionToggle: string;
  private readonly gateLockControlMode: 'execute_action' | 'set_on_pulse';
  private readonly gateLockExecuteAction: string;
  private readonly gateLockSetTopicSuffix: string;
  private readonly gateLockPulseSeconds: number;
  private readonly gateLockSetOnPayload: string;
  private readonly gateLockSetOffPayload: string;
  private readonly mqttHandlers = new Map<string, Set<(message: Buffer, topic: string) => void>>();
  private readonly mqttSubscriptions = new Set<string>();
  private mqttRouterAttached = false;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);
    const configView = this.config as unknown as {
      coveringControlMode?: string;
      coveringSetTopicSuffix?: string;
      coveringTiltTopicSuffix?: string;
      coveringExecuteActionOpen?: string;
      coveringExecuteActionClose?: string;
      coveringExecuteActionStop?: string;
      coveringTravelTimeSeconds?: number;
      gateControlMode?: string;
      gateExecuteActionOpen?: string;
      gateExecuteActionClose?: string;
      gateExecuteActionToggle?: string;
      gateLockControlMode?: string;
      gateLockExecuteAction?: string;
      gateLockSetTopicSuffix?: string;
      gateLockPulseSeconds?: number;
      gateLockSetOnPayload?: string;
      gateLockSetOffPayload?: string;
    };
    this.coveringControlMode = this.normalizeCoveringControlMode(configView.coveringControlMode);
    this.coveringSetTopicSuffix = this.normalizeTopicSuffix(configView.coveringSetTopicSuffix || 'set/closing_percentage');
    this.coveringTiltTopicSuffix = this.normalizeTopicSuffix(configView.coveringTiltTopicSuffix || 'set/tilt');
    this.coveringExecuteActionOpen = (configView.coveringExecuteActionOpen || 'reveal').toString();
    this.coveringExecuteActionClose = (configView.coveringExecuteActionClose || 'shut').toString();
    this.coveringExecuteActionStop = (configView.coveringExecuteActionStop || 'stop').toString();
    this.coveringTravelTimeSeconds = Number(configView.coveringTravelTimeSeconds) || 0;
    this.gateControlMode = this.normalizeGateControlMode(configView.gateControlMode);
    this.gateExecuteActionOpen = (configView.gateExecuteActionOpen || 'open').toString();
    this.gateExecuteActionClose = (configView.gateExecuteActionClose || 'close').toString();
    this.gateExecuteActionToggle = (configView.gateExecuteActionToggle || 'toggle').toString();
    this.gateLockControlMode = this.normalizeGateLockControlMode(configView.gateLockControlMode);
    this.gateLockExecuteAction = (configView.gateLockExecuteAction || 'open').toString();
    this.gateLockSetTopicSuffix = this.normalizeTopicSuffix(configView.gateLockSetTopicSuffix || 'set/on');
    this.gateLockPulseSeconds = Number(configView.gateLockPulseSeconds) || 0;
    this.gateLockSetOnPayload = (configView.gateLockSetOnPayload ?? 'true').toString();
    this.gateLockSetOffPayload = (configView.gateLockSetOffPayload ?? 'false').toString();

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      const mqttSettings = this.config as unknown as SuplaMqttClientContext;
      this.MqttClient = new SuplaMqttClient(mqttSettings, this.log);
      this.startMqttRouter();
      this.discoverDevices();
      this.MqttClient.discoverChannelsAsync().then((channels) => {
        this.persistChannels(channels);
        this.discoverDevices(channels);
        this.log.info('Channels discovered and saved to config file');
      }).catch((error) => {
        this.log.error(`Channel discovery failed: ${error.message}`);
      });
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices(channelsOverride?: Array<SuplaChannelContext>) {
    const rawChannels = channelsOverride ?? this.loadChannelsFromConfig();
    const channels = rawChannels.map(channel => this.normalizeChannelContext(channel));
    this.log.info('Channels discovered:', channels.length);
    this.log.debug(
      `Discovery mode: ${channelsOverride ? 'live' : 'cached'} channels`,
    );
    const channelUuids = new Set(channels.map(channel => this.getChannelUuid(channel)));
    const shouldPrune = channelsOverride !== undefined && channels.length > 0;

    // loop over the discovered devices and register each one if it has not already been registered
    for (const channel of channels) {
      const uuid = this.getChannelUuid(channel);
      const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        existingAccessory.context.device = channel;
        this.log.debug(
          `Restoring channel ${channel.channelCaption} (${channel.deviceId}/${channel.channelId}) ` +
          `function=${channel.channelFunction} type=${channel.channelType}`,
        );
        this.setupAccessory(channel, existingAccessory);
        continue;
      }

      this.log.info('Adding new accessory:', channel.channelCaption);
      this.log.debug(
        `Registering channel ${channel.channelCaption} (${channel.deviceId}/${channel.channelId}) ` +
        `function=${channel.channelFunction} type=${channel.channelType}`,
      );

      const accessory = new this.api.platformAccessory(channel.channelCaption, uuid);
      accessory.context.device = channel;
      if (this.setupAccessory(channel, accessory)) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
      }
    }

    if (shouldPrune) {
      const accessoriesToRemove = this.accessories.filter(accessory => !channelUuids.has(accessory.UUID));
      for (const accessory of accessoriesToRemove) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        const index = this.accessories.indexOf(accessory);
        if (index !== -1) {
          this.accessories.splice(index, 1);
        }
      }
    }
  }

  private loadChannelsFromConfig(): Array<SuplaChannelContext> {
    const rawChannels = (this.config as unknown as {channels?: unknown}).channels;
    if (!rawChannels) {
      this.log.debug('No cached channels found in config.');
      return [];
    }
    if (Array.isArray(rawChannels)) {
      return rawChannels as Array<SuplaChannelContext>;
    }
    if (typeof rawChannels === 'string') {
      try {
        return JSON.parse(rawChannels) as Array<SuplaChannelContext>;
      } catch (e) {
        this.log.warn(`Failed to parse cached channels: ${(e as Error).message}`);
        return [];
      }
    }
    this.log.warn('Cached channels format is invalid; expected string or array.');
    return [];
  }

  private persistChannels(channels: Array<SuplaChannelContext>) {
    try {
      const configPath = this.api.user.configPath();
      const config = JSON.parse(fs.readFileSync(configPath).toString());
      const platformConfig = config.platforms?.find((platform) => platform.platform === 'SuplaPlatform');
      if (!platformConfig) {
        this.log.warn('Failed to save channels: SuplaPlatform not found in config.');
        return;
      }
      platformConfig.channels = JSON.stringify(channels);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      this.log.debug(`Saved ${channels.length} channels to config.`);
    } catch (error) {
      this.log.error(`Failed to save channels: ${(error as Error).message}`);
    }
  }

  private normalizeChannelContext(channel: SuplaChannelContext): SuplaChannelContext {
    const topic = channel.topic ?? '';
    let deviceId = channel.deviceId;
    let channelId = channel.channelId;
    if (!deviceId || !channelId) {
      const match = topic.match(/devices\/([0-9]+)\/channels\/([0-9]+)$/);
      if (match) {
        deviceId = match[1];
        channelId = match[2];
      }
    }
    if (!deviceId) {
      deviceId = 'unknown';
    }
    if (!channelId) {
      channelId = 'unknown';
    }
    const caption = channel.channelCaption || `Device ${deviceId} Channel ${channelId}`;
    const channelType = channel.channelType || 'UNKNOWN';
    const channelFunction = channel.channelFunction || 'UNKNOWN';
    const mqttContext = this.config as unknown as SuplaMqttClientContext;
    const baseTopic = topic || `supla/${mqttContext.username}/devices/${deviceId}/channels/${channelId}`;
    if (deviceId === 'unknown' || channelId === 'unknown') {
      this.log.warn(`Channel missing device/channel id for topic ${topic}`);
    }
    return new SuplaChannelContext(
      baseTopic,
      channelType,
      channelFunction,
      caption,
      deviceId,
      channelId,
    );
  }

  private getChannelUuid(channel: SuplaChannelContext): string {
    const key = channel.deviceId && channel.channelId
      ? `${channel.deviceId}:${channel.channelId}`
      : (channel.topic || channel.channelCaption);
    return this.api.hap.uuid.generate(key);
  }

  private setupAccessory(channel: SuplaChannelContext, accessory: PlatformAccessory): boolean {
    this.log.debug(
      `Mapping channel ${channel.channelCaption} (${channel.deviceId}/${channel.channelId}) ` +
      `function=${channel.channelFunction} type=${channel.channelType}`,
    );
    switch (channel.channelFunction) {
      case 'CONTROLLINGTHEGARAGEDOOR':
        new GarageDoorOpenerAccesory(this, accessory, channel);
        return true;
      case 'CONTROLLINGTHEGATE':
        new GateAccessory(this, accessory, channel);
        return true;
      case 'CONTROLLINGTHEGATEWAYLOCK':
        new GateLockAccessory(this, accessory, channel);
        return true;
      case 'LIGHTSWITCH':
        new LightAccesory(this, accessory, channel);
        return true;
      case 'POWERSWITCH':
        new SwitchAccessory(this, accessory, channel);
        return true;
      case 'RGBLIGHTING':
        new RGBLightAccesory(this, accessory, channel);
        return true;
      case 'DIMMER':
        new DimmerAccessory(this, accessory, channel);
        return true;
      case 'DIMMERANDRGBLIGHTING':
        new DimmerRgbLightAccessory(this, accessory, channel);
        return true;
      case 'CONTROLLINGTHEROLLERSHUTTER':
        new RollerShutterAccessory(this, accessory, channel);
        return true;
      case 'CONTROLLINGTHEFACADEBLIND':
        new FacadeBlindAccessory(this, accessory, channel);
        return true;
      case 'OPENINGSENSOR_GATE':
      case 'OPENINGSENSOR_GATEWAY':
      case 'OPENINGSENSOR_WINDOW':
        new ContactSensorAccessory(this, accessory, channel);
        return true;
      case 'GENERAL_PURPOSE_MEASUREMENT':
        new AirQualityAccessory(this, accessory, channel);
        return true;
      case 'THERMOMETER':
        new TemperatureAccessory(this, accessory, channel);
        return true;
      case 'HUMIDITYANDTEMPERATURE':
        new TemperatureHumidityAccessory(this, accessory, channel);
        return true;
      case 'PRESSURESENSOR':
        new PressureAccessory(this, accessory, channel);
        return true;
      case 'VALVEOPENCLOSE':
        new ValveAccessory(this, accessory, channel);
        return true;
      case 'HVAC_THERMOSTAT':
        new ThermostatAccessory(this, accessory, channel);
        return true;
      case 'ELECTRICITYMETER':
        new ElectricityMeterAccessory(this, accessory, channel);
        return true;
      case 'ACTION_TRIGGER':
        new ActionTriggerAccessory(this, accessory, channel);
        return true;
      default:
        break;
    }

    switch (channel.channelType) {
      case 'DIMMERANDRGBLED':
        new DimmerRgbLightAccessory(this, accessory, channel);
        return true;
      case 'DIMMER':
        new DimmerAccessory(this, accessory, channel);
        return true;
      case 'RELAY':
        new SwitchAccessory(this, accessory, channel);
        return true;
      case 'BINARYSENSOR':
        if (this.isLeakSensorChannel(channel)) {
          new LeakSensorAccessory(this, accessory, channel);
        } else {
          new ContactSensorAccessory(this, accessory, channel);
        }
        return true;
      case 'THERMOMETER':
      case 'THERMOMETERDS18B20':
        new TemperatureAccessory(this, accessory, channel);
        return true;
      case 'HUMIDITYANDTEMPSENSOR':
        new TemperatureHumidityAccessory(this, accessory, channel);
        return true;
      case 'GENERAL_PURPOSE_MEASUREMENT':
        new AirQualityAccessory(this, accessory, channel);
        return true;
      case 'PRESSURESENSOR':
        new PressureAccessory(this, accessory, channel);
        return true;
      case 'ELECTRICITYMETER':
        new ElectricityMeterAccessory(this, accessory, channel);
        return true;
      case 'ACTION_TRIGGER':
        new ActionTriggerAccessory(this, accessory, channel);
        return true;
      default:
        break;
    }

    this.log.warn(
      `Unsupported channel ${channel.channelCaption} (${channel.channelFunction}/${channel.channelType})`,
    );
    return false;
  }

  private isLeakSensorChannel(channel: SuplaChannelContext): boolean {
    const caption = (channel.channelCaption ?? '').toLowerCase();
    return ['leak', 'flood', 'water', 'zalania'].some(term => caption.includes(term));
  }

  public getCoveringControlMode(): 'set' | 'execute_action' | 'hybrid' {
    return this.coveringControlMode;
  }

  public getCoveringSetTopicSuffix(): string {
    return this.coveringSetTopicSuffix;
  }

  public getCoveringTiltTopicSuffix(): string {
    return this.coveringTiltTopicSuffix;
  }

  public getCoveringExecuteActionOpen(): string {
    return this.coveringExecuteActionOpen;
  }

  public getCoveringExecuteActionClose(): string {
    return this.coveringExecuteActionClose;
  }

  public getCoveringExecuteActionStop(): string {
    return this.coveringExecuteActionStop;
  }

  public getCoveringTravelTimeSeconds(): number {
    return this.coveringTravelTimeSeconds;
  }

  public getGateControlMode(): 'execute_action' | 'toggle' {
    return this.gateControlMode;
  }

  public getGateExecuteActionOpen(): string {
    return this.gateExecuteActionOpen;
  }

  public getGateExecuteActionClose(): string {
    return this.gateExecuteActionClose;
  }

  public getGateExecuteActionToggle(): string {
    return this.gateExecuteActionToggle;
  }

  public getGateLockControlMode(): 'execute_action' | 'set_on_pulse' {
    return this.gateLockControlMode;
  }

  public getGateLockExecuteAction(): string {
    return this.gateLockExecuteAction;
  }

  public getGateLockSetTopicSuffix(): string {
    return this.gateLockSetTopicSuffix;
  }

  public getGateLockPulseSeconds(): number {
    return this.gateLockPulseSeconds;
  }

  public getGateLockSetOnPayload(): string {
    return this.gateLockSetOnPayload;
  }

  public getGateLockSetOffPayload(): string {
    return this.gateLockSetOffPayload;
  }

  private normalizeCoveringControlMode(value?: string): 'set' | 'execute_action' | 'hybrid' {
    const normalized = (value ?? 'set').toString().toLowerCase();
    if (normalized === 'execute_action') {
      return 'execute_action';
    }
    if (normalized === 'hybrid') {
      return 'hybrid';
    }
    return 'set';
  }

  private normalizeGateControlMode(value?: string): 'execute_action' | 'toggle' {
    const normalized = (value ?? 'execute_action').toString().toLowerCase();
    if (normalized === 'toggle') {
      return 'toggle';
    }
    return 'execute_action';
  }

  private normalizeGateLockControlMode(value?: string): 'execute_action' | 'set_on_pulse' {
    const normalized = (value ?? 'execute_action').toString().toLowerCase();
    if (normalized === 'set_on_pulse') {
      return 'set_on_pulse';
    }
    return 'execute_action';
  }

  private normalizeTopicSuffix(value: string): string {
    return value.toString().replace(/^\/+/, '');
  }

  public registerMqttHandler(topic: string, handler: (message: Buffer, topic: string) => void): () => void {
    if (!topic) {
      return () => undefined;
    }
    this.startMqttRouter();
    const handlers = this.mqttHandlers.get(topic) ?? new Set();
    handlers.add(handler);
    this.mqttHandlers.set(topic, handlers);
    if (!this.mqttSubscriptions.has(topic)) {
      this.MqttClient.client.subscribe(topic, (err) => {
        if (err) {
          this.log.error(`MQTT subscribe failed for ${topic}: ${err.message}`);
        }
      });
      this.mqttSubscriptions.add(topic);
    }
    return () => {
      const active = this.mqttHandlers.get(topic);
      if (!active) {
        return;
      }
      active.delete(handler);
      if (active.size === 0) {
        this.mqttHandlers.delete(topic);
        if (this.mqttSubscriptions.has(topic)) {
          this.MqttClient.client.unsubscribe(topic, (err) => {
            if (err) {
              this.log.error(`MQTT unsubscribe failed for ${topic}: ${err.message}`);
            }
          });
          this.mqttSubscriptions.delete(topic);
        }
      }
    };
  }

  public parseBoolean(value: unknown): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value === 1;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === '1'
        || normalized === 'true'
        || normalized === 'on'
        || normalized === 'yes';
    }
    return false;
  }

  private startMqttRouter() {
    if (this.mqttRouterAttached || !this.MqttClient) {
      return;
    }
    this.mqttRouterAttached = true;
    this.MqttClient.client.on('message', (topic, message) => {
      const handlers = this.mqttHandlers.get(topic);
      if (!handlers) {
        return;
      }
      for (const handler of handlers) {
        try {
          handler(message, topic);
        } catch (error) {
          this.log.error(
            `MQTT handler error for ${topic}: ${(error as Error).message}`,
          );
        }
      }
    });
  }
}
