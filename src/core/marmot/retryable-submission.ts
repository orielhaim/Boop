export type RetryableSubmission<T> = {
  key: string;
  value: T;
};

export function retryableSubmission<T>(
  current: RetryableSubmission<T> | undefined,
  key: string,
  create: () => T,
): RetryableSubmission<T> {
  return current?.key === key ? current : { key, value: create() };
}
