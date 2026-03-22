import type { Json } from "@/server/db/database.types";
import type {
  WorkflowCondition,
  WorkflowConditionResult,
  WorkflowEventContext,
} from "@/server/services/workflow-engine/types";

function getFieldValue(context: WorkflowEventContext, field: string): Json {
  return context.fields[field] ?? null;
}

function isTruthyValue(value: Json): boolean {
  if (value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.length > 0;
  }

  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return true;
}

function toNumber(value: Json): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeScalar(value: Json): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value as string | number | boolean | null;
  }

  return JSON.stringify(value);
}

function matchesCondition(condition: WorkflowCondition, actualValue: Json): boolean {
  switch (condition.operator) {
    case "equals":
      return normalizeScalar(actualValue) === normalizeScalar(condition.value ?? null);
    case "in":
      return Array.isArray(condition.value)
        ? condition.value.map(normalizeScalar).includes(normalizeScalar(actualValue))
        : false;
    case "greater_than": {
      const actualNumber = toNumber(actualValue);
      const expectedNumber = toNumber(condition.value ?? null);
      return actualNumber !== null && expectedNumber !== null && actualNumber > expectedNumber;
    }
    case "less_than": {
      const actualNumber = toNumber(actualValue);
      const expectedNumber = toNumber(condition.value ?? null);
      return actualNumber !== null && expectedNumber !== null && actualNumber < expectedNumber;
    }
    case "exists":
      return isTruthyValue(actualValue);
    case "changed_to":
      return normalizeScalar(actualValue) === normalizeScalar(condition.value ?? null);
  }
}

export function evaluateWorkflowConditions(
  conditions: WorkflowCondition[],
  context: WorkflowEventContext,
): { matched: boolean; results: WorkflowConditionResult[] } {
  const results = conditions.map((condition) => {
    const actualValue = getFieldValue(context, condition.field);

    return {
      actualValue,
      condition,
      matched: matchesCondition(condition, actualValue),
    } satisfies WorkflowConditionResult;
  });

  return {
    matched: results.every((result) => result.matched),
    results,
  };
}