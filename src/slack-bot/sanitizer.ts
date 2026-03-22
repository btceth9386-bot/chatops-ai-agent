import { SanitizedInput } from '../types';

const CONTROL_CHAR_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const DEFAULT_MAX_LENGTH = 10000;

export function sanitizeInput(input: string, maxLength = DEFAULT_MAX_LENGTH): SanitizedInput {
  const noControlChars = input.replace(CONTROL_CHAR_REGEX, '');
  const originalLength = noControlChars.length;

  if (originalLength <= maxLength) {
    return {
      text: noControlChars,
      wasTruncated: false,
      originalLength,
    };
  }

  const notice = '\n\n[Message truncated to 10000 characters]';
  const allowed = Math.max(0, maxLength - notice.length);
  const truncated = `${noControlChars.slice(0, allowed)}${notice}`;

  return {
    text: truncated,
    wasTruncated: true,
    originalLength,
  };
}
