import { connection } from 'next/server';
import { FrameworkGuide } from '@/components/site/FrameworkGuide';
import { signPageChunks } from '@/lib/server/scriptIntegrity';
import { SKILL_VERSION } from '@/lib/server/skill';

export const metadata = {
  title: 'Orientim in Vercel AI SDK — Orientim',
  description: 'The Orientim MCP server in the Vercel AI SDK: protected Solana swaps for an AI SDK agent, with a working example.',
};

/** agent.ts, as checked with tsc against the framework's packages and run against @orientimhq/swap from npm. */
const CODE = `import { createInterface } from 'node:readline/promises';
import { anthropic } from '@ai-sdk/anthropic';
import { createMCPClient, ElicitationRequestSchema } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { generateText, isStepCount } from 'ai';

const orientim = await createMCPClient({
  transport: new StdioMCPTransport({
    command: 'npx',
    args: ['-y', '@orientimhq/swap@${SKILL_VERSION}', 'mcp'],
    env: {
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL!,
      ORIENTIM_WALLET_KEYPAIR: '/home/agent/agent-wallet.json',
      ORIENTIM_POLICY: '/etc/orientim/policy.json',
    },
  }),
  // Tells the server it may ask you before a swap.
  capabilities: { elicitation: {} },
});

// The server's question, before the first swap of each quote: only a typed "yes" makes it.
const terminal = createInterface({ input: process.stdin, output: process.stdout });
orientim.onElicitationRequest(ElicitationRequestSchema, async ({ params }) => {
  const answer = await terminal.question(\`\\n\${params.message}\\nSwap? (yes/no) \`);
  return answer.trim().toLowerCase() === 'yes' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
});

try {
  const { text } = await generateText({
    model: anthropic('claude-sonnet-5-5'),
    tools: await orientim.tools(),
    stopWhen: isStepCount(10),
    prompt: process.argv[2] ?? 'Show my wallet, then quote 1 USDC to SOL.',
  });
  console.log(text);
} finally {
  await orientim.close();
  terminal.close();
}`;

export default async function Page() {
  signPageChunks('developers/vercel-ai-sdk/page');
  await connection();
  return (
    <FrameworkGuide
      framework="the Vercel AI SDK"
      install="npm install ai @ai-sdk/mcp @ai-sdk/anthropic tsx"
      code={CODE}
      asking={
        <p>
          <code>capabilities: {'{ elicitation: {} }'}</code> tells the server that your app can ask you, and{' '}
          <code>onElicitationRequest</code> is where you do. Any model the AI SDK supports works the same way.
        </p>
      }
    />
  );
}
