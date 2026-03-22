import {
  CloudWatchLogsClient,
  PutLogEventsCommand,
  InputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { ErrorLogEntry } from '../types';

type CloudWatchClientLike = Pick<CloudWatchLogsClient, 'send'>;

export class CloudWatchLogger {
  private readonly client: CloudWatchClientLike;

  constructor(
    private readonly logGroupName = process.env.CLOUDWATCH_LOG_GROUP ?? '/chatops-ai-agent',
    private readonly logStreamName = process.env.CLOUDWATCH_LOG_STREAM ?? 'slack-bot',
    client?: CloudWatchClientLike
  ) {
    this.client = client ?? new CloudWatchLogsClient({});
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

  private async send(entry: ErrorLogEntry): Promise<void> {
    const event: InputLogEvent = {
      timestamp: Date.now(),
      message: JSON.stringify(entry),
    };

    try {
      await this.client.send(
        new PutLogEventsCommand({
          logGroupName: this.logGroupName,
          logStreamName: this.logStreamName,
          logEvents: [event],
        })
      );
    } catch (error) {
      console.error('[CloudWatchLogger] failed to send log event, fallback to stderr', {
        entry,
        error,
      });
    }
  }
}
