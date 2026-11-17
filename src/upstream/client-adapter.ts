/**
 * The only backend module that imports the original, hash-pinned client.
 * Export names are recovered from the original bundles. Never format or patch
 * the originals to make TypeScript happy.
 */
import {
  a as validate,
  r as sanitize,
} from '../../private-client/validation/specValidation-vqop-JBL.js';
import { a as dailyNumber } from '../../private-client/assets/date-D4dx3Sc1.js';
import { n as serverReference } from '../../private-client/assets/createServerFn-BfnFvdmx.js';
import { isRecord, type CourseSpecification } from '../domain.js';

// Required by the original public server-function serializer in a Bun process.
if (Reflect.get(globalThis, 'window') == null) {
  Reflect.set(globalThis, 'window', { __TSS_START_OPTIONS__: { serializationAdapters: [] } });
}

export function validateCourse(specification: unknown, title: string): CourseSpecification {
  if (!isRecord(specification)) {
    throw new Error('Missing public map specification');
  }

  const sanitized = sanitize(structuredClone({ ...specification, name: title }));
  validate(sanitized);
  if (!isRecord(sanitized) || typeof sanitized.par !== 'number') {
    throw new Error('Invalid validated course specification');
  }
  if (sanitized.name !== undefined && typeof sanitized.name !== 'string') {
    throw new Error('Invalid course name');
  }

  return { ...sanitized, par: sanitized.par, name: sanitized.name };
}

export function currentDailyNumber(date: Date = new Date()): number {
  return dailyNumber(date);
}

export async function invokePublicFunction(
  identifier: string,
  method: 'GET' | 'POST',
  data: unknown,
  transport: (relative: string, options: RequestInit) => Promise<Response>,
): Promise<unknown> {
  const envelope = await serverReference(identifier)({ data, method, fetch: transport });
  if (!isRecord(envelope)) {
    throw new Error('Unexpected public server response');
  }
  if (envelope.error) {
    throw new Error(String(envelope.error));
  }
  return envelope.result;
}
