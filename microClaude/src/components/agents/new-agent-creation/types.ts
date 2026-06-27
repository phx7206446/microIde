import type { SettingSource } from '../../../utils/settings/constants.js'
import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'
import type { AgentMemoryScope } from '../../../tools/AgentTool/agentMemory.js'
import type { CustomAgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'

export type GeneratedAgent = {
  identifier: string
  whenToUse: string
  systemPrompt: string
}

export type AgentWizardFinalAgent = CustomAgentDefinition

export type AgentWizardData = {
  location?: SettingSource
  method?: 'generate' | 'manual'
  generationPrompt?: string
  isGenerating?: boolean
  agentType?: string
  systemPrompt?: string
  whenToUse?: string
  generatedAgent?: GeneratedAgent
  wasGenerated?: boolean
  selectedTools?: string[]
  selectedModel?: string
  selectedColor?: AgentColorName
  selectedMemory?: AgentMemoryScope
  finalAgent?: AgentWizardFinalAgent
}
