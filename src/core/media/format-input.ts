export type MediaFormatInput = {
  size: number;
  read(offset: number, length: number): Uint8Array;
};

export function formatInput(
  input: Uint8Array | MediaFormatInput,
): MediaFormatInput {
  return input instanceof Uint8Array
    ? {
        size: input.length,
        read: (offset, length) => input.subarray(offset, offset + length),
      }
    : input;
}
