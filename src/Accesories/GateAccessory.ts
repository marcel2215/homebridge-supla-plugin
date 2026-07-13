import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { SuplaPlatform } from '../platform';
import { SuplaChannelContext } from '../Heplers/SuplaChannelContext';
import {
  DoorTargetState,
  FrontGateFsm,
  FrontGateSnapshot,
} from './FrontGateFsm';

type FrontGateConfigView = {
  channels?: unknown;
  frontGateSensorTopic?: string;
  frontGateSensorDeviceId?: string | number;
  frontGateSensorChannelId?: string | number;
};

type SensorCandidate = {
  channel: SuplaChannelContext;
  baseTopic: string;
  score: number;
  reasons: string[];
};

export class GateAccessory {
  private readonly service: Service;
  private readonly controlBaseTopic: string;
  private readonly sensorBaseTopic: string;
  private readonly fsm: FrontGateFsm;
  private pendingSelfCommandEchoCount = 0;
  private pendingSelfCommandEchoPayload?: string;
  private pendingSelfCommandEchoExpiresAt = 0;

  constructor(
    private readonly platform: SuplaPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly context: SuplaChannelContext,
  ) {
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Supla')
      .setCharacteristic(this.platform.Characteristic.Model, 'GateController');

    const legacyDoor = this.accessory.getService(this.platform.Service.Door);
    if (legacyDoor) {
      this.accessory.removeService(legacyDoor);
    }

    this.service = this.accessory.getService(this.platform.Service.GarageDoorOpener)
      || this.accessory.addService(this.platform.Service.GarageDoorOpener);
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);

    this.controlBaseTopic = this.platform.normalizeTopicBase(this.context.topic);
    this.sensorBaseTopic = this.resolveSensorBaseTopic();

    // Remove stale persisted direction state from the previous implementation.
    delete this.accessory.context.frontGateFsm;

    this.fsm = new FrontGateFsm(
      {
        pulseMotor: async (reason) => this.publishPulse(reason),
        publishSnapshot: (snapshot) => this.applySnapshot(snapshot),
        log: {
          debug: (message) => this.platform.log.debug(`[FrontGate ${this.accessory.displayName}] ${message}`),
          info: (message) => this.platform.log.info(`[FrontGate ${this.accessory.displayName}] ${message}`),
          warn: (message) => this.platform.log.warn(`[FrontGate ${this.accessory.displayName}] ${message}`),
        },
      },
      this.platform.getFrontGateTimings(),
      {},
    );

    this.service.getCharacteristic(this.platform.Characteristic.CurrentDoorState)
      .onGet(this.handleCurrentDoorStateGet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.TargetDoorState)
      .onGet(this.handleTargetDoorStateGet.bind(this))
      .onSet(this.handleTargetDoorStateSet.bind(this));
    this.service.getCharacteristic(this.platform.Characteristic.ObstructionDetected)
      .onGet(this.handleObstructionDetectedGet.bind(this));

    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    this.platform.registerOwnerCleanup(this.accessory.UUID, () => {
      this.fsm.dispose();
    });

    this.platform.registerMqttHandler(
      `${this.controlBaseTopic}/state/connected`,
      (message) => {
        this.fsm.handleControlConnectedChange(this.platform.parseBoolean(message.toString()));
      },
      this.accessory.UUID,
    );

    this.platform.registerMqttHandler(
      `${this.sensorBaseTopic}/state/connected`,
      (message) => {
        this.fsm.handleSensorConnectedChange(this.platform.parseBoolean(message.toString()));
      },
      this.accessory.UUID,
    );

    this.platform.registerMqttHandler(
      `${this.sensorBaseTopic}/state/hi`,
      (message) => {
        this.fsm.handleClosedSensorChange(this.platform.parseBoolean(message.toString()));
      },
      this.accessory.UUID,
    );

    this.platform.registerMqttHandler(
      `${this.controlBaseTopic}/execute_action`,
      (message) => {
        const payload = message.toString();
        if (this.shouldIgnoreObservedExecuteAction(payload)) {
          return;
        }
        this.fsm.handleObservedExternalPulse(`mqtt-execute_action:${payload}`);
      },
      this.accessory.UUID,
    );

    this.applySnapshot(this.fsm.getSnapshot());
  }

  async handleCurrentDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.currentDoorState === undefined) {
      throw this.createCommunicationError();
    }
    return snapshot.currentDoorState;
  }

  async handleTargetDoorStateGet(): Promise<CharacteristicValue> {
    const snapshot = this.fsm.getSnapshot();
    if (!snapshot.available || snapshot.targetDoorState === undefined) {
      throw this.createCommunicationError();
    }
    return snapshot.targetDoorState;
  }

  async handleTargetDoorStateSet(value: CharacteristicValue) {
    const target = Number(value) === DoorTargetState.OPEN ? 'open' : 'closed';
    try {
      await this.fsm.requestHomeKitTarget(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.platform.log.warn(`Gate ${this.accessory.displayName} command failed: ${message}`);
      throw this.createCommunicationError();
    }
  }

  async handleObstructionDetectedGet(): Promise<CharacteristicValue> {
    return false;
  }

  private applySnapshot(snapshot: FrontGateSnapshot): void {
    if (this.service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, snapshot.available);
    }
    if (this.service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.StatusFault,
        snapshot.available
          ? this.platform.Characteristic.StatusFault.NO_FAULT
          : this.platform.Characteristic.StatusFault.GENERAL_FAULT,
      );
    }

    this.service.updateCharacteristic(this.platform.Characteristic.ObstructionDetected, false);

    if (!snapshot.available || snapshot.currentDoorState === undefined || snapshot.targetDoorState === undefined) {
      const error = this.createCommunicationError();
      this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, error);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, error);
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.CurrentDoorState, snapshot.currentDoorState);
    this.service.updateCharacteristic(this.platform.Characteristic.TargetDoorState, snapshot.targetDoorState);
  }

  private createCommunicationError(): Error {
    return new Error('Front gate controller is unavailable');
  }

  private async publishPulse(reason: string): Promise<void> {
    const action = this.platform.getFrontGatePulseAction();
    if (!action) {
      throw new Error('front gate pulse action is not configured');
    }

    this.platform.log.debug(`Publishing ${this.controlBaseTopic}/execute_action = ${action} (${reason})`);
    this.noteExpectedSelfCommandEcho(action);

    return new Promise<void>((resolve, reject) => {
      this.platform.publishCommand(`${this.controlBaseTopic}/execute_action`, action, (error) => {
        if (error) {
          this.retractExpectedSelfCommandEcho(action);
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private noteExpectedSelfCommandEcho(payload: string): void {
    this.prunePendingSelfCommandEcho();
    this.pendingSelfCommandEchoPayload = payload;
    this.pendingSelfCommandEchoCount += 1;
    this.pendingSelfCommandEchoExpiresAt = Date.now() + 2000;
  }

  private retractExpectedSelfCommandEcho(payload: string): void {
    this.prunePendingSelfCommandEcho();
    if (this.pendingSelfCommandEchoPayload !== payload || this.pendingSelfCommandEchoCount <= 0) {
      return;
    }

    this.pendingSelfCommandEchoCount -= 1;
    if (this.pendingSelfCommandEchoCount <= 0) {
      this.pendingSelfCommandEchoCount = 0;
      this.pendingSelfCommandEchoPayload = undefined;
      this.pendingSelfCommandEchoExpiresAt = 0;
    }
  }

  private shouldIgnoreObservedExecuteAction(payload: string): boolean {
    this.prunePendingSelfCommandEcho();
    if (this.pendingSelfCommandEchoPayload !== payload || this.pendingSelfCommandEchoCount <= 0) {
      return false;
    }

    this.pendingSelfCommandEchoCount -= 1;
    if (this.pendingSelfCommandEchoCount <= 0) {
      this.pendingSelfCommandEchoCount = 0;
      this.pendingSelfCommandEchoPayload = undefined;
      this.pendingSelfCommandEchoExpiresAt = 0;
    }
    return true;
  }

  private prunePendingSelfCommandEcho(): void {
    if (this.pendingSelfCommandEchoCount === 0) {
      return;
    }
    if (Date.now() <= this.pendingSelfCommandEchoExpiresAt) {
      return;
    }

    this.pendingSelfCommandEchoCount = 0;
    this.pendingSelfCommandEchoPayload = undefined;
    this.pendingSelfCommandEchoExpiresAt = 0;
  }

  private resolveSensorBaseTopic(): string {
    const explicit = this.resolveSensorOverrideFromConfig();
    if (explicit) {
      this.platform.log.info(
        `[FrontGate ${this.accessory.displayName}] using explicit front-gate sensor topic override: ${explicit}`,
      );
      return explicit;
    }

    const candidates = this.findSensorCandidates();
    if (candidates.length === 0) {
      this.platform.log.warn(
        `[FrontGate ${this.accessory.displayName}] no dedicated gate sensor channel found; falling back to ${this.controlBaseTopic}/state/hi`,
      );
      return this.controlBaseTopic;
    }

    const winner = candidates[0];
    this.platform.log.info(
      `[FrontGate ${this.accessory.displayName}] resolved sensor channel ${winner.channel.channelCaption} `
      + `(${winner.channel.deviceId}/${winner.channel.channelId}) -> ${winner.baseTopic} `
      + `[${winner.reasons.join(', ')}]`,
    );
    return winner.baseTopic;
  }

  private resolveSensorOverrideFromConfig(): string | undefined {
    const config = this.platform.config as unknown as FrontGateConfigView;

    if (typeof config.frontGateSensorTopic === 'string' && config.frontGateSensorTopic.trim()) {
      return this.platform.normalizeTopicBase(config.frontGateSensorTopic);
    }

    const requestedDeviceId = this.normalizeOptionalId(config.frontGateSensorDeviceId);
    const requestedChannelId = this.normalizeOptionalId(config.frontGateSensorChannelId);
    if (!requestedDeviceId && !requestedChannelId) {
      return undefined;
    }

    const channel = this.collectKnownChannels().find(candidate => {
      if (requestedDeviceId && candidate.deviceId !== requestedDeviceId) {
        return false;
      }
      if (requestedChannelId && candidate.channelId !== requestedChannelId) {
        return false;
      }
      return true;
    });

    if (!channel) {
      this.platform.log.warn(
        `[FrontGate ${this.accessory.displayName}] configured frontGateSensorDeviceId/frontGateSensorChannelId did not match any known channel`,
      );
      return undefined;
    }

    return this.platform.normalizeTopicBase(channel.topic);
  }

  private findSensorCandidates(): SensorCandidate[] {
    const channels = this.collectKnownChannels();
    const candidates: SensorCandidate[] = [];

    for (const channel of channels) {
      if (channel.channelId === this.context.channelId && channel.deviceId === this.context.deviceId) {
        continue;
      }

      const score = this.scoreSensorCandidate(channel);
      if (score.score <= 0) {
        continue;
      }

      candidates.push({
        channel,
        baseTopic: this.platform.normalizeTopicBase(channel.topic),
        score: score.score,
        reasons: score.reasons,
      });
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates;
  }

  private scoreSensorCandidate(channel: SuplaChannelContext): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    const functionName = (channel.channelFunction || '').toUpperCase();
    const typeName = (channel.channelType || '').toUpperCase();

    const isGateSensorFunction = functionName === 'OPENINGSENSOR_GATE' || functionName === 'OPENINGSENSOR_GATEWAY';
    const isGenericOpeningSensor = functionName.startsWith('OPENINGSENSOR_');
    const isBinarySensor = typeName === 'BINARYSENSOR';
    const sameDevice = Boolean(channel.deviceId && channel.deviceId === this.context.deviceId);
    const captionScore = this.computeCaptionSimilarity(
      this.context.channelCaption || this.accessory.displayName,
      channel.channelCaption || '',
    );

    if (isGateSensorFunction) {
      score += 100;
      reasons.push('gate-sensor-function');
    } else if (isGenericOpeningSensor) {
      score += 70;
      reasons.push('opening-sensor-function');
    } else if (isBinarySensor) {
      if (!sameDevice && captionScore === 0) {
        return { score: 0, reasons: [] };
      }
      score += 20;
      reasons.push('binary-sensor');
    } else {
      return { score: 0, reasons: [] };
    }

    if (sameDevice) {
      score += 50;
      reasons.push('same-device');
    }

    if (captionScore > 0) {
      score += captionScore;
      reasons.push(`caption+${captionScore}`);
    }

    const controlBase = this.platform.normalizeTopicBase(this.context.topic);
    const candidateBase = this.platform.normalizeTopicBase(channel.topic);
    if (controlBase && candidateBase && controlBase !== candidateBase) {
      const controlPrefix = controlBase.replace(/\/channels\/[^/]+$/, '');
      const candidatePrefix = candidateBase.replace(/\/channels\/[^/]+$/, '');
      if (controlPrefix === candidatePrefix) {
        score += 15;
        reasons.push('same-device-topic-prefix');
      }
    }

    return { score, reasons };
  }

  private computeCaptionSimilarity(left: string, right: string): number {
    const leftTokens = this.tokenizeCaption(left);
    const rightTokens = this.tokenizeCaption(right);

    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return 0;
    }

    const rightSet = new Set(rightTokens);
    let overlap = 0;
    for (const token of leftTokens) {
      if (rightSet.has(token)) {
        overlap += 1;
      }
    }

    if (overlap === 0) {
      return 0;
    }

    return Math.min(40, overlap * 10);
  }

  private tokenizeCaption(value: string): string[] {
    return value
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .filter(token => !new Set([
        'gate',
        'sensor',
        'contact',
        'opening',
        'open',
        'close',
        'controller',
      ]).has(token));
  }

  private normalizeOptionalId(value: string | number | undefined): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const normalized = String(value).trim();
    return normalized || undefined;
  }

  private collectKnownChannels(): SuplaChannelContext[] {
    const byKey = new Map<string, SuplaChannelContext>();
    const push = (candidate: unknown) => {
      if (!candidate || typeof candidate !== 'object') {
        return;
      }

      const channel = candidate as Partial<SuplaChannelContext>;
      if (typeof channel.topic !== 'string') {
        return;
      }

      const key = [
        channel.deviceId ?? '',
        channel.channelId ?? '',
        this.platform.normalizeTopicBase(channel.topic),
      ].join('|');

      byKey.set(key, channel as SuplaChannelContext);
    };

    for (const knownAccessory of this.platform.accessories) {
      push(knownAccessory.context.device);
    }

    const config = this.platform.config as unknown as FrontGateConfigView;
    const rawChannels = config.channels;
    if (Array.isArray(rawChannels)) {
      for (const channel of rawChannels) {
        push(channel);
      }
    } else if (typeof rawChannels === 'string' && rawChannels.trim()) {
      try {
        const parsed = JSON.parse(rawChannels);
        if (Array.isArray(parsed)) {
          for (const channel of parsed) {
            push(channel);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.platform.log.warn(`[FrontGate ${this.accessory.displayName}] failed to parse cached channels: ${message}`);
      }
    }

    return Array.from(byKey.values());
  }
}
