import mqtt, {IPublishPacket, MqttClient} from 'mqtt';
import * as fs from 'fs';
import {Logger} from 'homebridge';
import {SuplaMqttClientContext} from './SuplaMqttClientContext';
import {SuplaChannelContext} from './SuplaChannelContext';

type RegisterHandler = (
  topic: string,
  handler: (message: Buffer, topic: string, packet: IPublishPacket) => void,
) => () => void;

export class SuplaMqttClient {
  public client: MqttClient;
  constructor(
    private readonly context : SuplaMqttClientContext,
    private readonly log : Logger) {
    const options: mqtt.IClientOptions = {
      username: context.username,
      password: context.password,
      protocolVersion: Number(context.mqttProtocolVersion) === 5 ? 5 : 4,
      resubscribe: false,
    };
    const protocol = this.resolveProtocol();
    if (this.usesTls(protocol)) {
      Object.assign(options, this.resolveTlsOptions());
    }
    this.log.info(
      `MQTT connecting to ${protocol}://${context.host}:${context.port} as ${context.username}`,
    );
    if (!context.username || !context.host || !context.port) {
      this.log.warn('MQTT config looks incomplete; check host/port/username.');
    }
    this.client = mqtt.connect(`${protocol}://${context.host}:${context.port}`, options);

    this.client.on('connect', () => {
      this.log.info('MQTT client connected');
    });
    this.client.on('reconnect', () => {
      this.log.warn('MQTT client reconnecting');
    });
    this.client.on('close', () => {
      this.log.warn('MQTT client closed');
    });
    this.client.on('offline', () => {
      this.log.warn('MQTT client offline');
    });
    this.client.on('end', () => {
      this.log.warn('MQTT client disconnected');
    });
    this.client.on('error', (error) => {
      this.log.error(`MQTT client error: ${error.message}`);
    });
  }

  public async discoverChannelsAsync(registerHandler?: RegisterHandler) : Promise<Array<SuplaChannelContext>> {
    const topicScheme = this.resolveTopicScheme();
    this.log.debug(`MQTT topic scheme: ${topicScheme}`);
    if (topicScheme === 'legacy') {
      return this.discoverLegacyRollerShuttersAsync(registerHandler);
    }
    if (topicScheme === 'cloud') {
      return this.discoverCloudChannelsAsync(registerHandler);
    }
    const cloudChannels = await this.discoverCloudChannelsAsync(registerHandler);
    if (cloudChannels.length > 0) {
      return cloudChannels;
    }
    this.log.warn('No channels discovered via cloud topics; trying legacy rollershutter topics.');
    return this.discoverLegacyRollerShuttersAsync(registerHandler);
  }

  private async discoverCloudChannelsAsync(registerHandler?: RegisterHandler): Promise<Array<SuplaChannelContext>> {
    const subscriptionTopic = `supla/${this.context.username}/devices/+/channels/#`;
    const includeHidden = this.resolveIncludeHidden();
    const usernamePattern = this.escapeRegex(this.context.username);
    this.log.info('Discovering channels via MQTT');
    this.log.debug(
      `Discovery subscribe topic: ${subscriptionTopic} includeHidden=${includeHidden}`,
    );
    const channelMap = new Map<string, {
      deviceId: string;
      channelId: string;
      channelType?: string;
      channelFunction?: string;
      channelCaption?: string;
      hidden?: string | boolean;
    }>();
    let resolveDone: (() => void) | undefined;
    const discoveryDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let quietTimer: NodeJS.Timeout | undefined;
    const maxWaitMs = 4000;
    const quietWindowMs = 1000;
    const maxTimer = setTimeout(() => resolveDone?.(), maxWaitMs);
    const messageHandler = (topic: string, message: Buffer) => {
      const match = topic.match(
        new RegExp(`^supla/${usernamePattern}/devices/(\\d+)/channels/(\\d+)/(.*)$`),
      );
      if (!match) {
        return;
      }
      const [, deviceId, channelId, suffix] = match;
      const key = `${deviceId}:${channelId}`;
      const entry = channelMap.get(key) ?? {deviceId, channelId};
      const value = message.toString();
      switch (suffix) {
        case 'type':
          entry.channelType = value;
          break;
        case 'function':
          entry.channelFunction = value;
          break;
        case 'caption':
          entry.channelCaption = value;
          break;
        case 'hidden':
          entry.hidden = value;
          break;
        default:
          break;
      }
      channelMap.set(key, entry);
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => resolveDone?.(), quietWindowMs);
    };
    let cleanup: (() => void) | undefined;
    if (registerHandler) {
      cleanup = registerHandler(subscriptionTopic, (message, topic) => {
        messageHandler(topic, message);
      });
    } else {
      this.client.subscribe(subscriptionTopic, (err) => {
        if (err) {
          this.log.error(`MQTT subscribe failed for ${subscriptionTopic}: ${err.message}`);
          resolveDone?.();
        }
      });
      this.client.on('message', messageHandler);
      cleanup = () => {
        this.client.removeListener('message', messageHandler);
        this.client.unsubscribe(subscriptionTopic, (err) => {
          if (err) {
            this.log.error(`MQTT unsubscribe failed for ${subscriptionTopic}: ${err.message}`);
          }
        });
      };
    }
    try {
      await discoveryDone;
    } finally {
      clearTimeout(maxTimer);
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      if (cleanup) {
        cleanup();
      }
    }

    const result : Array<SuplaChannelContext> = [];
    let skippedHidden = 0;
    for (const entry of channelMap.values()) {
      const hiddenValue = entry.hidden ?? 'false';
      const hidden = typeof hiddenValue === 'string'
        ? hiddenValue.toLowerCase() === 'true'
        : Boolean(hiddenValue);
      if (hidden && !includeHidden) {
        skippedHidden += 1;
        continue;
      }
      const channelType = entry.channelType ?? 'UNKNOWN';
      const channelFunction = entry.channelFunction ?? 'UNKNOWN';
      const caption = entry.channelCaption ?? `Device ${entry.deviceId} Channel ${entry.channelId}`;
      const topic = `supla/${this.context.username}/devices/${entry.deviceId}/channels/${entry.channelId}`;
      if (channelFunction === 'UNKNOWN' || channelType === 'UNKNOWN') {
        this.log.warn(
          `Channel ${entry.deviceId}/${entry.channelId} missing metadata (function=${channelFunction}, type=${channelType})`,
        );
      }
      this.log.debug(
        `Discovered channel ${caption} (${entry.deviceId}/${entry.channelId}) function=${channelFunction} type=${channelType}`,
      );
      result.push(new SuplaChannelContext(
        topic,
        channelType,
        channelFunction,
        caption,
        entry.deviceId,
        entry.channelId,
      ));
    }
    if (channelMap.size === 0) {
      this.log.warn(
        `No channels discovered within ${maxWaitMs}ms. Check MQTT ACLs, username, or retained topics.`,
      );
    }
    if (skippedHidden > 0 && !includeHidden) {
      this.log.info(`Skipped ${skippedHidden} hidden channel(s). Set includeHidden=true to include them.`);
    }
    this.log.info(`MQTT discovery complete. Channels discovered: ${result.length}`);
    return result;
  }

  private async discoverLegacyRollerShuttersAsync(registerHandler?: RegisterHandler): Promise<Array<SuplaChannelContext>> {
    const subscriptionTopic = 'supla/channels/status/rollershutter/#';
    this.log.info('Discovering legacy rollershutter channels via MQTT');
    this.log.debug(`Discovery subscribe topic: ${subscriptionTopic}`);
    const channelMap = new Map<string, {
      channelId: string;
    }>();
    let resolveDone: (() => void) | undefined;
    const discoveryDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let quietTimer: NodeJS.Timeout | undefined;
    const maxWaitMs = 4000;
    const quietWindowMs = 1000;
    const maxTimer = setTimeout(() => resolveDone?.(), maxWaitMs);
    const messageHandler = (topic: string, message: Buffer) => {
      const match = topic.match(/^supla\/channels\/status\/rollershutter\/(\d+)$/);
      if (!match) {
        return;
      }
      const channelId = match[1];
      if (!channelMap.has(channelId)) {
        channelMap.set(channelId, {channelId});
      }
      try {
        const payload = JSON.parse(message.toString());
        if (payload && typeof payload.id !== 'undefined') {
          const idValue = Number(payload.id);
          if (!Number.isNaN(idValue)) {
            const normalizedId = idValue.toString();
            if (!channelMap.has(normalizedId)) {
              channelMap.set(normalizedId, {channelId: normalizedId});
            }
          }
        }
      } catch {
        // ignore non-JSON payloads
      }
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => resolveDone?.(), quietWindowMs);
    };
    let cleanup: (() => void) | undefined;
    if (registerHandler) {
      cleanup = registerHandler(subscriptionTopic, (message, topic) => {
        messageHandler(topic, message);
      });
    } else {
      this.client.subscribe(subscriptionTopic, (err) => {
        if (err) {
          this.log.error(`MQTT subscribe failed for ${subscriptionTopic}: ${err.message}`);
          resolveDone?.();
        }
      });
      this.client.on('message', messageHandler);
      cleanup = () => {
        this.client.removeListener('message', messageHandler);
        this.client.unsubscribe(subscriptionTopic, (err) => {
          if (err) {
            this.log.error(`MQTT unsubscribe failed for ${subscriptionTopic}: ${err.message}`);
          }
        });
      };
    }
    try {
      await discoveryDone;
    } finally {
      clearTimeout(maxTimer);
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      if (cleanup) {
        cleanup();
      }
    }

    const result: Array<SuplaChannelContext> = [];
    for (const entry of channelMap.values()) {
      const statusTopic = `supla/channels/status/rollershutter/${entry.channelId}`;
      const caption = `RollerShutter ${entry.channelId}`;
      const channelContext = new SuplaChannelContext(
        statusTopic,
        'RELAY',
        'CONTROLLINGTHEROLLERSHUTTER',
        caption,
        'legacy',
        entry.channelId,
      );
      result.push(channelContext);
    }
    if (channelMap.size === 0) {
      this.log.warn(
        `No legacy rollershutter channels discovered within ${maxWaitMs}ms.`,
      );
    }
    this.log.info(`Legacy MQTT discovery complete. Channels discovered: ${result.length}`);
    return result;
  }

  private resolveProtocol(): string {
    const rawProtocol = (this.context.protocol ?? '').toString().toLowerCase();
    const tlsEnabled = this.resolveBoolean(this.context.tls, false);
    if (!rawProtocol) {
      return tlsEnabled ? 'mqtts' : 'mqtt';
    }
    if (tlsEnabled && rawProtocol === 'mqtt') {
      return 'mqtts';
    }
    if (tlsEnabled && rawProtocol === 'ws') {
      return 'wss';
    }
    return rawProtocol;
  }

  private resolveIncludeHidden(): boolean {
    return this.resolveBoolean(this.context.includeHidden, false);
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private usesTls(protocol: string): boolean {
    return protocol === 'mqtts' || protocol === 'wss';
  }

  private resolveTlsOptions(): mqtt.IClientOptions {
    const options: mqtt.IClientOptions = {};
    const caPath = (this.context.tlsCaPath ?? '').toString().trim();
    if (caPath) {
      try {
        options.ca = fs.readFileSync(caPath);
      } catch (error) {
        this.log.error(`Failed to read TLS CA at ${caPath}: ${(error as Error).message}`);
      }
    }
    const servername = (this.context.tlsServername ?? '').toString().trim();
    if (servername) {
      options.servername = servername;
    }
    if (typeof this.context.tlsRejectUnauthorized !== 'undefined') {
      options.rejectUnauthorized = this.resolveBoolean(this.context.tlsRejectUnauthorized, true);
    }
    return options;
  }

  private resolveBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value === 1;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === '') {
        return fallback;
      }
      if (['1', 'true', 'on', 'yes'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'off', 'no'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  private resolveTopicScheme(): 'cloud' | 'legacy' | 'auto' {
    const raw = (this.context.mqttTopicScheme ?? '').toString().toLowerCase();
    if (raw === 'legacy') {
      return 'legacy';
    }
    if (raw === 'auto') {
      return 'auto';
    }
    return 'cloud';
  }
}
