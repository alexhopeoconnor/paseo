export interface CappedAssistantMessage {
  text: string;
  capped: boolean;
}

export interface MessageCharacterCounts {
  shown: number;
  received: number;
}

// Count source-text code points, while the rendered prefix is indexed in UTF-16 units.
export function countMessageCharacters(
  message: string,
  shownCodeUnits: number,
): MessageCharacterCounts {
  let shown = 0;
  let received = 0;
  let offset = 0;

  for (const character of message) {
    offset += character.length;
    received += 1;
    if (offset <= shownCodeUnits) shown += 1;
  }

  return { shown, received };
}

export function getUtf8ByteLength(message: string): number {
  let bytes = 0;

  for (let index = 0; index < message.length; index += 1) {
    const codeUnit = message.charCodeAt(index);
    if (codeUnit < 0x80) {
      bytes += 1;
    } else if (codeUnit < 0x800) {
      bytes += 2;
    } else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < message.length &&
      message.charCodeAt(index + 1) >= 0xdc00 &&
      message.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }

  return bytes;
}
