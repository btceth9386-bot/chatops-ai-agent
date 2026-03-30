import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { ErrorLogEntry } from '../types';

type CloudWatchClientLike = Pick<CloudWatchLogsClient, 'send'>;

export class CloudWatchLogger {
  private readonly client: CloudWatchClientLike;
  private cloudwatchUnavailable = false;
  private streamEnsured = false;

  constructor(
    private readonly logGroupName = process.env.CLOUDWATCH_LOG_GROUP ?? '/chatops-ai-agent',
    private readonly logStreamName = process.env.CLOUDWATCH_LOG_STREAM ?? 'slack-bot',
    client?: CloudWatchClientLike
  ) {
    this.client = client ?? new CloudWatchLogsClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  async logError(message: string, error?: Error, requestContext?: Record<string, unknown>): Promise<void> {
    await this.send({
      timestamp: new Date().toISOString(),
      level: 'error',
      message,
      stackTrace: error?.stack,
      requestContext,
    });
  }

  async logWarn(message: string, requestContext?: Record<string, unknown>): Promise<void> {
    await this.send({
      timestamp: new Date().toISOString(),
      level: 'warn',
      message,
      requestContext,
    });
  }

  async logInfo(message: string, requestContext?: Record<string, unknown>): Promise<void> {
    await this.send({
      timestamp: new Date().toISOString(),
      level: 'info',
      message,
      requestContext,
    });
  }

  private async ensureStream(): Promise<void> {
    if (this.streamEnsured) return;
    try {
      await this.client.send(
        new CreateLogStreamCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
        })
      );
    } catch (error: any) {
      // ResourceAlreadyExistsException is fine — stream already exists
      if (error.name !== 'ResourceAlreadyExistsException') throw error;
    }
    this.streamEnsured = true;
  }

  private async send(entry: ErrorLogEntry): Promise<void> {
    if (this.cloudwatchUnavailable) {
      console.error(`[CloudWatchLogger] ${entry.level}: ${entry.message}`);
      return;
    }

    const event: InputLogEvent = {
      timestamp: Date.now(),
      message: JSON.stringify(entry),
    };

    try {
      await this.ensureStream();
      await this.client.send(
        new PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          logEvents: [event],
        })
      );
    } catch (error) {
      this.cloudwatchUnavailable = true;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[CloudWatchLogger] CloudWatch unavailable (${msg}), falling back to stderr for future logs`);
      console.error(`[CloudWatchLogger] ${entry.level}: ${entry.message}`);
    }
  }
}
