type ObjectType = "review" | "template" | "project" | "api_key" | "webhook" | "audit_event" | "feedback" | "reviewer" | "version" | "webhook_delivery" | "review_token" | "chain_run" | "chain_step";

export function envelope<T extends object>(objectType: ObjectType, data: T): T & { object: ObjectType } {
  return { ...data, object: objectType };
}

export function listEnvelope<T extends object>(
  objectType: ObjectType,
  items: T[],
  pagination: { has_more: boolean; total?: number },
) {
  const wrapped = items.map((item) => envelope(objectType, item));
  const result: Record<string, unknown> = {
    object: "list" as const,
    items: wrapped,
    has_more: pagination.has_more,
  };
  if (pagination.total !== undefined) {
    result.total = pagination.total;
  }
  return result;
}
