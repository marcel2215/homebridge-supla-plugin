export class SuplaChannelContext {
  constructor(
    public topic: string,
    public channelType: string,
    public channelFunction: string,
    public channelCaption: string,
    public deviceId: string,
    public channelId: string,
    public rawTopic?: string,
  ) {
  }
}
