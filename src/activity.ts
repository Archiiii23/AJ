import { getDb } from "./db";
import { activity } from "./schema";
import { prefixedId } from "./ids";

export interface ActivityInput {
  workspaceId: string;
  projectId?: string | null;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  targetLabel: string;
  meta?: Record<string, unknown>;
}

export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    await getDb()
      .insert(activity)
      .values({
        id: prefixedId("act"),
        workspaceId: input.workspaceId,
        projectId: input.projectId ?? null,
        actorId: input.actorId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        targetLabel: input.targetLabel,
        meta: input.meta ? JSON.stringify(input.meta) : null,
      });
  } catch (err) {
    console.error("Failed to log activity", err);
  }
}
