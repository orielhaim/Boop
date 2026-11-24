export function marmotErrorCode(error: unknown) {
  if (
    typeof error === "object" &&
    error &&
    "code" in error &&
    typeof error.code === "string"
  )
    return error.code;
  return "NativeFailure";
}
