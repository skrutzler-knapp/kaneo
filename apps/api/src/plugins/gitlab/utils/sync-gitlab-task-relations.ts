import { eq, inArray, or } from "drizzle-orm";
import db from "../../../database";
import {
  externalLinkTable,
  integrationTable,
  taskRelationTable,
} from "../../../database/schema";
import { publishEvent } from "../../../events";
import { getExternalLinksByIntegration } from "../../github/services/link-manager";
import type { GitlabConfig } from "../config";
import type { GitlabIssueLink } from "./gitlab-api";
import { createGitlabClient } from "./gitlab-api";

export type GitlabTaskRelationType = "subtask" | "related" | "blocks";

export type GitlabTaskRelationSnapshot = {
  sourceIid: number;
  targetIid: number;
  relationType: GitlabTaskRelationType;
};

type ExternalIssueLink = Awaited<
  ReturnType<typeof getExternalLinksByIntegration>
>[number];

type ExistingTaskRelation = typeof taskRelationTable.$inferSelect;

const relationTypes = new Set<GitlabTaskRelationType>([
  "subtask",
  "related",
  "blocks",
]);

function parseMetadata(raw: string | null | undefined) {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function normalizeSnapshot(value: unknown): GitlabTaskRelationSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(candidate.sourceIid) ||
    !Number.isSafeInteger(candidate.targetIid) ||
    candidate.sourceIid === candidate.targetIid ||
    typeof candidate.relationType !== "string" ||
    !relationTypes.has(candidate.relationType as GitlabTaskRelationType)
  ) {
    return null;
  }
  return canonicalizeRelation({
    sourceIid: candidate.sourceIid as number,
    targetIid: candidate.targetIid as number,
    relationType: candidate.relationType as GitlabTaskRelationType,
  });
}

function canonicalizeRelation(
  relation: GitlabTaskRelationSnapshot,
): GitlabTaskRelationSnapshot {
  if (
    relation.relationType === "related" &&
    relation.sourceIid > relation.targetIid
  ) {
    return {
      ...relation,
      sourceIid: relation.targetIid,
      targetIid: relation.sourceIid,
    };
  }
  return relation;
}

function relationKey(relation: GitlabTaskRelationSnapshot) {
  return `${relation.relationType}:${relation.sourceIid}:${relation.targetIid}`;
}

function snapshotFromMetadata(raw: string | null | undefined) {
  const value = parseMetadata(raw).gitlabTaskRelations;
  if (!Array.isArray(value)) return [];
  const relations = new Map<string, GitlabTaskRelationSnapshot>();
  for (const item of value) {
    const relation = normalizeSnapshot(item);
    if (relation) relations.set(relationKey(relation), relation);
  }
  return [...relations.values()];
}

function issueRelation(
  issueIid: number,
  link: GitlabIssueLink,
  knownSubtasks: Map<string, GitlabTaskRelationSnapshot>,
): GitlabTaskRelationSnapshot | null {
  if (!Number.isSafeInteger(link.iid) || link.iid === issueIid) return null;

  if (link.link_type === "relates_to") {
    const pair = canonicalizeRelation({
      sourceIid: issueIid,
      targetIid: link.iid,
      relationType: "related",
    });
    const existingSubtask = knownSubtasks.get(
      `${Math.min(issueIid, link.iid)}:${Math.max(issueIid, link.iid)}`,
    );
    return existingSubtask ?? pair;
  }

  if (link.link_type === "blocks") {
    return {
      sourceIid: issueIid,
      targetIid: link.iid,
      relationType: "blocks",
    };
  }

  if (link.link_type === "is_blocked_by") {
    return {
      sourceIid: link.iid,
      targetIid: issueIid,
      relationType: "blocks",
    };
  }

  return null;
}

function issueLinkToTaskRelation(
  relation: GitlabTaskRelationSnapshot,
  taskIdByIid: Map<number, string>,
) {
  const sourceTaskId = taskIdByIid.get(relation.sourceIid);
  const targetTaskId = taskIdByIid.get(relation.targetIid);
  if (!sourceTaskId || !targetTaskId || sourceTaskId === targetTaskId) {
    return null;
  }
  return {
    sourceTaskId,
    targetTaskId,
    relationType: relation.relationType,
  };
}

function matchesRelation(
  relation: ExistingTaskRelation,
  candidate: ReturnType<typeof issueLinkToTaskRelation> & {},
) {
  if (relation.relationType !== candidate.relationType) return false;
  if (candidate.relationType === "related") {
    return (
      (relation.sourceTaskId === candidate.sourceTaskId &&
        relation.targetTaskId === candidate.targetTaskId) ||
      (relation.sourceTaskId === candidate.targetTaskId &&
        relation.targetTaskId === candidate.sourceTaskId)
    );
  }
  return (
    relation.sourceTaskId === candidate.sourceTaskId &&
    relation.targetTaskId === candidate.targetTaskId
  );
}

async function loadExternalIssueLinks(integrationId: string) {
  const links = await getExternalLinksByIntegration(integrationId);
  return links.filter((link) => link.resourceType === "issue");
}

async function updateSnapshots(
  links: ExternalIssueLink[],
  affectedIids: Set<number>,
  desired: Map<string, GitlabTaskRelationSnapshot>,
  mode: "replace" | "add" | "remove" = "replace",
) {
  const affectedLinks = links.filter((link) => {
    const issueIid = Number(link.externalId);
    return Number.isSafeInteger(issueIid) && affectedIids.has(issueIid);
  });
  const relatedIids = new Set(affectedIids);
  for (const relation of desired.values()) {
    if (affectedIids.has(relation.sourceIid))
      relatedIids.add(relation.targetIid);
    if (affectedIids.has(relation.targetIid))
      relatedIids.add(relation.sourceIid);
  }
  for (const link of links) {
    for (const relation of snapshotFromMetadata(link.metadata)) {
      if (affectedIids.has(relation.sourceIid)) {
        relatedIids.add(relation.targetIid);
      }
      if (affectedIids.has(relation.targetIid)) {
        relatedIids.add(relation.sourceIid);
      }
    }
  }
  for (const link of links) {
    const issueIid = Number(link.externalId);
    if (
      Number.isSafeInteger(issueIid) &&
      relatedIids.has(issueIid) &&
      !affectedLinks.some((affectedLink) => affectedLink.id === link.id)
    ) {
      affectedLinks.push(link);
    }
  }

  const relationList = [...desired.values()];
  await Promise.all(
    affectedLinks.map(async (link) => {
      const issueIid = Number(link.externalId);
      await db.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ metadata: externalLinkTable.metadata })
          .from(externalLinkTable)
          .where(eq(externalLinkTable.id, link.id))
          .for("update");
        if (!row) return;

        const metadata = parseMetadata(row.metadata);
        const current = snapshotFromMetadata(row.metadata);
        const next = new Map(
          current
            .filter((relation) => {
              if (mode === "replace") {
                return (
                  !affectedIids.has(relation.sourceIid) &&
                  !affectedIids.has(relation.targetIid)
                );
              }
              return mode !== "remove" || !desired.has(relationKey(relation));
            })
            .map((relation) => [relationKey(relation), relation]),
        );
        for (const relation of mode === "remove" ? [] : relationList) {
          if (
            relation.sourceIid === issueIid ||
            relation.targetIid === issueIid
          ) {
            next.set(relationKey(relation), relation);
          }
        }
        const sorted = [...next.values()].sort((left, right) =>
          relationKey(left).localeCompare(relationKey(right)),
        );
        if (JSON.stringify(current) === JSON.stringify(sorted)) return;

        await transaction
          .update(externalLinkTable)
          .set({
            metadata: JSON.stringify({
              ...metadata,
              gitlabTaskRelations: sorted,
            }),
          })
          .where(eq(externalLinkTable.id, link.id));
      });
    }),
  );
}

export async function recordGitlabTaskRelation(
  integrationId: string,
  relation: GitlabTaskRelationSnapshot,
  present: boolean,
): Promise<void> {
  const normalized = canonicalizeRelation(relation);
  const links = await loadExternalIssueLinks(integrationId);
  const desired = new Map<string, GitlabTaskRelationSnapshot>();
  desired.set(relationKey(normalized), normalized);
  await updateSnapshots(
    links,
    new Set([normalized.sourceIid, normalized.targetIid]),
    desired,
    present ? "add" : "remove",
  );
}

export async function syncGitlabRelationsForIssues(
  projectId: string,
  integrationId: string,
  projectPath: string,
  issueIids: number[],
  client = createGitlabClient,
) {
  const links = await loadExternalIssueLinks(integrationId);
  const taskIdByIid = new Map<number, string>();
  for (const link of links) {
    const issueIid = Number(link.externalId);
    if (Number.isSafeInteger(issueIid)) taskIdByIid.set(issueIid, link.taskId);
  }
  const affectedIids = new Set(
    issueIids.filter((issueIid) => taskIdByIid.has(issueIid)),
  );
  if (affectedIids.size === 0) return { created: 0, deleted: 0 };

  const config = await db.query.integrationTable.findFirst({
    where: eq(integrationTable.id, integrationId),
  });
  if (!config) return { created: 0, deleted: 0 };
  const gitlabClient = client(
    JSON.parse(config.config) as Pick<
      GitlabConfig,
      "baseUrl" | "accessToken" | "tokenType"
    >,
  );
  const projectInfo = await gitlabClient.getProject(projectPath);
  const selectedIssueIids = [...affectedIids];
  const [hierarchyRelations, issueLinksByIid] = await Promise.all([
    gitlabClient.listSubtaskRelations(projectPath, selectedIssueIids),
    Promise.all(
      selectedIssueIids.map(async (issueIid) => ({
        issueIid,
        links: await gitlabClient.listIssueLinks(projectPath, issueIid),
      })),
    ),
  ]);

  const oldRelations = new Map<string, GitlabTaskRelationSnapshot>();
  for (const link of links) {
    for (const relation of snapshotFromMetadata(link.metadata)) {
      if (
        affectedIids.has(relation.sourceIid) ||
        affectedIids.has(relation.targetIid)
      ) {
        oldRelations.set(relationKey(relation), relation);
      }
    }
  }

  const taskIds = [...new Set(taskIdByIid.values())];
  const existingRelations =
    taskIds.length === 0
      ? []
      : await db.query.taskRelationTable.findMany({
          where: or(
            inArray(taskRelationTable.sourceTaskId, taskIds),
            inArray(taskRelationTable.targetTaskId, taskIds),
          ),
        });
  const issueIidByTaskId = new Map(
    [...taskIdByIid].map(([issueIid, taskId]) => [taskId, issueIid]),
  );
  const knownSubtasks = new Map<string, GitlabTaskRelationSnapshot>();
  for (const relation of oldRelations.values()) {
    if (relation.relationType === "subtask") {
      knownSubtasks.set(
        `${Math.min(relation.sourceIid, relation.targetIid)}:${Math.max(relation.sourceIid, relation.targetIid)}`,
        relation,
      );
    }
  }
  for (const relation of existingRelations) {
    if (relation.relationType !== "subtask") continue;
    const sourceIid = issueIidByTaskId.get(relation.sourceTaskId);
    const targetIid = issueIidByTaskId.get(relation.targetTaskId);
    if (sourceIid === undefined || targetIid === undefined) continue;
    knownSubtasks.set(
      `${Math.min(sourceIid, targetIid)}:${Math.max(sourceIid, targetIid)}`,
      {
        sourceIid,
        targetIid,
        relationType: "subtask",
      },
    );
  }

  const desiredRelations = new Map<string, GitlabTaskRelationSnapshot>();
  for (const relation of hierarchyRelations) {
    const normalized = canonicalizeRelation({
      sourceIid: relation.parentIid,
      targetIid: relation.childIid,
      relationType: "subtask",
    });
    desiredRelations.set(relationKey(normalized), normalized);
  }
  for (const { issueIid, links: issueLinks } of issueLinksByIid) {
    for (const link of issueLinks) {
      if (link.project_id !== projectInfo.id) continue;
      const relation = issueRelation(issueIid, link, knownSubtasks);
      if (relation) desiredRelations.set(relationKey(relation), relation);
    }
  }

  let created = 0;
  let deleted = 0;
  for (const relation of desiredRelations.values()) {
    const candidate = issueLinkToTaskRelation(relation, taskIdByIid);
    if (!candidate) continue;
    const exists = existingRelations.some((item) =>
      matchesRelation(item, candidate),
    );
    if (exists) continue;

    const [inserted] = await db
      .insert(taskRelationTable)
      .values(candidate)
      .returning();
    if (!inserted) continue;
    existingRelations.push(inserted);
    created++;
    await publishEvent("task-relation.created", {
      ...inserted,
      projectId,
      taskId: inserted.sourceTaskId,
      userId: "",
      source: "gitlab",
    });
  }

  for (const [key, relation] of oldRelations) {
    if (desiredRelations.has(key)) continue;
    const candidate = issueLinkToTaskRelation(relation, taskIdByIid);
    if (!candidate) continue;
    const existing = existingRelations.find((item) =>
      matchesRelation(item, candidate),
    );
    if (!existing) continue;
    const [removed] = await db
      .delete(taskRelationTable)
      .where(eq(taskRelationTable.id, existing.id))
      .returning();
    if (!removed) continue;
    deleted++;
    await publishEvent("task-relation.deleted", {
      ...removed,
      projectId,
      taskId: removed.sourceTaskId,
      userId: "",
      source: "gitlab",
    });
  }

  await updateSnapshots(links, affectedIids, desiredRelations);
  return { created, deleted };
}
