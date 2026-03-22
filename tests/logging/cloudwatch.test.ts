import { describe, expect, it, vi } from 'vitest';
import { CloudWatchLogger } from '../../src/logging/cloudwatch';

describe('CloudWatchLogger', () => {
  it('sends log events with correct payload', async () => {
    const send = vi.fn().mockResolvedValue({});
    const logger = new CloudWatchLogger('/group', 'stream', { send } as any);

    await logger.logError('boom', new Error('x'), { requestId: 'r1' });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0];
    expect(command.input.logGroupName).toBe('/group');
    expect(command.input.logStreamName).toBe('stream');
    expect(command.input.logEvents).toHaveLength(1);

    const msg = JSON.parse(command.input.logEvents[0].message);
    expect(msg.level).toBe('error');
    expect(msg.message).toBe('boom');
    expect(msg.requestContext.requestId).toBe('r1');
  });

  it('does not throw when cloudwatch send fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('cw down'));
    const logger = new CloudWatchLogger('/group', 'stream', { send } as any);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(logger.logInfo('hello')).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});
