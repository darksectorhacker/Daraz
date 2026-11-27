import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { z } from 'zod';

function buildAgent({ provider, model, config, searchProducts, maxProducts }) {
  const collected = [];
  const searchDarazProducts = tool({
    description: 'Search Daraz.pk Pakistan products through the configured, approved Daraz or affiliate product data feed. Use a concise keyword. Never invent products, prices, ratings, sellers, or URLs.',
    inputSchema: z.object({
      keyword: z.string().min(2).max(100).describe('A focused product search phrase for Daraz Pakistan'),
      limit: z.number().int().min(1).max(50).default(10).describe('Maximum products requested from the approved data feed')
    }),
    execute: async ({ keyword, limit }) => {
      const remaining = Math.max(0, maxProducts * 4 - collected.length);
      if (!remaining) return { keyword, count: 0, message: 'This hunt reached its product collection cap.' };
      const rows = await searchProducts(keyword, Math.min(limit, remaining, 20));
      collected.push(...rows);
      return {
        keyword,
        count: rows.length,
        products: rows.map(({ id, title, price, currency, url, rating, reviewCount, soldCount }) => ({
          id, title, price, currency, url, rating, reviewCount, soldCount
        }))
      };
    }
  });

  const instructions = [
    'You are PriceNova, a Daraz.pk Pakistan product research agent.',
    'Use the searchDarazProducts tool to obtain real product records before making product claims.',
    'You may search a few focused keyword variations, but stay within the user request.',
    'Never fabricate product listings, prices, discounts, ratings, seller details, sales, or product URLs.',
    'Do not attempt to access private endpoints, bypass access controls, solve CAPTCHAs, or imitate a logged-in user.',
    'If the connected approved data feed fails or returns no records, explain the limitation clearly.',
    'Summarize the products returned by the tool and distinguish observed data from your own recommendations.'
  ].join(' ');

  const agent = new ToolLoopAgent({
    model,
    instructions,
    tools: { searchDarazProducts },
    stopWhen: stepCountIs(5),
    temperature: 0.1,
    maxRetries: 1
  });

  return {
    generate: async prompt => {
      const result = await agent.generate({ prompt, timeout: { totalMs: 90000, stepMs: 25000 } });
      return { provider, text: result.text || '', products: collected, steps: result.steps?.length || 0 };
    }
  };
}

export async function runDarazAgent({ config, prompt, maxProducts, searchProducts }) {
  const errors = [];

  if (config.geminiKey) {
    try {
      const google = createGoogleGenerativeAI({ apiKey: config.geminiKey });
      const agent = buildAgent({
        provider: 'gemini',
        model: google(config.geminiModel || 'gemini-2.5-flash'),
        config,
        searchProducts,
        maxProducts
      });
      const result = await agent.generate(prompt);
      if (result.products.length) return result;
      throw new Error('Gemini Agent did not call the product search tool.');
    } catch (error) {
      errors.push('Gemini: ' + error.message);
    }
  }

  if (config.groqKey) {
    try {
      const groq = createGroq({ apiKey: config.groqKey });
      const agent = buildAgent({
        provider: 'groq',
        model: groq(config.groqModel || 'llama-3.3-70b-versatile'),
        config,
        searchProducts,
        maxProducts
      });
      const result = await agent.generate(prompt);
      if (result.products.length) return result;
      throw new Error('Groq Agent did not call the product search tool.');
    } catch (error) {
      errors.push('Groq: ' + error.message);
    }
  }

  throw new Error(errors.join(' | ') || 'No AI provider is configured.');
}
