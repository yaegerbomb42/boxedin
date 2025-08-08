import { GoogleGenerativeAI } from '@google/generative-ai';
import { summarizeHistory } from './memory.mjs';

/**
 * Gemini API Wrapper with context management and summarization.
 */
export class GeminiClient {
  constructor({ apiKey, model = 'gemini-1.5-flash', limits = {} }) {
    this.apiKey = apiKey;
    this.model = model;
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.limits = { maxTokens: 8192, contextWindow: 20000, ...limits };
  }

  async generate({ systemPrompt, messages, temperature = 0.3, toolsDescription }) {
    const model = this.genAI.getGenerativeModel({ model: this.model });

    const promptParts = [];
    if (systemPrompt) promptParts.push(systemPrompt);
    if (toolsDescription) promptParts.push(`\nAvailable tools:\n${toolsDescription}`);

    // Flatten messages and summarize if needed
    const context = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    const combined = [...promptParts, context].join('\n\n');

    // Best-effort trimming
    const maxChars = this.limits.contextWindow * 4; // rough char-to-token
    const inputText = combined.length > maxChars ? combined.slice(-maxChars) : combined;

    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: inputText }] }
      ],
      generationConfig: { temperature },
    });

    const text = result?.response?.text?.() ?? result?.response?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return text;
  }
}
