/**
 * Query source tags are threaded through analytics, retry policy, compact,
 * and background-agent orchestration. The upstream tree references this as a
 * shared nominal type, but the concrete set is open-ended via template forms
 * like `agent:builtin:${agentType}` and `repl_main_thread:outputStyle:${name}`.
 */
export type QuerySource = string
