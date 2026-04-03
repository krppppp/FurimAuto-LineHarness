import type {
  Friend,
  Tag,
  Scenario,
  ScenarioStep,
  ApiResponse,
  PaginatedResponse,
  User,
  LineAccount,
  ConversionPoint,
  Affiliate,
  Template,
  Automation,
  AutomationLog,
  AutomationActionItem,
  Chat,
  Reminder,
  ReminderStep,
  ScoringRule,
  IncomingWebhook,
  OutgoingWebhook,
  NotificationRule,
  Notification,
  AccountHealthLog,
  AccountMigration,
  StaffMember,
} from '@line-crm/shared'

import type { Broadcast } from '@line-crm/shared'

export interface ApiMessage {
  id: string
  messageType: 'text' | 'image' | 'flex' | 'video'
  content: string
  altText: string | null
  tags: string[]
  label: string | null
  createdAt: string
  updatedAt: string
}

export interface ApiTemplate {
  id: string
  name: string
  category: string
  categories: string[]
  messageType: string
  messageContent: string
  createdAt: string
  updatedAt: string
}

export interface ApiTemplateMessage {
  id: string
  templateId: string
  messageId: string
  stepOrder: number
  createdAt: string
  message: Omit<ApiMessage, 'createdAt' | 'updatedAt'>
}

/** Broadcast type from API (now camelCase after worker serialization) */
export type ApiBroadcast = Broadcast

const API_URL = process.env.NEXT_PUBLIC_API_URL
if (!API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Build cannot proceed without a valid API URL. ' +
    'Set it in .env.production (local) or GitHub Secrets (CI).'
  )
}

/**
 * Read the API key from localStorage (set during login).
 * Never embed secrets in the client bundle via NEXT_PUBLIC_* env vars.
 */
function getApiKey(): string {
  if (typeof window !== 'undefined') {
    return localStorage.getItem('lh_api_key') || ''
  }
  return ''
}

export interface EntryRouteItem {
  id: string
  refCode: string
  name: string
  tagId: string | null
  scenarioId: string | null
  redirectUrl: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export async function fetchApi<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getApiKey()}`,
      ...options?.headers,
    },
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
  return res.json() as Promise<T>
}

export type FriendListParams = {
  offset?: string
  limit?: string
  tagId?: string
  tagIds?: string
  accountId?: string
  search?: string
}

export type FriendWithTags = Friend & { tags: Tag[] }

export const api = {
  friends: {
    list: (params?: FriendListParams) => {
      const query: Record<string, string> = {}
      if (params?.offset) query.offset = params.offset
      if (params?.limit) query.limit = params.limit
      if (params?.tagId) query.tagId = params.tagId
      if (params?.tagIds) query.tagIds = params.tagIds
      if (params?.accountId) query.lineAccountId = params.accountId
      if (params?.search) query.search = params.search
      return fetchApi<ApiResponse<PaginatedResponse<FriendWithTags>>>(
        '/api/friends?' + new URLSearchParams(query)
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<FriendWithTags>>(`/api/friends/${id}`),
    count: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<{ count: number }>>('/api/friends/count' + query)
    },
    addTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags`, {
        method: 'POST',
        body: JSON.stringify({ tagId }),
      }),
    removeTag: (friendId: string, tagId: string) =>
      fetchApi<ApiResponse<null>>(`/api/friends/${friendId}/tags/${tagId}`, {
        method: 'DELETE',
      }),
  },
  tags: {
    list: () =>
      fetchApi<ApiResponse<Tag[]>>('/api/tags'),
    create: (data: { name: string; color: string }) =>
      fetchApi<ApiResponse<Tag>>('/api/tags', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/tags/${id}`, { method: 'DELETE' }),
  },
  scenarios: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<(Scenario & { stepCount?: number })[]>>('/api/scenarios' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Scenario & { steps: ScenarioStep[] }>>(`/api/scenarios/${id}`),
    create: (data: Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'> & { lineAccountId?: string }) =>
      fetchApi<ApiResponse<Scenario>>('/api/scenarios', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Omit<Scenario, 'id' | 'createdAt' | 'updatedAt'>>) =>
      fetchApi<ApiResponse<Scenario>>(`/api/scenarios/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: { stepOrder: number; delayMinutes?: number; templateId?: string | null; messageType?: string; messageContent?: string }) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateStep: (
      id: string,
      stepId: string,
      data: { stepOrder?: number; delayMinutes?: number; templateId?: string | null; messageType?: string; messageContent?: string }
    ) =>
      fetchApi<ApiResponse<ScenarioStep>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteStep: (id: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/scenarios/${id}/steps/${stepId}`, {
        method: 'DELETE',
      }),
  },
  broadcasts: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<ApiBroadcast[]>>('/api/broadcasts' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`),
    create: (data: {
      title: string
      messageType: ApiBroadcast['messageType']
      messageContent: string
      targetType: ApiBroadcast['targetType']
      targetTagId?: string | null
      scheduledAt?: string | null
      status?: ApiBroadcast['status']
    }) =>
      fetchApi<ApiResponse<ApiBroadcast>>('/api/broadcasts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        title?: string
        messageType?: ApiBroadcast['messageType']
        messageContent?: string
        targetType?: ApiBroadcast['targetType']
        targetTagId?: string | null
        scheduledAt?: string | null
      }
    ) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/broadcasts/${id}`, { method: 'DELETE' }),
    send: (id: string) =>
      fetchApi<ApiResponse<ApiBroadcast>>(`/api/broadcasts/${id}/send`, { method: 'POST' }),
  },

  // ── Round 2 APIs ─────────────────────────────────────────────────────────
  users: {
    list: () =>
      fetchApi<ApiResponse<User[]>>('/api/users'),
    get: (id: string) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`),
    create: (data: { email?: string | null; phone?: string | null; externalId?: string | null; displayName?: string | null }) =>
      fetchApi<ApiResponse<User>>('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<User, 'email' | 'phone' | 'externalId' | 'displayName'>>) =>
      fetchApi<ApiResponse<User>>(`/api/users/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${id}`, { method: 'DELETE' }),
    link: (userId: string, friendId: string) =>
      fetchApi<ApiResponse<null>>(`/api/users/${userId}/link`, {
        method: 'POST',
        body: JSON.stringify({ friendId }),
      }),
    accounts: (userId: string) =>
      fetchApi<ApiResponse<{ id: string; lineUserId: string; displayName: string | null; isFollowing: boolean }[]>>(
        `/api/users/${userId}/accounts`,
      ),
  },
  lineAccounts: {
    list: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    get: (id: string) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`),
    create: (data: { channelId: string; name: string; channelAccessToken: string; channelSecret: string }) =>
      fetchApi<ApiResponse<LineAccount>>('/api/line-accounts', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<LineAccount, 'name' | 'channelAccessToken' | 'channelSecret' | 'isActive'>>) =>
      fetchApi<ApiResponse<LineAccount>>(`/api/line-accounts/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/line-accounts/${id}`, { method: 'DELETE' }),
  },
  conversions: {
    points: () =>
      fetchApi<ApiResponse<ConversionPoint[]>>('/api/conversions/points'),
    createPoint: (data: { name: string; eventType: string; value?: number | null }) =>
      fetchApi<ApiResponse<ConversionPoint>>('/api/conversions/points', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deletePoint: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/conversions/points/${id}`, { method: 'DELETE' }),
    track: (data: { conversionPointId: string; friendId: string; userId?: string | null; affiliateCode?: string | null; metadata?: Record<string, unknown> | null }) =>
      fetchApi<ApiResponse<unknown>>('/api/conversions/track', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    report: (params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ conversionPointId: string; conversionPointName: string; eventType: string; totalCount: number; totalValue: number }[]>>(
        '/api/conversions/report?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  affiliates: {
    list: () =>
      fetchApi<ApiResponse<Affiliate[]>>('/api/affiliates'),
    get: (id: string) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`),
    create: (data: { name: string; code: string; commissionRate?: number }) =>
      fetchApi<ApiResponse<Affiliate>>('/api/affiliates', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Affiliate, 'name' | 'commissionRate' | 'isActive'>>) =>
      fetchApi<ApiResponse<Affiliate>>(`/api/affiliates/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/affiliates/${id}`, { method: 'DELETE' }),
    report: (id: string, params?: { startDate?: string; endDate?: string }) =>
      fetchApi<ApiResponse<{ affiliateId: string; affiliateName: string; code: string; commissionRate: number; totalClicks: number; totalConversions: number; totalRevenue: number }>>(
        `/api/affiliates/${id}/report?` + new URLSearchParams(params as Record<string, string>),
      ),
  },
  templates: {
    list: (category?: string) =>
      fetchApi<ApiResponse<ApiTemplate[]>>(
        '/api/templates' + (category ? '?' + new URLSearchParams({ category }) : ''),
      ),
    get: (id: string) =>
      fetchApi<ApiResponse<ApiTemplate>>(`/api/templates/${id}`),
    create: (data: { name: string; categories?: string[] }) =>
      fetchApi<ApiResponse<ApiTemplate>>('/api/templates', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ name: string; categories: string[] }>) =>
      fetchApi<ApiResponse<ApiTemplate>>(`/api/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}`, { method: 'DELETE' }),
    getMessages: (id: string) =>
      fetchApi<ApiResponse<ApiTemplateMessage[]>>(`/api/templates/${id}/messages`),
    addMessage: (id: string, data: { messageId: string; stepOrder: number }) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}/messages`, { method: 'POST', body: JSON.stringify(data) }),
    removeMessage: (id: string, messageId: string) =>
      fetchApi<ApiResponse<null>>(`/api/templates/${id}/messages/${messageId}`, { method: 'DELETE' }),
  },
  messages: {
    list: (params?: { type?: string; tag?: string }) => {
      const query: Record<string, string> = {}
      if (params?.type) query.type = params.type
      if (params?.tag) query.tag = params.tag
      return fetchApi<ApiResponse<ApiMessage[]>>('/api/messages?' + new URLSearchParams(query))
    },
    get: (id: string) => fetchApi<ApiResponse<ApiMessage>>(`/api/messages/${id}`),
    create: (data: { messageType: string; content: string; altText?: string | null; tags?: string[]; label?: string | null }) =>
      fetchApi<ApiResponse<ApiMessage>>('/api/messages', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<{ messageType: string; content: string; altText: string | null; tags: string[]; label: string | null }>) =>
      fetchApi<ApiResponse<ApiMessage>>(`/api/messages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => fetchApi<ApiResponse<null>>(`/api/messages/${id}`, { method: 'DELETE' }),
  },
  automations: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Automation[]>>('/api/automations' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Automation & { logs?: AutomationLog[] }>>(`/api/automations/${id}`),
    create: (data: {
      name: string
      eventType: Automation['eventType']
      actions: Automation['actions']
      description?: string | null
      conditions?: Record<string, unknown>
      priority?: number
    }) =>
      fetchApi<ApiResponse<Automation>>('/api/automations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Automation, 'name' | 'description' | 'eventType' | 'conditions' | 'actions' | 'isActive' | 'priority'>>) =>
      fetchApi<ApiResponse<Automation>>(`/api/automations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/automations/${id}`, { method: 'DELETE' }),
    logs: (id: string, limit?: number) =>
      fetchApi<ApiResponse<AutomationLog[]>>(
        `/api/automations/${id}/logs` + (limit ? `?limit=${limit}` : ''),
      ),
    actions: {
      list: (automationId: string) =>
        fetchApi<ApiResponse<AutomationActionItem[]>>(`/api/automations/${automationId}/actions`),
      create: (automationId: string, data: {
        actionType: string;
        params?: Record<string, unknown>;
        conditionJson?: Record<string, unknown> | null;
        onError?: 'continue' | 'abort';
        label?: string;
      }) =>
        fetchApi<ApiResponse<AutomationActionItem>>(`/api/automations/${automationId}/actions`, {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (automationId: string, actionId: string, data: Partial<{
        actionType: string;
        params: Record<string, unknown>;
        conditionJson: Record<string, unknown> | null;
        onError: 'continue' | 'abort';
        label: string;
        stepOrder: number;
        isActive: boolean;
      }>) =>
        fetchApi<ApiResponse<AutomationActionItem>>(`/api/automations/${automationId}/actions/${actionId}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (automationId: string, actionId: string) =>
        fetchApi<ApiResponse<null>>(`/api/automations/${automationId}/actions/${actionId}`, { method: 'DELETE' }),
    },
  },
  chats: {
    list: (params?: { status?: string; operatorId?: string; accountId?: string }) => {
      const query: Record<string, string> = {}
      if (params?.status) query.status = params.status
      if (params?.operatorId) query.operatorId = params.operatorId
      if (params?.accountId) query.lineAccountId = params.accountId
      return fetchApi<ApiResponse<Chat[]>>(
        '/api/chats?' + new URLSearchParams(query),
      )
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Chat & { messages?: { id: string; content: string; senderType: string; createdAt: string }[] }>>(
        `/api/chats/${id}`,
      ),
    create: (data: { friendId: string; operatorId?: string | null }) =>
      fetchApi<ApiResponse<Chat>>('/api/chats', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { operatorId?: string | null; status?: Chat['status']; notes?: string | null }) =>
      fetchApi<ApiResponse<Chat>>(`/api/chats/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    send: (id: string, data: { content: string; messageType?: string }) =>
      fetchApi<ApiResponse<unknown>>(`/api/chats/${id}/send`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
  reminders: {
    list: (params?: { accountId?: string }) => {
      const query = params?.accountId ? '?lineAccountId=' + params.accountId : ''
      return fetchApi<ApiResponse<Reminder[]>>('/api/reminders' + query)
    },
    get: (id: string) =>
      fetchApi<ApiResponse<Reminder & { steps: ReminderStep[] }>>(`/api/reminders/${id}`),
    create: (data: { name: string; description?: string | null }) =>
      fetchApi<ApiResponse<Reminder>>('/api/reminders', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Pick<Reminder, 'name' | 'description' | 'isActive'>>) =>
      fetchApi<ApiResponse<Reminder>>(`/api/reminders/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${id}`, { method: 'DELETE' }),
    addStep: (id: string, data: { offsetMinutes: number; messageType: string; messageContent: string }) =>
      fetchApi<ApiResponse<ReminderStep>>(`/api/reminders/${id}/steps`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    deleteStep: (reminderId: string, stepId: string) =>
      fetchApi<ApiResponse<null>>(`/api/reminders/${reminderId}/steps/${stepId}`, {
        method: 'DELETE',
      }),
  },
  scoring: {
    rules: () =>
      fetchApi<ApiResponse<ScoringRule[]>>('/api/scoring-rules'),
    getRule: (id: string) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`),
    createRule: (data: { name: string; eventType: string; scoreValue: number }) =>
      fetchApi<ApiResponse<ScoringRule>>('/api/scoring-rules', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRule: (id: string, data: Partial<Pick<ScoringRule, 'name' | 'eventType' | 'scoreValue' | 'isActive'>>) =>
      fetchApi<ApiResponse<ScoringRule>>(`/api/scoring-rules/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteRule: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/scoring-rules/${id}`, { method: 'DELETE' }),
    friendScore: (friendId: string) =>
      fetchApi<ApiResponse<{ totalScore: number; history: { id: string; scoreChange: number; reason: string | null; createdAt: string }[] }>>(
        `/api/friends/${friendId}/score`,
      ),
  },
  webhooks: {
    incoming: {
      list: () =>
        fetchApi<ApiResponse<IncomingWebhook[]>>('/api/webhooks/incoming'),
      create: (data: { name: string; sourceType?: string; secret?: string | null }) =>
        fetchApi<ApiResponse<IncomingWebhook>>('/api/webhooks/incoming', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<IncomingWebhook, 'name' | 'sourceType' | 'isActive'>>) =>
        fetchApi<ApiResponse<IncomingWebhook>>(`/api/webhooks/incoming/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/incoming/${id}`, { method: 'DELETE' }),
    },
    outgoing: {
      list: () =>
        fetchApi<ApiResponse<OutgoingWebhook[]>>('/api/webhooks/outgoing'),
      create: (data: { name: string; url: string; eventTypes: string[]; secret?: string | null }) =>
        fetchApi<ApiResponse<OutgoingWebhook>>('/api/webhooks/outgoing', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<OutgoingWebhook, 'name' | 'url' | 'eventTypes' | 'isActive'>>) =>
        fetchApi<ApiResponse<OutgoingWebhook>>(`/api/webhooks/outgoing/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/webhooks/outgoing/${id}`, { method: 'DELETE' }),
    },
  },
  notifications: {
    rules: {
      list: () =>
        fetchApi<ApiResponse<NotificationRule[]>>('/api/notifications/rules'),
      get: (id: string) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`),
      create: (data: { name: string; eventType: string; conditions?: Record<string, unknown>; channels?: string[] }) =>
        fetchApi<ApiResponse<NotificationRule>>('/api/notifications/rules', {
          method: 'POST',
          body: JSON.stringify(data),
        }),
      update: (id: string, data: Partial<Pick<NotificationRule, 'name' | 'eventType' | 'conditions' | 'channels' | 'isActive'>>) =>
        fetchApi<ApiResponse<NotificationRule>>(`/api/notifications/rules/${id}`, {
          method: 'PUT',
          body: JSON.stringify(data),
        }),
      delete: (id: string) =>
        fetchApi<ApiResponse<null>>(`/api/notifications/rules/${id}`, { method: 'DELETE' }),
    },
    list: (params?: { status?: string; limit?: string }) =>
      fetchApi<ApiResponse<Notification[]>>(
        '/api/notifications?' + new URLSearchParams(params as Record<string, string>),
      ),
  },
  health: {
    accounts: () =>
      fetchApi<ApiResponse<LineAccount[]>>('/api/line-accounts'),
    getHealth: (accountId: string) =>
      fetchApi<ApiResponse<{ riskLevel: string; logs: AccountHealthLog[] }>>(
        `/api/accounts/${accountId}/health`,
      ),
    migrations: () =>
      fetchApi<ApiResponse<AccountMigration[]>>('/api/accounts/migrations'),
    migrate: (fromAccountId: string, data: { toAccountId: string }) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/${fromAccountId}/migrate`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getMigration: (migrationId: string) =>
      fetchApi<ApiResponse<AccountMigration>>(`/api/accounts/migrations/${migrationId}`),
  },
  staff: {
    list: () =>
      fetchApi<ApiResponse<StaffMember[]>>('/api/staff'),
    get: (id: string) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`),
    me: () =>
      fetchApi<ApiResponse<{ id: string; name: string; role: string; email: string | null }>>('/api/staff/me'),
    create: (data: { name: string; email?: string; role: 'admin' | 'staff' }) =>
      fetchApi<ApiResponse<StaffMember>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; email?: string | null; role?: string; isActive?: boolean }) =>
      fetchApi<ApiResponse<StaffMember>>(`/api/staff/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/staff/${id}`, { method: 'DELETE' }),
    regenerateKey: (id: string) =>
      fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${id}/regenerate-key`, { method: 'POST' }),
  },
  entryRoutes: {
    list: () =>
      fetchApi<ApiResponse<EntryRouteItem[]>>('/api/entry-routes'),
    get: (id: string) =>
      fetchApi<ApiResponse<EntryRouteItem & { trackingCount: number }>>(`/api/entry-routes/${id}`),
    create: (data: { refCode: string; name: string; tagId?: string | null; scenarioId?: string | null; redirectUrl?: string | null; isActive?: boolean }) =>
      fetchApi<ApiResponse<EntryRouteItem>>('/api/entry-routes', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { refCode?: string; name?: string; tagId?: string | null; scenarioId?: string | null; redirectUrl?: string | null; isActive?: boolean }) =>
      fetchApi<ApiResponse<EntryRouteItem>>(`/api/entry-routes/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      fetchApi<ApiResponse<null>>(`/api/entry-routes/${id}`, { method: 'DELETE' }),
  },
}
