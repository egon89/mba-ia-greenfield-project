import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';

// QueryFailedError copies the pg driver error's props (`code`, `detail`)
// onto itself; they are typed as `unknown` and narrowed at runtime.
export function isPgUniqueViolationOnColumn(
  err: unknown,
  column: string,
): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & {
    code?: unknown;
    detail?: unknown;
  };
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
