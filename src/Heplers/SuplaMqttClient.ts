import mqtt, {MqttClient} from 'mqtt';
import {Logger} from 'homebridge';
import {SuplaMqttClientContext} from './SuplaMqttClientContext';
import {SuplaChannelContext} from './SuplaChannelContext';

export class SuplaMqttClient {
  public client: MqttClient;
  constructor(
    private readonly context : SuplaMqttClientContext,
    private readonly log : Logger) {
    const options = {
      username: context.username,
      password: context.password,
    };
    const protocol = this.resolveProtocol();
    this.client = mqtt.connect(`${protocol}://${context.host}:${context.port}`, options);

    this.client.setMaxListeners(0);

    this.client.on('connect', () => {
      this.log.info('MQTT client connected');
    });
  }

  public async discoverChannelsAsync() : Promise<Array<SuplaChannelContext>> {
    const subscriptionTopic = `supla/${this.context.username}/devices/+/channels/#`;
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
        new RegExp(`^supla/${this.context.username}/devices/(\\d+)/channels/(\\d+)/(.*)$`),
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

    this.client.subscribe(subscriptionTopic, (err) => {
      if (err) {
        this.log.error(err.message);
        resolveDone?.();
      }
    });
    this.client.on('message', messageHandler);
    await discoveryDone;
    clearTimeout(maxTimer);
    if (quietTimer) {
      clearTimeout(quietTimer);
    }
    this.client.removeListener('message', messageHandler);
    this.client.unsubscribe(subscriptionTopic, (err) => {
      if (err) {
        this.log.error(err.message);
      }
    });

    const result : Array<SuplaChannelContext> = [];
    for (const entry of channelMap.values()) {
      const hiddenValue = entry.hidden ?? 'false';
      const hidden = typeof hiddenValue === 'string'
        ? hiddenValue.toLowerCase() === 'true'
        : Boolean(hiddenValue);
      if (hidden) {
        continue;
      }
      const channelType = entry.channelType ?? 'UNKNOWN';
      const channelFunction = entry.channelFunction ?? 'UNKNOWN';
      const caption = entry.channelCaption ?? `Device ${entry.deviceId} Channel ${entry.channelId}`;
      const topic = `supla/${this.context.username}/devices/${entry.deviceId}/channels/${entry.channelId}`;
      result.push(new SuplaChannelContext(
        topic,
        channelType,
        channelFunction,
        caption,
        entry.deviceId,
        entry.channelId,
      ));
    }
    return result;
  }

  private resolveProtocol(): string {
    const rawProtocol = (this.context.protocol ?? '').toString().toLowerCase();
    const tlsFlag = this.context.tls;
    const tlsEnabled = typeof tlsFlag === 'string'
      ? ['1', 'true', 'on', 'yes'].includes(tlsFlag.toLowerCase())
      : Boolean(tlsFlag);
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
}
