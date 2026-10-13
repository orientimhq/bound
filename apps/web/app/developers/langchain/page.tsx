import { connection } from 'next/server';
import { FrameworkGuide } from '@/components/site/FrameworkGuide';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_VERSION } from '@/lib/server/skillSums';

export const metadata = {
  title: 'Orientim in LangChain — Orientim',
  description: 'The Orientim MCP server in LangChain.js: protected Solana swaps for a LangChain agent, with a working example.',
};

/** agent.ts, as checked with tsc against the framework's packages and run against orientim-mcp from npm. */
const CODE = `import { createInterface } from 'node:readline/promises';
import { ChatAnthropic } from '@langchain/anthropic';
import { MCPAdapter } from '@langchain/mcp-adapters';
import { createAgent } from 'langchain';

const terminal = createInterface({ input: process.stdin, output: process.stdout });

const orientim = new MCPAdapter({
  prefixToolNameWithServerName: false,
  servers: {
    orientim: {
      command: 'npx',
      args: ['-y', 'orientim-mcp@${SKILL_VERSION}'],
      env: {
        SOLANA_RPC_URL: process.env.SOLANA_RPC_URL!,
        ORIENTIM_WALLET_KEYPAIR: '/home/agent/agent-wallet.json',
        ORIENTIM_POLICY: '/home/agent/orientim-policy.json',
      },
      // Legacy mode lets the server ask you before a swap, through this function.
      mode: 'legacy',
      onElicitation: async request => {
        const answer = await terminal.question(\`\\n\${request.message}\\nSwap? (yes/no) \`);
        return answer.trim().toLowerCase() === 'yes' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
      },
    },
  },
});

try {
  const agent = createAgent({ model: new ChatAnthropic({ model: 'claude-sonnet-5-5' }), tools: await orientim.listTools() });
  const result = await agent.invoke({
    messages: [{ role: 'user', content: process.argv[2] ?? 'Show my wallet, then quote 1 USDC to SOL.' }],
  });
  console.log(result.messages.at(-1)?.content);
} finally {
  await orientim.close();
  terminal.close();
}`;

export default async function Page() {
  signPageChunks('developers/langchain/page');
  await connection();
  return (
    <FrameworkGuide
      framework="LangChain"
      install="npm install langchain @langchain/core @langchain/langgraph @langchain/mcp-adapters @langchain/anthropic tsx"
      code={CODE}
      asking={
        <p>
          Keep <code>mode: &apos;legacy&apos;</code> with <code>onElicitation</code>: without it the server cannot ask you, and the
          swap goes through on the agent&apos;s word alone. Any chat
          model LangChain supports works the same way.
        </p>
      }
    />
  );
}
