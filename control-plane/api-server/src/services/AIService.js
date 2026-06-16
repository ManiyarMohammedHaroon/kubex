const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

class AIService {
    /**
     * Analyze container logs using Gemini
     * @param {string} logs 
     * @returns {Promise<string>}
     */
    static async analyzeLogs(logs) {
        if (!process.env.GEMINI_API_KEY) {
            return "AI Analysis is not available because GEMINI_API_KEY is not configured.";
        }

        try {
            const prompt = `
You are a DevOps and Cloud Native expert. Analyze the following Docker container logs.
Identify any errors, warnings, or crashes, and provide a clear, concise explanation of what went wrong and how to fix it.
Format your response in Markdown. Keep it to the point.

--- LOGS START ---
${logs}
--- LOGS END ---
            `.trim();

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            return response.text;
        } catch (error) {
            console.error('[AIService] Log analysis failed:', error.message);
            return `AI Analysis failed: ${error.message}`;
        }
    }
}

module.exports = AIService;
