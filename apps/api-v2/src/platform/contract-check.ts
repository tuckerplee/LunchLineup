import { FormatRegistry, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

if (!FormatRegistry.Has('uuid')) {
  FormatRegistry.Set('uuid', (value) => (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ));
}

if (!FormatRegistry.Has('date-time')) {
  FormatRegistry.Set('date-time', (value) => (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
    && Number.isFinite(new Date(value).getTime())
  ));
}

export function matchesContract<T extends TSchema>(
  schema: T,
  value: unknown,
): value is Static<T> {
  return Value.Check(schema, value);
}
