import { GoogleGenAI, Type } from "@google/genai";
import { ArchivalPage, Cluster, Tier } from "../types";

const getAiClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is not set in environment variables");
  }
  return new GoogleGenAI({ apiKey });
};

// Helper to convert File to Base64
const fileToGenerativePart = async (file: File): Promise<{ inlineData: { data: string; mimeType: string } }> => {
  // Check for TIFF and convert to PNG if necessary because Gemini API doesn't support TIFF
  if (file.type === 'image/tiff' || file.name.toLowerCase().endsWith('.tif') || file.name.toLowerCase().endsWith('.tiff')) {
    try {
      const buffer = await file.arrayBuffer();
      // @ts-ignore
      if (window.UTIF) {
        // @ts-ignore
        const ifds = window.UTIF.decode(buffer);
        if (ifds && ifds.length > 0) {
          const firstPage = ifds[0];
          // @ts-ignore
          window.UTIF.decodeImage(buffer, firstPage);
          // @ts-ignore
          const rgba = window.UTIF.toRGBA8(firstPage);
          
          const canvas = document.createElement('canvas');
          canvas.width = firstPage.width;
          canvas.height = firstPage.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imgData = ctx.createImageData(canvas.width, canvas.height);
            for (let i = 0; i < rgba.length; i++) {
              imgData.data[i] = rgba[i];
            }
            ctx.putImageData(imgData, 0, 0);
            
            // Convert to PNG for the API
            const dataUrl = canvas.toDataURL('image/png');
            return {
              inlineData: {
                data: dataUrl.split(',')[1],
                mimeType: 'image/png',
              },
            };
          }
        }
      }
    } catch (e) {
      console.warn("TIFF conversion failed in service", e);
      // Fall through to default handler if conversion fails
    }
  }

  // Standard handling for supported files
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve({
        inlineData: {
          data: base64String,
          mimeType: file.type,
        },
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// Helper for retry logic with exponential backoff
const generateContentWithRetry = async (ai: GoogleGenAI, params: any, retries = 3): Promise<any> => {
  try {
    return await ai.models.generateContent(params);
  } catch (e: any) {
    // Check for rate limit errors (429 or RESOURCE_EXHAUSTED)
    const isRateLimit = 
      e.status === 429 || 
      e.code === 429 || 
      (e.message && e.message.includes('429')) ||
      (e.status && e.status.toString().includes('RESOURCE_EXHAUSTED'));

    if (isRateLimit && retries > 0) {
      // Exponential backoff: 4s, 8s, 16s...
      const delay = 4000 * Math.pow(2, 3 - retries);
      console.warn(`Quota exceeded. Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return generateContentWithRetry(ai, params, retries - 1);
    }
    throw e;
  }
};

/**
 * Robust JSON extraction.
 * Attempts to parse JSON directly.
 * If that fails (e.g. truncated), tries to extract fields via regex.
 */
const extractJSON = (text: string, fields: string[]): any => {
  if (!text) return {};
  
  // 1. Try standard parse
  try {
    return JSON.parse(text);
  } catch (e) {
    console.warn("JSON Parse failed, attempting regex fallback", e);
  }

  // 2. Regex Fallback
  // Matches "key": "value..." handles escaped quotes, newlines, and potential truncation at the end
  // This regex looks for "key": " and captures until the next unescaped " OR the end of the text
  // Note: This is a heuristic and might fail on complex nested JSON, but works for flat fields like transcription.
  const result: any = {};
  
  fields.forEach(field => {
    const regex = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)(?:"|$)`, 's');
    const match = text.match(regex);
    if (match && match[1]) {
      // Unescape JSON string characters (like \n, \", etc)
      try {
        // wrapping in quotes to use JSON.parse to handle unescaping
        result[field] = JSON.parse(`"${match[1]}"`); 
      } catch (parseErr) {
        // If unescaping fails, just return raw capture
        result[field] = match[1];
      }
    }
  });

  return result;
};

// Step C: Initial Metadata Analysis
export const analyzePageContent = async (
  page: ArchivalPage,
  tier: 'FREE' | 'PAID'
): Promise<Partial<ArchivalPage>> => {
  const ai = getAiClient();
  const modelName = "gemini-2.5-flash"; // Fast model for visual analysis

  // Delays for free tier to avoid rate limits
  if (tier === 'FREE') {
    await new Promise(r => setTimeout(r, 2000));
  }

  try {
    const imagePart = await fileToGenerativePart(page.fileObj);
    
    // Removed requirement for visual description
    const prompt = `
      Analyze this archival document page. 
      1. Identify the language(s) present.
      2. Identify the production mode (e.g., print, photograph, handwriting, drawing, typewriting). 
         If it is mixed, list them. If handwriting is minor (like a signature), put it in brackets e.g. "English print (handwritten note)".
      3. Check specifically for Hebrew handwriting.
    `;

    const response = await generateContentWithRetry(ai, {
      model: modelName,
      contents: {
        role: 'user',
        parts: [imagePart, { text: prompt }]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            language: { type: Type.STRING },
            productionMode: { type: Type.STRING },
            hasHebrewHandwriting: { type: Type.BOOLEAN },
            // Removed description from schema
          },
          required: ["language", "productionMode", "hasHebrewHandwriting"]
        }
      }
    });

    const text = response.text || "{}";
    const result = extractJSON(text, ["language", "productionMode", "hasHebrewHandwriting"]);
    
    return {
      language: result.language,
      productionMode: result.productionMode,
      hasHebrewHandwriting: result.hasHebrewHandwriting,
      status: 'analyzed'
    };

  } catch (error) {
    console.error("Analysis failed", error);
    return { status: 'error', error: "Analysis failed (Quota/Network)" };
  }
};

// Step F: Transcription and Translation
export const transcribeAndTranslatePage = async (
  page: ArchivalPage,
  tier: 'FREE' | 'PAID'
): Promise<Partial<ArchivalPage>> => {
  const ai = getAiClient();
  const modelName = "gemini-2.5-flash";

   if (tier === 'FREE') {
    await new Promise(r => setTimeout(r, 2000));
  }

  try {
    const imagePart = await fileToGenerativePart(page.fileObj);
    const parts: any[] = [imagePart];
    
    let prompt = "You are an expert archivist. ";
    
    if (page.shouldTranscribe) {
      prompt += `
        Transcribe the text in this image exactly as it appears. 
        - Auto-detect the language (e.g., English, Hebrew, Arabic, German). 
        - If the text is in Hebrew or another non-Latin script, transcribe it accurately in its original script.
        - Handle handwriting, cursive, or mixed scripts with high fidelity.
        - Preserve line breaks and the original layout structure.
      `;
    }
    
    if (page.shouldTranslate) {
      prompt += "Translate the content to English. ";
    }

    prompt += "Return the result in JSON format with 'transcription', 'translation' fields. If one wasn't requested, leave it empty.";

     const response = await generateContentWithRetry(ai, {
      model: modelName,
      contents: {
        role: 'user',
        parts: [...parts, { text: prompt }]
      },
      config: {
        maxOutputTokens: 8192, // Explicitly set high token limit
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcription: { type: Type.STRING },
            translation: { type: Type.STRING },
          },
        }
      }
    });

    const text = response.text || "{}";
    
    // Simple JSON parse first because regex is hard for nested objects
    let result: any = {};
    try {
      result = JSON.parse(text);
    } catch (e) {
      console.warn("Parsing failed, trying to extract minimal fields");
      result = extractJSON(text, ["transcription", "translation"]);
    }

    return {
      generatedTranscription: result.transcription || (text.includes("transcription") ? "" : ""), 
      generatedTranslation: result.translation || "",
      status: 'done'
    };

  } catch (error) {
    console.error("Transcription failed", error);
    return { status: 'error', error: "Transcription failed (Quota/Network)" };
  }
};

// Step G: Clustering
export const clusterPages = async (pages: ArchivalPage[], tier: Tier): Promise<Cluster[]> => {
  const ai = getAiClient();
  
  // Use Flash for FREE tier to avoid 429 quota errors on Pro models which may have 0 limit on free tier
  // Use Pro for PAID tier, with fallback to Flash
  let modelName = tier === Tier.FREE ? "gemini-2.5-flash" : "gemini-3-pro-preview"; 

  // We send metadata instead of images to save tokens and context window.
  const inputData = pages.map(p => ({
    id: p.id,
    indexName: p.indexName,
    description: p.manualDescription || "No description", // Uses manual description if available
    language: p.language,
    // Use manual transcription if available, otherwise generated. 
    // Increase slice to 50,000 to ensure full entities are captured in large documents.
    contentPreview: (p.manualTranscription || p.generatedTranscription || "").slice(0, 50000), 
  }));

  const prompt = `
    I have a list of archival document pages. 
    Group them into thematic "document clusters". A cluster might be a single page, or a multi-page letter, or a report.
    Use the indexName (sequence), description, and content hints (transcription) to determine logical start and end points.
    
    Data: ${JSON.stringify(inputData)}

    Return a JSON array of clusters. Each cluster must include detailed metadata extracted from the documents:
    - id (number)
    - title (Short English title for the cluster, 4-8 words)
    - pageRange (string, e.g. "Doc_01 - Doc_04")
    - summary (50-100 words summary of the content)
    - pageIds (array of strings, the 'id' of the pages belonging to this cluster)
    - prisonName: Name of the prison if mentioned (string, optional)
    - languages: List of languages present (array of strings)
    - originalDate: File date as written in the text (string)
    - standardizedDate: File date in yyyy-mm-dd format (string)
    - sender: Name or role of the sender (string)
    - recipient: Name or role of the recipient (string)
    - entities: Aggregate the named entities mentioned in this cluster (people, places, organizations)

    IMPORTANT OUTPUT RULES:
    1. Return ONLY the raw JSON array. Do not include markdown formatting (like \`\`\`json).
    2. Ensure strictly valid JSON syntax. 
    3. Escape all double quotes inside string values (e.g. use \\" instead of ").
    4. Do not leave trailing commas.
  `;

  const runClustering = async (model: string) => {
    const response = await generateContentWithRetry(ai, {
      model: model,
      contents: prompt,
      config: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.INTEGER },
              title: { type: Type.STRING },
              pageRange: { type: Type.STRING },
              summary: { type: Type.STRING },
              pageIds: { type: Type.ARRAY, items: { type: Type.STRING } },
              prisonName: { type: Type.STRING },
              languages: { type: Type.ARRAY, items: { type: Type.STRING } },
              originalDate: { type: Type.STRING },
              standardizedDate: { type: Type.STRING },
              sender: { type: Type.STRING },
              recipient: { type: Type.STRING },
              entities: {
                type: Type.OBJECT,
                properties: {
                  people: { type: Type.ARRAY, items: { type: Type.STRING } },
                  places: { type: Type.ARRAY, items: { type: Type.STRING } },
                  organizations: { type: Type.ARRAY, items: { type: Type.STRING } },
                }
              }
            },
            required: ["id", "title", "pageRange", "summary", "pageIds"]
          }
        }
      }
    });
    
    // Parse the output, handle standard list response
    let text = response.text || "[]";
    
    // Clean markdown
    if (text.startsWith("```")) {
      text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
    }

    try {
      return JSON.parse(text);
    } catch (e) {
       console.error("Clustering JSON parse error", e);
       
       // Try to fix common issues: Trailing commas
       let fixedText = text.replace(/,\s*([\]}])/g, '$1');
       
       try { return JSON.parse(fixedText); } catch (e2) {}

       // Try closing truncated JSON
       if (fixedText.trim().startsWith("[")) {
         if (!fixedText.trim().endsWith("]")) {
            fixedText += "]"; 
         }
         try { return JSON.parse(fixedText); } catch (e3) {}
       }
       
       return [];
    }
  };

  try {
     return await runClustering(modelName);
  } catch (e) {
    console.error(`Clustering failed with ${modelName}`, e);
    // If Pro failed (e.g. Rate Limit on paid tier or model unavailable), try Flash as fallback
    if (modelName === "gemini-3-pro-preview") {
      console.log("Falling back to gemini-2.5-flash for clustering...");
      return await runClustering("gemini-2.5-flash");
    }
    throw e;
  }
};