export function isIncomingMediaIntentUri(uri: string) {
  return (
    uri.length <= 4096 &&
    /^content:\/\/[^/?#]+\/.+/iu.test(uri) &&
    !/^content:\/\/com\.orielhaim\.boop(?:[./]|$)/iu.test(uri)
  );
}
