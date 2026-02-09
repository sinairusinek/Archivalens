
import { GoogleGenAI, Type } from "@google/genai";
import { ArchivalPage, Cluster, Tier, DocType } from "../types";
import { CONTROLLED_VOCABULARY, SUBJECTS_LIST, DOCUMENT_TYPES, PRISON_MASTER_LIST } from "./vocabulary";

const rotateCanvas = (sourceCanvas: HTMLCanvasElement, degrees: number): HTMLCanvasElement => {
  if (degrees === 0) return sourceCanvas;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return sourceCanvas;
  const rads = degrees * Math.PI / 180;
  if (Math.abs(degrees) % 180 === 90) {
    canvas.width = sourceCanvas.height;
    canvas.height = sourceCanvas.width;
  } else {
    canvas.width = sourceCanvas.width;
    canvas.height = sourceCanvas.height;
  }
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rads);
  ctx.drawImage(sourceCanvas, -sourceCanvas.width / 2, -sourceCanvas.height / 2);
  return canvas;
};

const fileToGenerativePart = async (file: File, rotation: number = 0): Promise<{ inlineData: { data: string; mimeType: string } }> => {
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
          let canvas = document.createElement('canvas');
          canvas.width = firstPage.width; canvas.height = firstPage.height;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const imgData = ctx.createImageData(canvas.width, canvas.height);
            for (let i = 0; i < rgba.length; i++) imgData.data[i] = rgba[i];
            ctx.putImageData(imgData, 0, 0);
            if (rotation !== 0) canvas = rotateCanvas(canvas, rotation);
            const dataUrl = canvas.toDataURL('image/png');
            return { inlineData: { data: dataUrl.split(',')[1], mimeType: 'image/png' } };
          }
        }
      }
    } catch (e) { console.warn("TIFF conversion failed", e); }
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
       let canvas = document.createElement('canvas');
       canvas.width = img.width; canvas.height = img.height;
       const ctx = canvas.getContext('2d');
       if(ctx) {
         ctx.drawImage(img, 0, 0);
         if (rotation !== 0) canvas = rotateCanvas(canvas, rotation);
         const dataUrl = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg');
         resolve({ inlineData: { data: dataUrl.split(',')[1], mimeType: file.type === 'image/png' ? 'image/png' : 'image/jpeg' } });
       } else { reject(new Error("Canvas context failed")); }
       URL.revokeObjectURL(url);
    };
    img.onerror = reject;
    img.src = url;
  });
};

const generateContentWithRetry = async (params: any, retries = 3): Promise<any> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  try { return await ai.models.generateContent(params); } catch (e: any) {
    const isRateLimit = e.status === 429 || e.code === 429 || (e.message && e.message.includes('429')) || (e.status && e.status.toString().includes('RESOURCE_EXHAUSTED'));
    if (isRateLimit && retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 4000 * Math.pow(2, 3 - retries)));
      return generateContentWithRetry(params, retries - 1);
    }
    throw e;
  }
};

const repairTruncatedJSON = (json: string): string => {
  let cleaned = json.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
  let inString = false, escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    if (inString) {
      if (char === '\\') escaped = !escaped;
      else if (char === '"' && !escaped) inString = false;
      else escaped = false;
    } else {
      if (char === '"') inString = true;
      else if (char === '{') stack.push('}');
      else if (char === '[') stack.push(']');
      else if ((char === '}' || char === ']') && stack.length > 0 && stack[stack.length - 1] === char) stack.pop();
    }
  }
  cleaned = cleaned.replace(/,\s*$/, "");
  if (inString) cleaned += '"';
  while (stack.length > 0) cleaned += stack.pop();
  return cleaned;
};

const salvageJSONList = (jsonString: string): any[] => {
  try {
    const repaired = repairTruncatedJSON(jsonString);
    const parsed = JSON.parse(repaired);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    const objects: any[] = [];
    let depth = 0, start = -1, inString = false;
    let cleaned = jsonString.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "");
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      if (char === '"' && cleaned[i-1] !== '\\') inString = !inString;
      if (!inString) {
        if (char === '{') { if (depth === 0) start = i; depth++; }
        else if (char === '}') { depth--; if (depth === 0 && start !== -1) { try { objects.push(JSON.parse(cleaned.substring(start, i + 1))); } catch (e) {} start = -1; } }
      }
    }
    return objects;
  }
};

const matchInVocabulary = (name: string): number | undefined => {
  if (!name) return undefined;
  const low = name.toLowerCase().trim();
  const match = CONTROLLED_VOCABULARY.find(v => v.name.toLowerCase() === low);
  if (match) return match.id;
  const prisonMatch = PRISON_MASTER_LIST.find(p => p.name.toLowerCase() === low);
  return prisonMatch?.id;
};

const findDocTypeByName = (name: string): DocType | undefined => {
  if (!name) return undefined;
  const low = name.toLowerCase().trim();
  return DOCUMENT_TYPES.find(d => d.name.toLowerCase() === low);
};

export const analyzePageContent = async (page: ArchivalPage, tier: 'FREE' | 'PAID'): Promise<Partial<ArchivalPage>> => {
  try {
    const imagePart = await fileToGenerativePart(page.fileObj, page.rotation || 0);
    const prompt = `Analyze this archival document page. 
    1. Identify language(s). 
    2. Identify production mode. Strictly use one of: "Handwritten", "Printed", "Typewritten", "No Text", or "Mixed Form".
    3. Check for Hebrew handwriting specifically.`;
    
    const response = await generateContentWithRetry({
      model: "gemini-3-flash-preview",
      contents: { parts: [imagePart, { text: prompt }] },
      config: { 
        responseMimeType: "application/json", 
        responseSchema: { 
          type: Type.OBJECT, 
          properties: { 
            language: { type: Type.STRING }, 
            productionMode: { type: Type.STRING }, 
            hasHebrewHandwriting: { type: Type.BOOLEAN } 
          }, 
          required: ["language", "productionMode", "hasHebrewHandwriting"] 
        } 
      }
    });
    const result = JSON.parse(repairTruncatedJSON(response.text || "{}"));
    return { ...result, status: 'analyzed' };
  } catch (error) { return { status: 'error', error: "Analysis failed" }; }
};

export const transcribeAndTranslatePage = async (page: ArchivalPage, tier: 'FREE' | 'PAID'): Promise<Partial<ArchivalPage>> => {
  try {
    const imagePart = await fileToGenerativePart(page.fileObj, page.rotation || 0);
    let prompt = `Transcribe this archival document exactly. 
    Detect primary language.
    Identify production mode (strictly: "Handwritten", "Printed", "Typewritten", "No Text", or "Mixed Form").
    Preserve layout.
    Score confidence 1-5 (1: very low, 5: high). 
    If 'shouldTranslate' is true, provide an English translation.`;
    
    const response = await generateContentWithRetry({
      model: "gemini-3-flash-preview",
      contents: { parts: [imagePart, { text: prompt }] },
      config: { 
        responseMimeType: "application/json", 
        responseSchema: { 
          type: Type.OBJECT, 
          properties: { 
            transcription: { type: Type.STRING }, 
            translation: { type: Type.STRING }, 
            confidenceScore: { type: Type.INTEGER },
            language: { type: Type.STRING },
            productionMode: { type: Type.STRING }
          } 
        } 
      }
    });
    const result = JSON.parse(repairTruncatedJSON(response.text || "{}"));
    return { 
      generatedTranscription: result.transcription || "", 
      generatedTranslation: result.translation || "", 
      confidenceScore: result.confidenceScore || 3, 
      language: result.language || page.language,
      productionMode: result.productionMode || page.productionMode,
      status: 'done' 
    };
  } catch (error) { 
    console.error("Transcription pipeline error:", error);
    return { status: 'error', error: "Transcription failed" }; 
  }
};

export const clusterPages = async (pages: ArchivalPage[], tier: Tier): Promise<Cluster[]> => {
  let modelName = tier === Tier.FREE ? "gemini-3-flash-preview" : "gemini-3-pro-preview"; 
  const inputData = pages.map(p => ({ 
    id: p.id, 
    indexName: p.indexName, 
    language: p.language, 
    transcription: (p.manualTranscription || p.generatedTranscription || "").slice(0, 15000)
  }));
  
  const vocabSummary = CONTROLLED_VOCABULARY.map(v => v.name).join('|');
  const docTypesSummary = DOCUMENT_TYPES.map(d => d.name).join('|');
  const prisonsSummary = PRISON_MASTER_LIST.map(p => p.name).join('|');

  const prompt = `
    TASK: CLUSTERING & METADATA EXTRACTION
    Analyze the provided archival pages and group them into logical documents (Clusters).

    CRITICAL EXTRACTION RULES:
    1. EXTRACT SENDERS AND RECIPIENTS from both 'indexName' AND text content.
    2. NATIONALITY: For all people, identify nationality: "Arab", "British", "German", "Jew", "Other".
    3. MENTIONED ORGANIZATIONS: List all organizations, committees, or agencies mentioned in the document.
    4. MENTIONED PRISONS: List all prisons, lock-ups, or detention camps mentioned. Use the MASTER PRISON LIST below for reference but extract any mentioned.
    5. ORGANIZATIONAL CATEGORY: For people, identify their organization type (e.g. "British Administration", "Jewish Agency", "Zionist Underground").

    For EACH cluster:
    - title: Descriptive title.
    - pageRange: e.g. "Page 1-3".
    - summary: 1-2 sentence description.
    - pageIds: array of IDs belonging to this cluster.
    - senders: array of {name, role, organizationCategory, nationality}.
    - recipients: array of {name, role, organizationCategory, nationality}.
    - entities: {
        people: array of {name, organizationCategory, nationality},
        organizations: array of {name},
        prisons: array of {name},
        roles: array of {name}
      }

    MASTER PRISON LIST: ${prisonsSummary}
    DOC TYPES: MUST select from [${docTypesSummary}].
    SUBJECTS: select from [${SUBJECTS_LIST.join('|')}].

    Input Data:
    ${JSON.stringify(inputData)}
  `;

  const runClustering = async (model: string) => {
    const response = await generateContentWithRetry({
      model,
      contents: prompt,
      config: {
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
              docTypes: { type: Type.ARRAY, items: { type: Type.STRING } },
              subjects: { type: Type.ARRAY, items: { type: Type.STRING } },
              languages: { type: Type.ARRAY, items: { type: Type.STRING } },
              originalDate: { type: Type.STRING },
              standardizedDate: { type: Type.STRING },
              senders: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT, 
                  properties: { 
                    name: { type: Type.STRING }, 
                    role: { type: Type.STRING },
                    organizationCategory: { type: Type.STRING },
                    nationality: { type: Type.STRING }
                  },
                  required: ["name"]
                } 
              },
              recipients: { 
                type: Type.ARRAY, 
                items: { 
                  type: Type.OBJECT, 
                  properties: { 
                    name: { type: Type.STRING }, 
                    role: { type: Type.STRING },
                    organizationCategory: { type: Type.STRING },
                    nationality: { type: Type.STRING }
                  },
                  required: ["name"]
                } 
              },
              entities: { 
                type: Type.OBJECT, 
                properties: { 
                  people: { 
                    type: Type.ARRAY, 
                    items: { 
                        type: Type.OBJECT,
                        properties: {
                            name: { type: Type.STRING },
                            organizationCategory: { type: Type.STRING },
                            nationality: { type: Type.STRING }
                        }
                    }
                  }, 
                  organizations: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING } } } }, 
                  prisons: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING } } } }, 
                  roles: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING } } } } 
                },
                required: ["people", "organizations", "roles", "prisons"]
              }
            },
            required: ["title", "pageIds", "senders", "recipients"]
          }
        }
      }
    });
    
    const clusters = salvageJSONList(response.text || "[]");
    return clusters.map((c, idx) => ({
      ...c,
      id: c.id || idx + 1,
      docTypes: (c.docTypes || []).map((name: string) => findDocTypeByName(name)).filter(Boolean),
      senders: (c.senders || []).map((s: any) => ({ ...s, id: matchInVocabulary(s.name) })),
      recipients: (c.recipients || []).map((r: any) => ({ ...r, id: matchInVocabulary(r.name) })),
      entities: {
        people: (c.entities?.people || []).map((p: any) => ({ ...p, name: String(p.name), id: matchInVocabulary(String(p.name)) })),
        organizations: (c.entities?.organizations || []).map((o: any) => ({ ...o, name: String(o.name), id: matchInVocabulary(String(o.name)) })),
        prisons: (c.entities?.prisons || []).map((p: any) => ({ ...p, name: String(p.name), id: matchInVocabulary(String(p.name)) })),
        roles: (c.entities?.roles || []).map((r: any) => ({ ...r, name: String(r.name), id: matchInVocabulary(String(r.name)) })),
      }
    }));
  };

  try { return await runClustering(modelName); } 
  catch (e) { if (modelName === "gemini-3-pro-preview") return await runClustering("gemini-3-flash-preview"); throw e; }
};
