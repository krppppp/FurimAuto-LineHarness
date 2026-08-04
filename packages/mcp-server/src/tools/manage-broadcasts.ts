import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../client.js";

export function registerManageBroadcasts(server: McpServer): void {
  server.tool(
    "manage_broadcasts",
    "配信の管理操作。list: 一覧、get: 詳細、create_draft: 下書き作成（送信しない）、update: 更新、send: 送信、send_to_segment: セグメント配信。",
    {
      action: z
        .enum(["list", "get", "create_draft", "update", "send", "send_to_segment"])
        .describe("Action to perform"),
      broadcastId: z.string().optional().describe("Broadcast ID (required for get, update, send, send_to_segment)"),
      title: z.string().optional().describe("Broadcast title (for create_draft, update)"),
      messageType: z.enum(["text", "image", "flex"]).optional().describe("Message type (for create_draft, update)"),
      messageContent: z.string().optional().describe("Message content (for create_draft, update)"),
      messages: z
        .string()
        .optional()
        .describe(
          'Multi-message broadcast: JSON array of up to 5 message objects [{type:"text"|"image"|"flex", content:"...", altText?:"..."}] sent in one push (for create_draft, update). When set, messageType/messageContent default to the first item. Pass null (JSON) on update to clear.',
        ),
      targetType: z.enum(["all", "tag"]).optional().describe("Target type (for create_draft, update)"),
      targetTagId: z.string().nullable().optional().describe("Target tag ID (for create_draft, update)"),
      scheduledAt: z.string().nullable().optional().describe("ISO 8601 datetime to schedule (for create_draft, update)"),
      segmentConditions: z.string().optional().describe("JSON string of segment conditions: {operator: 'AND'|'OR', rules: [{type, value}]} (for send_to_segment)"),
      accountId: z.string().optional().describe("LINE account ID (uses default if omitted)"),
    },
    async ({ action, broadcastId, title, messageType, messageContent, messages, targetType, targetTagId, scheduledAt, segmentConditions, accountId }) => {
      try {
        const client = getClient();

        // messages (JSON 文字列) をパース。null は明示クリア、配列は複数メッセージ配信。
        let parsedMessages: Array<{ type: string; content: string; altText?: string }> | null | undefined;
        if (messages !== undefined) {
          const j = JSON.parse(messages);
          if (j === null) {
            parsedMessages = null;
          } else if (Array.isArray(j) && j.length >= 1 && j.length <= 5) {
            parsedMessages = j;
          } else {
            throw new Error("messages must be a JSON array of 1 to 5 objects, or null to clear");
          }
        }

        if (action === "list") {
          const broadcasts = await client.broadcasts.list(accountId ? { accountId } : undefined);
          const rows = broadcasts as unknown as Array<Record<string, unknown>>;
          const enriched = rows.map((b) => ({
            ...b,
            insightStatus: b.insight_status || null,
            openRate: b.open_rate != null
              ? `${(Number(b.open_rate) * 100).toFixed(1)}%`
              : null,
            clickRate: b.click_rate != null
              ? `${(Number(b.click_rate) * 100).toFixed(1)}%`
              : null,
          }));
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcasts: enriched }, null, 2) }] };
        }

        if (action === "create_draft") {
          // 複数メッセージ指定時は messageType/messageContent を1件目から補完する。
          const firstType = messageType ?? (parsedMessages && parsedMessages[0] ? (parsedMessages[0].type as "text" | "image" | "flex") : undefined);
          const firstContent = messageContent ?? (parsedMessages && parsedMessages[0] ? parsedMessages[0].content : undefined);
          if (!title || !firstType || !firstContent) {
            throw new Error("title, messageType, messageContent (or a non-empty messages array) are required for create_draft");
          }
          const input: Record<string, unknown> = { title, messageType: firstType, messageContent: firstContent, targetType: targetType ?? "all" };
          if (parsedMessages) input.messages = parsedMessages;
          if (targetTagId) input.targetTagId = targetTagId;
          if (scheduledAt) input.scheduledAt = scheduledAt;
          if (accountId) input.lineAccountId = accountId;
          const broadcast = await client.broadcasts.create(input as never);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcast }, null, 2) }] };
        }

        if (!broadcastId) throw new Error("broadcastId is required for this action");

        if (action === "get") {
          const broadcast = await client.broadcasts.get(broadcastId);
          const row = broadcast as unknown as Record<string, unknown>;
          const insight = row.insight_status
            ? {
                status: row.insight_status,
                delivered: row.delivered ?? null,
                uniqueImpression: row.unique_impression ?? null,
                uniqueClick: row.unique_click ?? null,
                uniqueMediaPlayed: row.unique_media_played ?? null,
                openRate: row.open_rate != null
                  ? `${(Number(row.open_rate) * 100).toFixed(1)}%`
                  : null,
                clickRate: row.click_rate != null
                  ? `${(Number(row.click_rate) * 100).toFixed(1)}%`
                  : null,
                fetchedAt: row.insight_fetched_at ?? null,
              }
            : null;
          const enriched = {
            ...broadcast,
            insight: insight || {
              status: 'none',
              note: 'Insightデータは次回配信から自動取得されます',
            },
          };
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcast: enriched }, null, 2) }] };
        }

        if (action === "update") {
          const input: Record<string, unknown> = {};
          if (title !== undefined) input.title = title;
          if (messageType !== undefined) input.messageType = messageType;
          if (messageContent !== undefined) input.messageContent = messageContent;
          if (parsedMessages !== undefined) input.messages = parsedMessages;
          if (targetType !== undefined) input.targetType = targetType;
          if (targetTagId !== undefined) input.targetTagId = targetTagId;
          if (scheduledAt !== undefined) input.scheduledAt = scheduledAt;
          const broadcast = await client.broadcasts.update(broadcastId, input);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcast }, null, 2) }] };
        }

        if (action === "send") {
          const broadcast = await client.broadcasts.send(broadcastId);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcast }, null, 2) }] };
        }

        if (action === "send_to_segment") {
          if (!segmentConditions) throw new Error("segmentConditions (JSON string) is required for send_to_segment");
          const conditions = JSON.parse(segmentConditions);
          const broadcast = await client.broadcasts.sendToSegment(broadcastId, conditions);
          return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, broadcast }, null, 2) }] };
        }

        throw new Error(`Unknown action: ${action}`);
      } catch (err) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: String(err) }) }], isError: true };
      }
    },
  );
}
