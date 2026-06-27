export async function daemonMain(args: string[]): Promise<void> {
  if (args[0] === 'agent-view') {
    const { runAgentViewDaemon } = await import('../utils/agentView.js')
    await runAgentViewDaemon()
    return
  }
  throw new Error('Daemon not supported in this build')
}
