const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

class AIService {
    /**
     * Intelligently generate a Dockerfile based on the repository contents
     */
    static async generateDockerfile(dir, backendPort, envVars) {
        if (!process.env.GEMINI_API_KEY) {
            console.warn('[AIService] GEMINI_API_KEY not found. Falling back to basic generation.');
            return null;
        }

        try {
            console.log(`[AIService] Analyzing directory for Smart Dockerfile generation: ${dir}`);
            const files = fs.readdirSync(dir);
            
            // Read key files to send as context
            const context = {};
            const importantFiles = ['package.json', 'requirements.txt', 'go.mod', 'pom.xml', 'Gemfile'];
            for (const file of files) {
                if (importantFiles.includes(file)) {
                    context[file] = fs.readFileSync(path.join(dir, file), 'utf8');
                }
            }

            const prompt = `
You are an expert DevOps engineer writing a highly optimized Dockerfile.
I have a project with the following files: ${files.join(', ')}

Here are the contents of the key dependency files to help you determine the framework (if any):
${JSON.stringify(context, null, 2)}

The application needs to expose port: ${backendPort || 3000}.
Any provided environment variables have already been passed as build args.
If this is a Node/React/Vite app, make sure to build the static files and serve them using Nginx.
If this is a Node backend, just use node to start it.
If Python, use a python image and pip install.

Write ONLY the raw Dockerfile content. Do NOT use markdown code blocks (\`\`\`docker).
Start the Dockerfile with: # KUBEX-GENERATED-AI
            `.trim();

            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: prompt,
            });

            // Clean up any markdown blocks if the AI accidentally adds them
            let dockerfile = response.text.trim();
            if (dockerfile.startsWith('```')) {
                const lines = dockerfile.split('\n');
                lines.shift();
                if (lines[lines.length - 1].startsWith('```')) lines.pop();
                dockerfile = lines.join('\n');
            }

            return dockerfile;
        } catch (error) {
            console.error('[AIService] Smart Dockerfile generation failed:', error.message);
            return null;
        }
    }
}

module.exports = AIService;
