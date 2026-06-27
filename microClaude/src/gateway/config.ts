import { readFile } from 'fs/promises'
import { dirname, isAbsolute, resolve } from 'path'
import { z } from 'zod/v4'
import { EXTERNAL_PERMISSION_MODES } from '../types/permissions.js'
import { jsonParse } from '../utils/slowOperations.js'
import type {
  GatewayDmPolicy,
  GatewayGroupPolicy,
  GatewayPermissionMode,
  GatewayPlatform,
  GatewaySessionKeyStrategy,
  GatewaySessionMode,
} from './types.js'
import {
  GATEWAY_DM_POLICIES,
  GATEWAY_GROUP_POLICIES,
} from './types.js'

const GatewayAccessPolicySchema = z.object({
  allowFrom: z.array(z.string()).default([]),
  dmPolicy: z.enum(GATEWAY_DM_POLICIES).default('pairing'),
  groupPolicy: z.enum(GATEWAY_GROUP_POLICIES).default('mention'),
  groupAllowFrom: z.array(z.string()).default([]),
})

const FeishuGatewayConfigSchema = z
  .object({
    kind: z.literal('feishu'),
    enabled: z.boolean().default(true),
    domain: z.enum(['feishu', 'lark']).default('feishu'),
    connectionMode: z.enum(['websocket', 'webhook']).default('websocket'),
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    verificationToken: z.string().optional(),
    encryptKey: z.string().optional(),
    webhookHost: z.string().default('127.0.0.1'),
    webhookPort: z.number().int().positive().default(8765),
    webhookPath: z.string().default('/feishu/webhook'),
    replyToMessage: z.boolean().default(true),
    renderMode: z.enum(['auto', 'text', 'card']).default('auto'),
    streaming: z.boolean().default(true),
    streamUpdateThrottleMs: z.number().int().nonnegative().default(250),
    maxConcurrentDispatches: z.number().int().positive().default(4),
    maxQueuedDispatches: z.number().int().positive().default(256),
    maxSendRetries: z.number().int().positive().default(3),
    sendRetryBaseDelayMs: z.number().int().positive().default(500),
    senderProfileTtlMs: z.number().int().positive().default(10 * 60 * 1000),
  })
  .extend(GatewayAccessPolicySchema.shape)
  .strict()
  .superRefine((value, ctx) => {
    if (value.connectionMode !== 'webhook') {
      return
    }
    if (!value.verificationToken?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['verificationToken'],
        message:
          'Feishu webhook mode requires verificationToken',
      })
    }
    if (!value.encryptKey?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['encryptKey'],
        message:
          'Feishu webhook mode requires encryptKey',
      })
    }
  })

const WeixinGatewayConfigSchema = z
  .object({
    kind: z.literal('weixin'),
    enabled: z.boolean().default(true),
    token: z.string().min(1),
    baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
    routeTag: z.union([z.string(), z.number()]).optional(),
    pollTimeoutMs: z.number().int().positive().default(35_000),
  })
  .extend(GatewayAccessPolicySchema.shape)
  .strict()

const GatewayPlatformConfigSchema = z.discriminatedUnion('kind', [
  FeishuGatewayConfigSchema,
  WeixinGatewayConfigSchema,
])

const GatewayConfigSchema = z
  .object({
    workspace: z.string().optional(),
    dangerouslySkipPermissions: z.boolean().default(false),
    permissionMode: z.enum(EXTERNAL_PERMISSION_MODES).default('dontAsk'),
    sessionMode: z.enum(['direct', 'channel']).default('direct'),
    sessionKeyStrategy: z.enum(['chat', 'thread', 'user']).default('chat'),
    sessionIdleTimeoutMs: z.number().int().nonnegative().default(30 * 60 * 1000),
    turnTimeoutMs: z.number().int().positive().default(15 * 60 * 1000),
    platforms: z.array(GatewayPlatformConfigSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<GatewayPlatform>()
    for (const platform of value.platforms) {
      if (seen.has(platform.kind)) {
        ctx.addIssue({
          code: 'custom',
          path: ['platforms'],
          message: `Duplicate gateway platform config: ${platform.kind}`,
        })
      }
      seen.add(platform.kind)
    }
  })

export type FeishuGatewayConfig = z.infer<typeof FeishuGatewayConfigSchema>
export type WeixinGatewayConfig = z.infer<typeof WeixinGatewayConfigSchema>
export type GatewayPlatformConfig = z.infer<typeof GatewayPlatformConfigSchema>

export type GatewayConfig = {
  workspace: string
  dangerouslySkipPermissions: boolean
  permissionMode: GatewayPermissionMode
  sessionMode: GatewaySessionMode
  sessionKeyStrategy: GatewaySessionKeyStrategy
  sessionIdleTimeoutMs: number
  turnTimeoutMs: number
  platforms: GatewayPlatformConfig[]
  configPath: string
}

function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(/^\$([A-Z0-9_]+)$/i, (_, name: string) => process.env[name] ?? '')
      .replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? '')
  }
  if (Array.isArray(value)) {
    return value.map(item => expandEnv(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        expandEnv(item),
      ]),
    )
  }
  return value
}

function normalizeWorkspace(configDir: string, workspace?: string): string {
  if (!workspace) {
    return process.cwd()
  }
  return isAbsolute(workspace) ? workspace : resolve(configDir, workspace)
}

export async function loadGatewayConfig(configPath: string): Promise<GatewayConfig> {
  const resolvedPath = resolve(configPath)
  const raw = await readFile(resolvedPath, 'utf8')
  const parsed = GatewayConfigSchema.parse(
    expandEnv(jsonParse(raw)) as Record<string, unknown>,
  )
  const configDir = dirname(resolvedPath)
  return {
    ...parsed,
    workspace: normalizeWorkspace(configDir, parsed.workspace),
    configPath: resolvedPath,
  }
}
