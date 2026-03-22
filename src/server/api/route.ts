import { NextResponse } from "next/server";
import type { z } from "zod";
import { ZodError } from "zod";

import {
  AuthenticationError,
  AuthorizationError,
  ValidationError,
} from "@/server/organizations/context";

export async function handleRoute(
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    const status = getStatusCode(error);
    const message = error instanceof Error ? error.message : "Unexpected server error.";

    return NextResponse.json({ error: message }, { status });
  }
}

export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  const body = await request.json();
  return schema.parse(body);
}

export function parseLimit(value: string | null, fallback = 50): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    throw new ValidationError("limit must be a positive integer.");
  }

  return Math.min(parsed, 100);
}

export function parsePage(value: string | null, fallback = 1): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    throw new ValidationError("page must be a positive integer.");
  }

  return parsed;
}

export function parseBoolean(value: string | null, fallback?: boolean): boolean | undefined {
  if (value === null) {
    return fallback;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new ValidationError("boolean query parameters must be 'true' or 'false'.");
}

export function parseIsoDate(value: string | null, fieldName: string, fallback?: string): string {
  const candidate = value ?? fallback;

  if (!candidate) {
    throw new ValidationError(`${fieldName} is required.`);
  }

  const parsed = new Date(candidate);

  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError(`${fieldName} must be a valid ISO date.`);
  }

  return parsed.toISOString();
}

function getStatusCode(error: unknown): number {
  if (error instanceof AuthenticationError) {
    return 401;
  }

  if (error instanceof AuthorizationError) {
    return 403;
  }

  if (error instanceof ValidationError || error instanceof ZodError) {
    return 400;
  }

  return 500;
}