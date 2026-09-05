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
import { resolveFrontGateConfig, ResolvedFrontGateConfig } from './Accesories/FrontGateConfig';
import { GateMqttTransport } from './Heplers/GateMqttTransport';


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
  private readonly gatePartialHiMode: 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore';
  private readonly gateReverseFollowUpDelayMs: number;
  private readonly gateOpenAssumeDelayMs: number;
  private readonly gateCommandCooldownMs: number;
  private readonly gatePublishRetryDelayMs: number;
  private readonly gateStrictReverseDoublePulse: boolean;
  private readonly gateDebugTimeline: boolean;
  private readonly commandQos: 0 | 1 | 2;
  private readonly commandRetain: boolean;
  private readonly mqttHandlers = new Map<string, Set<(message: Buffer, topic: string) => void>>();
  private readonly mqttHandlerOwners = new Map<string, Map<string, Set<(message: Buffer, topic: string) => void>>>();
  private readonly mqttWildcardHandlers = new Map<string, Set<(message: Buffer, topic: string) => void>>();
  private readonly ownerCleanups = new Map<string, Set<() => void>>();
  private readonly mqttDesiredSubscriptions = new Set<string>();
  private readonly mqttSubscriptions = new Set<string>();
  private readonly mqttPendingSubscriptions = new Set<string>();
  private readonly mqttRetryTimers = new Map<string, NodeJS.Timeout>();
  private readonly mqttRetryState = new Map<string, {
    attempt: number;
    delayMs: number;
    lastLogAt: number;
    hardDenyCount: number;
    blockedUntil: number;
  }>();

  private mqttRouterAttached = false;
  private gateTransport?: GateMqttTransport;
  private knownChannels: SuplaChannelContext[] = [];

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
      gatePartialHiMode?: string;
      gateReverseFollowUpDelayMs?: number;
      gateOpenAssumeDelayMs?: number;
      gateCommandCooldownMs?: number;
      gatePublishRetryDelayMs?: number;
      gateStrictReverseDoublePulse?: boolean | string;
      gateDebugTimeline?: boolean | string;
      commandQos?: number;
      commandRetain?: boolean | string;
    };
    this.coveringControlMode = this.normalizeCoveringControlMode(configView.coveringControlMode);
    this.coveringSetTopicSuffix = this.normalizeTopicSuffix(configView.coveringSetTopicSuffix || 'set/closing_percentage');
    this.coveringTiltTopicSuffix = this.normalizeTopicSuffix(configView.coveringTiltTopicSuffix || 'set/tilt');
    this.coveringExecuteActionOpen = (configView.coveringExecuteActionOpen || 'reveal').toString();
    this.coveringExecuteActionClose = (configView.coveringExecuteActionClose || 'shut').toString();
    this.coveringExecuteActionStop = (configView.coveringExecuteActionStop || 'stop').toString();
    this.coveringTravelTimeSeconds = Number(configView.coveringTravelTimeSeconds) || 0;
    this.gateControlMode = this.normalizeGateControlMode(configView.gateControlMode);
    this.gateExecuteActionOpen = (configView.gateExecuteActionOpen || 'open_close').toString();
    this.gateExecuteActionClose = (configView.gateExecuteActionClose || 'open_close').toString();
    this.gateExecuteActionToggle = (configView.gateExecuteActionToggle || 'open_close').toString();
    this.gateLockControlMode = this.normalizeGateLockControlMode(configView.gateLockControlMode);
    this.gateLockExecuteAction = (configView.gateLockExecuteAction || 'open').toString();
    this.gateLockSetTopicSuffix = this.normalizeTopicSuffix(configView.gateLockSetTopicSuffix || 'set/on');
    this.gateLockPulseSeconds = Number(configView.gateLockPulseSeconds) || 0;
    this.gateLockSetOnPayload = (configView.gateLockSetOnPayload ?? 'true').toString();
    this.gateLockSetOffPayload = (configView.gateLockSetOffPayload ?? 'false').toString();
    this.gatePartialHiMode = this.normalizeGatePartialHiMode(configView.gatePartialHiMode);
    this.gateReverseFollowUpDelayMs = this.normalizeGateReverseFollowUpDelayMs(
      configView.gateReverseFollowUpDelayMs,
    );
    this.gateOpenAssumeDelayMs = this.normalizeGateOpenAssumeDelayMs(
      configView.gateOpenAssumeDelayMs,
    );
    this.gateCommandCooldownMs = this.normalizeGateCommandCooldownMs(
      configView.gateCommandCooldownMs,
    );
    this.gatePublishRetryDelayMs = this.normalizeGatePublishRetryDelayMs(
      configView.gatePublishRetryDelayMs,
    );
    this.gateStrictReverseDoublePulse = this.parseBoolean(
      configView.gateStrictReverseDoublePulse ?? true,
    );
    this.gateDebugTimeline = this.parseBoolean(configView.gateDebugTimeline ?? false);
    this.commandQos = this.normalizeCommandQos(configView.commandQos);
    this.commandRetain = this.parseBoolean(configView.commandRetain ?? false);

    this.api.on('shutdown', () => {
      this.unregisterAllMqttHandlers();
      this.gateTransport?.dispose();
      if (this.MqttClient) {
        this.MqttClient.client.end(true);
      }
    });

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      const mqttSettings = this.config as unknown as SuplaMqttClientContext;
      this.MqttClient = new SuplaMqttClient(mqttSettings, this.log);
      this.startMqttRouter();
      this.MqttClient.client.on('connect', () => {
        this.resubscribeAll(true);
      });
      this.MqttClient.client.on('close', () => {
        this.clearActiveSubscriptions();
      });
      this.MqttClient.client.on('offline', () => {
        this.clearActiveSubscriptions();
      });
      this.MqttClient.client.on('end', () => {
        this.clearActiveSubscriptions();
      });
      if (this.MqttClient.client.connected) {
        this.resubscribeAll(true);
      }
      this.discoverDevices();
      this.MqttClient.discoverChannelsAsync((topic, handler) => (
        this.registerMqttHandler(topic, handler, 'discovery')
      )).then((channels) => {
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

    const cachedDevice = accessory.context.device as SuplaChannelContext | undefined;
    if (!cachedDevice || typeof cachedDevice !== 'object') {
      this.log.warn(
        `Cached accessory ${accessory.displayName} missing device context; will configure after discovery.`,
      );
      accessory.context.deviceConfigured = false;
      return;
    }
    const normalized = this.normalizeChannelContext(cachedDevice);
    accessory.context.device = normalized;
    accessory.context.deviceSignature = this.getChannelSignature(normalized);
    const configured = this.setupAccessory(normalized, accessory);
    accessory.context.deviceConfigured = configured;
  }

  /**
   * This is an example method showing how to register discovered accessories.
   * Accessories must only be registered once, previously created accessories
   * must not be registered again to prevent "duplicate UUID" errors.
   */
  discoverDevices(channelsOverride?: Array<SuplaChannelContext>) {
    const rawChannels = channelsOverride ?? this.loadChannelsFromConfig();
    const channels = rawChannels.map(channel => this.normalizeChannelContext(channel));
    this.knownChannels = channels;
    this.log.info('Channels discovered:', channels.length);
    this.log.debug(
      `Discovery mode: ${channelsOverride ? 'live' : 'cached'} channels`,
    );
    const channelUuids = new Set<string>();
    const shouldPrune = channelsOverride !== undefined && channels.length > 0;
    const findExistingByIds = (candidate: SuplaChannelContext) => {
      if (candidate.deviceId === 'unknown' || candidate.channelId === 'unknown') {
        return undefined;
      }
      return this.accessories.find((accessory) => {
        const existing = accessory.context.device as SuplaChannelContext | undefined;
        if (!existing) {
          return false;
        }
        if (existing.deviceId === 'unknown' || existing.channelId === 'unknown') {
          return false;
        }
        return existing.deviceId === candidate.deviceId && existing.channelId === candidate.channelId;
      });
    };

    // loop over the discovered devices and register each one if it has not already been registered
    for (const channel of channels) {
      const existingByIds = findExistingByIds(channel);
      const uuid = existingByIds?.UUID ?? this.getChannelUuid(channel);
      channelUuids.add(uuid);
      const existingAccessory = existingByIds ?? this.accessories.find(accessory => accessory.UUID === uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);
        const signature = this.getChannelSignature(channel);
        const previousSignature = existingAccessory.context.deviceSignature;
        const wasConfigured = existingAccessory.context.deviceConfigured === true;
        existingAccessory.context.device = channel;
        existingAccessory.context.deviceSignature = signature;
        this.log.debug(
          `Restoring channel ${channel.channelCaption} (${channel.deviceId}/${channel.channelId}) ` +
          `function=${channel.channelFunction} type=${channel.channelType}`,
        );
        // Gate contact authorization depends on the complete discovered channel set, not only this channel's signature.
        if (previousSignature !== signature || !wasConfigured || channel.channelFunction === 'CONTROLLINGTHEGATE') {
          if (previousSignature && previousSignature !== signature) {
            this.resetAccessoryServices(existingAccessory);
          }
          const configured = this.setupAccessory(channel, existingAccessory);
          existingAccessory.context.deviceConfigured = configured;
        }
        this.api.updatePlatformAccessories([existingAccessory]);
        continue;
      }

      this.log.info('Adding new accessory:', channel.channelCaption);
      this.log.debug(
        `Registering channel ${channel.channelCaption} (${channel.deviceId}/${channel.channelId}) ` +
        `function=${channel.channelFunction} type=${channel.channelType}`,
      );

      const accessory = new this.api.platformAccessory(channel.channelCaption, uuid);
      accessory.context.device = channel;
      accessory.context.deviceSignature = this.getChannelSignature(channel);
      if (this.setupAccessory(channel, accessory)) {
        accessory.context.deviceConfigured = true;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.push(accessory);
        this.api.updatePlatformAccessories([accessory]);
      }
    }

    if (shouldPrune) {
      const accessoriesToRemove = this.accessories.filter(accessory => !channelUuids.has(accessory.UUID));
      for (const accessory of accessoriesToRemove) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.unregisterMqttHandlers(accessory.UUID);
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
      const platformConfig = config.platforms?.find((platform) => platform.platform === PLATFORM_NAME);
      if (!platformConfig) {
        this.log.warn(`Failed to save channels: ${PLATFORM_NAME} not found in config.`);
        return;
      }
      platformConfig.channels = JSON.stringify(channels);
      const payload = JSON.stringify(config, null, 2);
      const tempPath = `${configPath}.tmp`;
      fs.writeFileSync(tempPath, payload);
      fs.renameSync(tempPath, configPath);
      this.log.debug(`Saved ${channels.length} channels to config.`);
    } catch (error) {
      this.log.error(`Failed to save channels: ${(error as Error).message}`);
    }
  }

  private normalizeChannelContext(channel: SuplaChannelContext): SuplaChannelContext {
    const rawTopic = (channel.rawTopic ?? channel.topic ?? '').toString();
    const baseFromTopic = this.normalizeTopicBase(rawTopic || (channel.topic ?? '').toString());
    let deviceId = channel.deviceId;
    let channelId = channel.channelId;
    if (!deviceId || !channelId) {
      const match = baseFromTopic.match(/\/devices\/(\d+)\/channels\/(\d+)(?:\/|$)/);
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
    const baseTopic = baseFromTopic || `supla/${mqttContext.username}/devices/${deviceId}/channels/${channelId}`;
    if (deviceId === 'unknown' || channelId === 'unknown') {
      this.log.warn(`Channel missing device/channel id for topic ${rawTopic}`);
    }
    return new SuplaChannelContext(
      baseTopic,
      channelType,
      channelFunction,
      caption,
      deviceId,
      channelId,
      rawTopic || undefined,
    );
  }

  private getChannelUuid(channel: SuplaChannelContext): string {
    const deviceId = channel.deviceId;
    const channelId = channel.channelId;
    const hasIds = deviceId && channelId && deviceId !== 'unknown' && channelId !== 'unknown';
    const key = hasIds
      ? `${deviceId}:${channelId}`
      : (channel.topic || channel.channelCaption || `${deviceId}:${channelId}`);
    return this.api.hap.uuid.generate(key);
  }

  private getChannelSignature(channel: SuplaChannelContext): string {
    return [
      channel.topic ?? '',
      channel.channelFunction ?? '',
      channel.channelType ?? '',
      channel.deviceId ?? '',
      channel.channelId ?? '',
    ].join('|');
  }

  private resetAccessoryServices(accessory: PlatformAccessory) {
    const keepUuid = this.Service.AccessoryInformation.UUID;
    for (const service of accessory.services) {
      if (service.UUID === keepUuid) {
        continue;
      }
      accessory.removeService(service);
    }
  }

  private setupAccessory(channel: SuplaChannelContext, accessory: PlatformAccessory): boolean {
    this.unregisterMqttHandlers(accessory.UUID);
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

  public getGatePartialHiMode(): 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore' {
    return this.gatePartialHiMode;
  }

  public getGateReverseFollowUpDelayMs(): number {
    return this.gateReverseFollowUpDelayMs;
  }

  public getGateOpenAssumeDelayMs(): number {
    return this.gateOpenAssumeDelayMs;
  }

  public getGateCommandCooldownMs(): number {
    return this.gateCommandCooldownMs;
  }

  public getGatePublishRetryDelayMs(): number {
    return this.gatePublishRetryDelayMs;
  }

  public getGateStrictReverseDoublePulse(): boolean {
    return this.gateStrictReverseDoublePulse;
  }

  public getGateDebugTimeline(): boolean {
    return this.gateDebugTimeline;
  }

  public getFrontGateConfig(context: SuplaChannelContext): ResolvedFrontGateConfig {
    const channels = this.knownChannels.length ? this.knownChannels : this.loadChannelsFromConfig();
    return resolveFrontGateConfig(this.config, context, channels, message => this.log.warn(`[FrontGate ${context.channelId}] ${message}`));
  }

  public getGateMqttTransport(): GateMqttTransport {
    if (!this.gateTransport) {
      const protocolVersion = Number(this.config.frontGateMqttProtocolVersion) === 5 ? 5 : 4;
      const mqtt = new SuplaMqttClient(
        this.config as unknown as SuplaMqttClientContext, this.log, { gateActuation: true, protocolVersion },
      );
      this.gateTransport = new GateMqttTransport(mqtt.client, this.log);
    }
    return this.gateTransport;
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

  private normalizeGatePartialHiMode(
    value?: string,
  ): 'moving' | 'open_endstop' | 'pedestrian_endstop' | 'ignore' {
    const normalized = (value ?? 'moving').toString().toLowerCase();
    if (normalized === 'open_endstop' || normalized === 'open') {
      return 'open_endstop';
    }
    if (normalized === 'pedestrian_endstop' || normalized === 'pedestrian') {
      return 'pedestrian_endstop';
    }
    if (normalized === 'ignore' || normalized === 'absent') {
      return 'ignore';
    }
    return 'moving';
  }

  private normalizeGateReverseFollowUpDelayMs(value?: number): number {
    const fallbackMs = 3000;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallbackMs;
    }
    const rounded = Math.round(parsed);
    return Math.min(10000, Math.max(250, rounded));
  }

  private normalizeGateOpenAssumeDelayMs(value?: number): number {
    const fallbackMs = 22000;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallbackMs;
    }
    const rounded = Math.round(parsed);
    return Math.min(120000, Math.max(1000, rounded));
  }

  private normalizeGateCommandCooldownMs(value?: number): number {
    const fallbackMs = 700;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallbackMs;
    }
    const rounded = Math.round(parsed);
    return Math.min(15000, Math.max(3000, rounded));
  }

  private normalizeGatePublishRetryDelayMs(value?: number): number {
    const fallbackMs = 300;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallbackMs;
    }
    const rounded = Math.round(parsed);
    return Math.min(5000, Math.max(0, rounded));
  }

  private normalizeTopicSuffix(value: string): string {
    return value.toString().replace(/^\/+/, '');
  }

  public normalizeTopicBase(topic: string): string {
    let base = (topic ?? '').toString().trim();
    if (!base) {
      return '';
    }
    base = base.replace(/\/+$/, '');
    base = base.replace(/\/state\/[^/]+$/, '');
    base = base.replace(/\/execute_action(?:\/.*)?$/, '');
    base = base.replace(/\/set\/.+$/, '');
    return base.replace(/\/+$/, '');
  }

  public registerMqttHandler(
    topic: string,
    handler: (message: Buffer, topic: string) => void,
    ownerId: string,
  ): () => void {
    if (!topic) {
      return () => undefined;
    }
    this.startMqttRouter();
    const handlerMap = this.isWildcardTopic(topic) ? this.mqttWildcardHandlers : this.mqttHandlers;
    const handlers = handlerMap.get(topic) ?? new Set();
    handlers.add(handler);
    handlerMap.set(topic, handlers);
    const ownerTopics = this.mqttHandlerOwners.get(ownerId) ?? new Map();
    const ownerHandlers = ownerTopics.get(topic) ?? new Set();
    ownerHandlers.add(handler);
    ownerTopics.set(topic, ownerHandlers);
    this.mqttHandlerOwners.set(ownerId, ownerTopics);
    this.mqttDesiredSubscriptions.add(topic);
    this.ensureSubscribed(topic, false);
    return () => {
      this.removeHandler(topic, handler);
      const ownerTopics = this.mqttHandlerOwners.get(ownerId);
      const ownerHandlers = ownerTopics?.get(topic);
      if (ownerHandlers) {
        ownerHandlers.delete(handler);
        if (ownerHandlers.size === 0) {
          ownerTopics?.delete(topic);
        }
      }
      if (ownerTopics && ownerTopics.size === 0) {
        this.mqttHandlerOwners.delete(ownerId);
      }
    };
  }

  public registerOwnerCleanup(ownerId: string, cleanup: () => void): () => void {
    const cleanups = this.ownerCleanups.get(ownerId) ?? new Set<() => void>();
    cleanups.add(cleanup);
    this.ownerCleanups.set(ownerId, cleanups);
    return () => {
      const active = this.ownerCleanups.get(ownerId);
      if (!active) {
        return;
      }
      active.delete(cleanup);
      if (active.size === 0) {
        this.ownerCleanups.delete(ownerId);
      }
    };
  }

  private unregisterMqttHandlers(ownerId: string) {
    this.runOwnerCleanup(ownerId);
    const ownerTopics = this.mqttHandlerOwners.get(ownerId);
    if (!ownerTopics) {
      return;
    }
    for (const [topic, handlers] of ownerTopics) {
      for (const handler of handlers) {
        this.removeHandler(topic, handler);
      }
    }
    this.mqttHandlerOwners.delete(ownerId);
  }

  private unregisterAllMqttHandlers() {
    const ownerIds = new Set<string>([
      ...this.mqttHandlerOwners.keys(),
      ...this.ownerCleanups.keys(),
    ]);
    for (const ownerId of Array.from(ownerIds)) {
      this.unregisterMqttHandlers(ownerId);
    }
    for (const topic of Array.from(this.mqttDesiredSubscriptions)) {
      this.removeSubscription(topic);
    }
    this.mqttHandlers.clear();
    this.mqttWildcardHandlers.clear();
    this.mqttDesiredSubscriptions.clear();
    this.mqttSubscriptions.clear();
    this.mqttPendingSubscriptions.clear();
    this.clearAllSubscriptionRetries();
    this.ownerCleanups.clear();
  }

  public publishCommand(topic: string, payload: string | Buffer, callback?: (error?: Error) => void) {
    const client = this.MqttClient?.client;
    if (!client || !client.connected) {
      const error = new Error('MQTT not connected');
      this.log.error(`MQTT not connected; cannot publish ${topic}`);
      if (callback) {
        callback(error);
      }
      return;
    }
    client.publish(
      topic,
      payload,
      { qos: this.commandQos, retain: this.commandRetain },
      (error) => {
        if (callback) {
          callback(error);
          return;
        }
        if (error) {
          this.log.error(`Publish failed for ${topic}: ${error.message}`);
        }
      },
    );
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

  private runOwnerCleanup(ownerId: string) {
    const cleanups = this.ownerCleanups.get(ownerId);
    if (!cleanups) {
      return;
    }
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error) {
        this.log.error(
          `Owner cleanup error for ${ownerId}: ${(error as Error).message}`,
        );
      }
    }
    this.ownerCleanups.delete(ownerId);
  }

  private clearActiveSubscriptions() {
    if (this.mqttSubscriptions.size > 0 || this.mqttPendingSubscriptions.size > 0) {
      this.log.debug('MQTT connection lost; clearing active subscriptions.');
    }
    this.mqttSubscriptions.clear();
    this.mqttPendingSubscriptions.clear();
    this.clearAllSubscriptionRetries();
  }

  private clearAllSubscriptionRetries() {
    for (const timer of this.mqttRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.mqttRetryTimers.clear();
    this.mqttRetryState.clear();
  }

  private clearSubscriptionRetry(topic: string) {
    const timer = this.mqttRetryTimers.get(topic);
    if (timer) {
      clearTimeout(timer);
      this.mqttRetryTimers.delete(topic);
    }
    this.mqttRetryState.delete(topic);
  }

  private scheduleSubscriptionRetry(topic: string, reason: string, hardDeny: boolean) {
    if (this.mqttRetryTimers.has(topic)) {
      return;
    }
    if (!this.mqttDesiredSubscriptions.has(topic)) {
      return;
    }
    const baseDelayMs = 2500;
    const maxDelayMs = 60000;
    const now = Date.now();
    const state = this.mqttRetryState.get(topic) ?? {
      attempt: 0,
      delayMs: baseDelayMs,
      lastLogAt: 0,
      hardDenyCount: 0,
      blockedUntil: 0,
    };
    if (hardDeny) {
      state.hardDenyCount += 1;
      if (state.hardDenyCount >= 3) {
        state.blockedUntil = Math.max(state.blockedUntil, now + 5 * 60 * 1000);
      }
    }
    const delayMs = state.delayMs;
    const blockedDelayMs = state.blockedUntil > now ? state.blockedUntil - now : 0;
    let scheduledDelayMs = delayMs;
    if (blockedDelayMs > 0) {
      scheduledDelayMs = blockedDelayMs;
    } else {
      const jitter = Math.round(delayMs * 0.2 * (Math.random() * 2 - 1));
      scheduledDelayMs = Math.max(baseDelayMs, Math.min(maxDelayMs, delayMs + jitter));
      state.delayMs = Math.min(maxDelayMs, Math.max(baseDelayMs, delayMs * 2));
      state.attempt += 1;
    }
    this.mqttRetryState.set(topic, state);
    this.log.debug(`Retrying MQTT subscribe for ${topic} in ${scheduledDelayMs}ms (${reason}).`);
    const timer = setTimeout(() => {
      this.mqttRetryTimers.delete(topic);
      if (!this.mqttDesiredSubscriptions.has(topic)) {
        return;
      }
      this.ensureSubscribed(topic, true);
    }, scheduledDelayMs);
    this.mqttRetryTimers.set(topic, timer);
  }

  private isSubscriptionGranted(topic: string, granted: Array<{topic: string; qos: number}> | undefined): boolean {
    if (!Array.isArray(granted) || granted.length === 0) {
      return true;
    }
    const entry = granted.find((item) => item.topic === topic);
    if (!entry) {
      return false;
    }
    return entry.qos === 0 || entry.qos === 1 || entry.qos === 2;
  }

  private logSubscriptionIssue(topic: string, message: string) {
    const now = Date.now();
    const state = this.mqttRetryState.get(topic) ?? {
      attempt: 0,
      delayMs: 2500,
      lastLogAt: 0,
      hardDenyCount: 0,
      blockedUntil: 0,
    };
    const shouldLog = state.lastLogAt === 0 || now - state.lastLogAt > 60000;
    if (shouldLog) {
      this.log.error(message);
      state.lastLogAt = now;
    } else {
      this.log.debug(message);
    }
    this.mqttRetryState.set(topic, state);
  }

  private ensureSubscribed(topic: string, force: boolean) {
    if (!this.MqttClient) {
      return;
    }
    if (!this.MqttClient.client.connected) {
      return;
    }
    if (!this.mqttDesiredSubscriptions.has(topic)) {
      return;
    }
    if (!force && (this.mqttSubscriptions.has(topic) || this.mqttPendingSubscriptions.has(topic))) {
      return;
    }
    if (this.mqttPendingSubscriptions.has(topic)) {
      return;
    }
    this.mqttPendingSubscriptions.add(topic);
    this.MqttClient.client.subscribe(topic, (err, granted) => {
      this.mqttPendingSubscriptions.delete(topic);
      if (err) {
        this.logSubscriptionIssue(topic, `MQTT subscribe failed for ${topic}: ${err.message}`);
        this.mqttSubscriptions.delete(topic);
        this.scheduleSubscriptionRetry(topic, 'error', false);
        return;
      }
      if (!this.isSubscriptionGranted(topic, granted)) {
        const grantedSummary = Array.isArray(granted)
          ? (granted.map((entry) => `${entry.topic}:${entry.qos}`).join(',') || 'none')
          : 'unknown';
        this.logSubscriptionIssue(
          topic,
          `MQTT subscription denied for ${topic} (granted=${grantedSummary}).`,
        );
        this.mqttSubscriptions.delete(topic);
        this.scheduleSubscriptionRetry(topic, 'denied', true);
        return;
      }
      if (!this.mqttDesiredSubscriptions.has(topic)) {
        this.mqttSubscriptions.delete(topic);
        this.clearSubscriptionRetry(topic);
        if (this.MqttClient.client.connected) {
          this.MqttClient.client.unsubscribe(topic, (unsubscribeErr) => {
            if (unsubscribeErr) {
              this.log.error(`MQTT unsubscribe failed for ${topic}: ${unsubscribeErr.message}`);
            }
          });
        }
        return;
      }
      this.clearSubscriptionRetry(topic);
      this.mqttSubscriptions.add(topic);
    });
  }

  private resubscribeAll(force: boolean) {
    if (!this.MqttClient) {
      return;
    }
    if (force) {
      this.mqttPendingSubscriptions.clear();
    }
    for (const topic of this.mqttDesiredSubscriptions) {
      this.ensureSubscribed(topic, force);
    }
  }

  private removeSubscription(topic: string) {
    this.mqttDesiredSubscriptions.delete(topic);
    this.mqttPendingSubscriptions.delete(topic);
    this.clearSubscriptionRetry(topic);
    if (!this.MqttClient) {
      return;
    }
    if (this.mqttSubscriptions.has(topic)) {
      this.MqttClient.client.unsubscribe(topic, (err) => {
        if (err) {
          this.log.error(`MQTT unsubscribe failed for ${topic}: ${err.message}`);
        }
      });
      this.mqttSubscriptions.delete(topic);
    }
  }

  private removeHandler(topic: string, handler: (message: Buffer, topic: string) => void) {
    const handlerMap = this.isWildcardTopic(topic) ? this.mqttWildcardHandlers : this.mqttHandlers;
    const active = handlerMap.get(topic);
    if (!active) {
      return;
    }
    active.delete(handler);
    if (active.size === 0) {
      handlerMap.delete(topic);
      this.removeSubscription(topic);
    }
  }

  private isWildcardTopic(topic: string): boolean {
    return topic.includes('+') || topic.includes('#');
  }

  private topicMatchesFilter(topic: string, filter: string): boolean {
    if (filter === topic) {
      return true;
    }
    const filterParts = filter.split('/');
    const topicParts = topic.split('/');
    for (let i = 0; i < filterParts.length; i += 1) {
      const filterPart = filterParts[i];
      if (filterPart === '#') {
        return i === filterParts.length - 1;
      }
      if (i >= topicParts.length) {
        return false;
      }
      if (filterPart === '+') {
        continue;
      }
      if (filterPart !== topicParts[i]) {
        return false;
      }
    }
    return filterParts.length === topicParts.length;
  }

  private normalizeCommandQos(value?: number): 0 | 1 | 2 {
    const parsed = Number(value);
    if (parsed === 1 || parsed === 2) {
      return parsed;
    }
    return 0;
  }

  private startMqttRouter() {
    if (this.mqttRouterAttached || !this.MqttClient) {
      return;
    }
    this.mqttRouterAttached = true;
    this.resubscribeAll(false);
    this.MqttClient.client.on('message', (topic, message) => {
      const dispatched = new Set<(message: Buffer, topic: string) => void>();
      const dispatch = (handler: (message: Buffer, topic: string) => void, label: string) => {
        if (dispatched.has(handler)) {
          return;
        }
        dispatched.add(handler);
        try {
          handler(message, topic);
        } catch (error) {
          this.log.error(
            `MQTT handler error for ${label}: ${(error as Error).message}`,
          );
        }
      };
      const exactHandlers = this.mqttHandlers.get(topic);
      if (exactHandlers) {
        for (const handler of exactHandlers) {
          dispatch(handler, topic);
        }
      }
      if (this.mqttWildcardHandlers.size === 0) {
        return;
      }
      for (const [filter, handlers] of this.mqttWildcardHandlers) {
        if (!this.topicMatchesFilter(topic, filter)) {
          continue;
        }
        for (const handler of handlers) {
          dispatch(handler, filter);
        }
      }
    });
  }
}
