import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'
import { registerBundledSkill } from '../bundledSkills.js'

function extractUserMessages(messages: Message[]): string[] {
  return messages
    .filter((message): message is Extract<typeof message, { type: 'user' }> =>
      message.type === 'user',
    )
    .map(message => {
      const { content } = message.message
      if (typeof content === 'string') {
        return content
      }
      return content
        .filter(
          (block): block is Extract<typeof block, { type: 'text' }> =>
            block.type === 'text',
        )
        .map(block => block.text)
        .join('\n')
    })
    .filter(text => text.trim().length > 0)
}

const RUN_SKILL_GENERATOR_PROMPT = `# Run Skill Generator

You are creating or updating a reusable Claude Code skill because the user explicitly asked for one.

## Session Context

Recent user-authored messages from this conversation:
<user_messages>
{{userMessages}}
</user_messages>

The direct skill request is:
<skill_request>
{{skillRequest}}
</skill_request>

## Your Job

Create a high-quality skill that Claude can reuse in future sessions. Prefer updating an existing matching skill over creating a duplicate.

### 1. Check For Existing Skills First
- Search repo skills (\`.claude/skills\`) and personal skills (\`~/.claude/skills\`) for an existing skill that already covers this workflow.
- If one exists and the user is refining it, update that skill instead of creating a near-duplicate.
- Read the existing skill before proposing changes.

### 2. Clarify Only What Matters
- Use AskUserQuestion for every question. Never ask clarification questions in plain assistant text.
- Keep questions concise and practical.
- Clarify only if needed:
  - skill name
  - save location (repo vs personal)
  - arguments
  - when_to_use / trigger phrases
  - irreversible checkpoints or rules
- Do not over-interview simple workflows.

### 3. Design The Skill
The skill should be specific, reusable, and operationally complete.

When drafting the skill:
- Capture the actual goal and success criteria, not just generic steps.
- Include concrete outputs/artifacts when later steps depend on them.
- Call out human checkpoints before destructive or irreversible actions.
- Prefer existing tools and repo workflows over inventing new mechanisms.
- Keep the skill short when the task is simple.

### 4. Write The SKILL.md
Use this format:

\`\`\`markdown
---
name: {{skill-name}}
description: {{one-line description}}
allowed-tools:
  {{minimum permission patterns needed}}
when_to_use: {{Start with "Use when..." and include trigger phrases/examples}}
argument-hint: "{{hint showing argument placeholders}}"
arguments:
  {{list of argument names}}
context: {{inline or fork -- omit for inline}}
---

# {{Skill Title}}

## Goal
Clearly state the outcome this skill should achieve.

## Inputs
- \`$arg_name\`: Description

## Steps

### 1. Step Name
Specific instructions for this step.

**Success criteria**: Always include this.

### 2. Step Name
...
\`\`\`

Per-step annotations when useful:
- **Success criteria**: required on every step
- **Execution**: \`Direct\`, \`Task agent\`, \`Teammate\`, or \`[human]\`
- **Artifacts**: outputs needed by later steps
- **Human checkpoint**: when to pause for approval
- **Rules**: hard constraints that must be respected

Frontmatter rules:
- \`allowed-tools\`: minimum needed permissions only
- \`when_to_use\`: critical; say when Claude should auto-invoke the skill
- \`context: fork\`: only for self-contained work that should run in a subagent
- \`arguments\` / \`argument-hint\`: include only when the skill truly takes parameters

### 5. Confirm Before Saving
- Before writing the file, show the full SKILL.md in a yaml code block for review.
- Ask for confirmation with AskUserQuestion using a short question.
- After approval, write or update the file.

### 6. Final Response
After saving, tell the user:
- where the skill was saved
- how to invoke it
- whether you created a new skill or updated an existing one

## Save Location Guidance
- Repo-specific workflow -> \`.claude/skills/<name>/SKILL.md\`
- Cross-repo personal workflow -> \`~/.claude/skills/<name>/SKILL.md\`
`

export function registerRunSkillGeneratorSkill(): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  registerBundledSkill({
    name: 'run-skill-generator',
    description: 'Generate or update a reusable skill from the user request.',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'AskUserQuestion',
      'Bash(mkdir:*)',
    ],
    userInvocable: false,
    argumentHint: '[what the skill should do]',
    async getPromptForCommand(args, context) {
      const userMessages = extractUserMessages(
        getMessagesAfterCompactBoundary(context.messages),
      )
      const skillRequest =
        args.trim() ||
        userMessages[userMessages.length - 1] ||
        'Create a reusable skill based on the current user request.'

      const prompt = RUN_SKILL_GENERATOR_PROMPT.replace(
        '{{userMessages}}',
        userMessages.join('\n\n---\n\n') || 'No user messages available.',
      ).replace('{{skillRequest}}', skillRequest)

      return [{ type: 'text', text: prompt }]
    },
  })
}
