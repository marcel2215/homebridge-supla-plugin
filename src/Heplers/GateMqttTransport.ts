import { IPublishPacket, MqttClient } from 'mqtt';
import { FrontGateLogger, GateNotSentError } from '../Accesories/FrontGateFsm';

type Watcher = {
  actionTopic: string;
  topics: string[];
  message: (topic: string, message: Buffer, packet: IPublishPacket) => void;
  health: (healthy: boolean, epoch: number) => void;
  healthy: boolean;
  reportedEpoch: number;
};

/** One dedicated client, exact subscriptions only. No discovery wildcard can override MQTT 5 noLocal. */
export class GateMqttTransport {
  private readonly watchers = new Map<string, Watcher>();
  private readonly granted = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelays = new Map<string, number>();
  private epoch = 0;
  private disposed = false;

  public constructor(private readonly client: MqttClient, private readonly log: FrontGateLogger) {
    client.on('connect', this.onConnect);
    client.on('close', this.onDisconnect);
    client.on('offline', this.onDisconnect);
    client.on('end', this.onDisconnect);
    client.on('message', this.onMessage);
  }

  public get noLocal(): boolean {
    return this.client.options.protocolVersion === 5;
  }

  public register(
    owner: string, controlBase: string, sensorBase: string, observationTopic: string | undefined,
    message: Watcher['message'], health: Watcher['health'],
  ): () => void {
    const actionTopic = `${controlBase}/execute_action`;
    const topics = [actionTopic, `${controlBase}/state/connected`, `${sensorBase}/state/connected`, `${sensorBase}/state/hi`];
    if (observationTopic) {
      topics.push(observationTopic);
    }
    if (this.disposed || this.watchers.has(owner) || topics.some(topic => /[+#]/.test(topic))) {
      throw new Error('invalid or duplicate gate subscription');
    }
    const watcher = { actionTopic, topics: [...new Set(topics)], message, health, healthy: false, reportedEpoch: this.epoch };
    this.watchers.set(owner, watcher);
    health(false, this.epoch);
    for (const topic of watcher.topics) {
      this.subscribe(topic);
    }
    this.notifyHealth();
    return () => {
      this.watchers.delete(owner);
      for (const topic of watcher.topics) {
        if (!this.isWanted(topic)) {
          const timer = this.retries.get(topic);
          if (timer) {
            clearTimeout(timer);
          }
          this.retries.delete(topic);
          this.retryDelays.delete(topic);
          this.granted.delete(topic);
          if (this.client.connected) {
            this.client.unsubscribe(topic);
          }
        }
      }
    };
  }

  public publish(owner: string): Promise<void> {
    const watcher = this.watchers.get(owner);
    if (this.disposed || !this.client.connected || !watcher?.healthy) {
      return Promise.reject(new GateNotSentError('gate MQTT connection or required subscription unavailable'));
    }
    return new Promise((resolve, reject) => {
      // Never delegate endpoint targeting to SUPLA server open/close tasks.
      this.client.publish(watcher.actionTopic, 'open_close', { qos: 0, retain: false }, error => error ? reject(error) : resolve());
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.onDisconnect();
    this.watchers.clear();
    this.client.removeListener('connect', this.onConnect);
    this.client.removeListener('close', this.onDisconnect);
    this.client.removeListener('offline', this.onDisconnect);
    this.client.removeListener('end', this.onDisconnect);
    this.client.removeListener('message', this.onMessage);
    this.client.end(true);
  }

  private onConnect = (): void => {
    this.resetSubscriptions();
    for (const watcher of this.watchers.values()) {
      for (const topic of watcher.topics) {
        this.subscribe(topic);
      }
    }
  };

  private onDisconnect = (): void => {
    this.resetSubscriptions();
  };

  private resetSubscriptions(): void {
    this.epoch += 1;
    this.granted.clear();
    this.pending.clear();
    for (const timer of this.retries.values()) {
      clearTimeout(timer);
    }
    this.retries.clear();
    this.retryDelays.clear();
    this.notifyHealth();
  }

  private onMessage = (topic: string, message: Buffer, packet: IPublishPacket): void => {
    if (this.disposed || !this.client.connected) {
      return;
    }
    for (const watcher of this.watchers.values()) {
      if (watcher.topics.includes(topic)) {
        watcher.message(topic, message, packet);
      }
    }
  };

  private isWanted(topic: string): boolean {
    return [...this.watchers.values()].some(watcher => watcher.topics.includes(topic));
  }

  private subscribe(topic: string): void {
    if (this.disposed || !this.client.connected || this.granted.has(topic) || this.pending.has(topic) || !this.isWanted(topic)) {
      return;
    }
    const epoch = this.epoch;
    this.pending.add(topic);
    const options = this.noLocal ? { qos: 0 as const, nl: true } : { qos: 0 as const };
    this.client.subscribe(topic, options, (error, granted) => {
      if (epoch !== this.epoch || this.disposed) {
        return;
      }
      this.pending.delete(topic);
      if (!this.isWanted(topic)) {
        if (this.client.connected) {
          this.client.unsubscribe(topic);
        }
        return;
      }
      const grant = granted?.find(item => item.topic === topic);
      if (error || !grant || ![0, 1, 2].includes(grant.qos)) {
        const delay = this.retryDelays.get(topic) ?? 2500;
        if (delay === 2500) {
          this.log.warn('A required gate MQTT subscription was denied or failed; gate requests are disabled until all grants recover.');
        }
        this.retryDelays.set(topic, Math.min(60000, delay * 2));
        this.granted.delete(topic);
        this.notifyHealth();
        // Subscription recovery only. No command is queued or retried here.
        this.retries.set(topic, setTimeout(() => {
          this.retries.delete(topic);
          this.subscribe(topic);
        }, delay));
        return;
      }
      this.retryDelays.delete(topic);
      this.granted.add(topic);
      this.notifyHealth();
    });
  }

  private notifyHealth(): void {
    for (const watcher of this.watchers.values()) {
      const healthy = !this.disposed && this.client.connected && watcher.topics.every(topic => this.granted.has(topic));
      if (healthy !== watcher.healthy || watcher.reportedEpoch !== this.epoch) {
        watcher.healthy = healthy;
        watcher.reportedEpoch = this.epoch;
        watcher.health(healthy, this.epoch);
      }
    }
  }
}
