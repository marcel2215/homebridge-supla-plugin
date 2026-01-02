export class SuplaMqttClientContext {
  constructor(
    public host: string,
    public port: number,
    public username: string,
    public password: string,
    public protocol?: string,
    public tls?: boolean | string,
  ) {
  }
}
