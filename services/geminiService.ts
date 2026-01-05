
import { GoogleGenAI, Type } from "@google/genai";
import { ArchivalPage, Cluster, Tier } from "../types";
import { CONTROLLED_VOCABULARY, SUBJECTS_LIST } from "./vocabulary";

const PRISON_LIST = [
  "Abu Kabir Lock-up", "Athlit Clearance Camp", "Athlit Detention Camp", "Bethlehem Detention Camp (Villa Salem)",
  "Boys' Reformatory School, Bethlehem", "Boys' Reformatory School, Rishon", "Boys' Reformatory School, Tulkarem",
  "Boys' Remand Home Jerusalem", "Carthaga Detention Camp, Sudan", "Central Prison Nablus", "Central Prison, Acre",
  "Central Prison, Jerusalem", "Cyprus detention camp", "Gilgil Detention Camp, Kenya", "Girls' Home", "Haifa Lock-up",
  "Jaffa Lock-up", "Jail Labour Co. No. 1 Nur Esh Shams", "Jail Labour Co. No. 2, Athlit", "Jenin Lock-up",
  "Jerusalem Lock-up", "Latrun Detention Camp", "Malka Flinka", "Mazra'a Detention Camp", "Nablus Prison",
  "Other Prisons", "Qulqilya Lock-up", "Rafah Detention Camp", "Ramleh Lock-up", "Sarafand Detention Camp",
  "Sarona Internment Camp", "Sembel Detention Camp, Asmara, Eritrea", "Tel Aviv Lock-up", "Tulkarem Lock-up",
  "Unknown", "Wilhelma-Hamîdije Internment Camp", "Women's Prison, Bethlehem"
];

// Correctly initialize GoogleGenAI once with process.env.API_KEY as per guidelines
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

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

  if (rotation !== 0) {
     return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(file);
        img.onload = () => {
           let canvas = document.createElement('canvas');
           canvas.width = img.width; canvas.height = img.height;
           const ctx = canvas.getContext('2d');
           if(ctx) {
             ctx.drawImage(img, 0, 0);
             canvas = rotateCanvas(canvas, rotation);
             const dataUrl = canvas.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg');
             resolve({ inlineData: { data: dataUrl.split(',')[1], mimeType: file.type === 'image/png' ? 'image/png' : 'image/jpeg' } });
           } else { reject(new Error("Canvas context failed")); }
           URL.revokeObjectURL(url);
        };
        img.onerror = reject;
        img.src = url;
     });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve({ inlineData: { data: base64String, mimeType: file.type } });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

const generateContentWithRetry = async (params: any, retries = 3): Promise<any> => {
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

const safeParseTranscriptionJSON = (jsonString: string): any => {
  const repaired = repairTruncatedJSON(jsonString);
  try {
    return JSON.parse(repaired);
  } catch (e) {
    console.warn("Standard JSON parse failed, attempting regex salvage...", e);
    const transMatch = repaired.match(/"transcription"\s*:\s*"([\s\S]*?)"(?=\s*[,}]) /);
    const translationMatch = repaired.match(/"translation"\s*:\s*"([\s\S]*?)"(?=\s*[,}]) /);
    const confidenceMatch = repaired.match(/"confidenceScore"\s*:\s*(\d+)/);
    if (transMatch) {
      return {
        transcription: transMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'),
        translation: translationMatch ? translationMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : "",
        confidenceScore: confidenceMatch ? parseInt(confidenceMatch[1]) : 3
      };
    }
    throw e;
  }
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
  return match?.id;
};

export const analyzePageContent = async (page: ArchivalPage, tier: 'FREE' | 'PAID'): Promise<Partial<ArchivalPage>> => {
  try {
    const imagePart = await fileToGenerativePart(page.fileObj, page.rotation || 0);
    const prompt = `Analyze this archival document page. 1. Identify language(s). 2. Identify production mode (print, photo, handwriting, typewriting). 3. Check for Hebrew handwriting specifically.`;
    const response = await generateContentWithRetry({
      model: "gemini-3-flash-preview",
      // Corrected: pass imagePart directly as part of contents array
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
    // response.text is a getter property, not a method
    const result = JSON.parse(repairTruncatedJSON(response.text || "{}"));
    return { ...result, status: 'analyzed' };
  } catch (error) { return { status: 'error', error: "Analysis failed" }; }
};

export const transcribeAndTranslatePage = async (page: ArchivalPage, tier: 'FREE' | 'PAID'): Promise<Partial<ArchivalPage>> => {
  try {
    const imagePart = await fileToGenerativePart(page.fileObj, page.rotation || 0);
    let prompt = `Transcribe this archival document exactly. Detect language, preserve layout, and score confidence 1-5. 
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
            confidenceScore: { type: Type.INTEGER }
          } 
        } 
      }
    });
    
    // response.text is a property
    const result = safeParseTranscriptionJSON(response.text || "{}");

    return { 
      generatedTranscription: result.transcription || "", 
      generatedTranslation: result.translation || "", 
      confidenceScore: result.confidenceScore || 3, 
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
  
  const vocabSummary = CONTROLLED_VOCABULARY.map(v => `${v.name}`).join('|');

  const prompt = `
    TASK 1: CLUSTERING
    Group these archival pages into logical discrete documents (Clusters). 
    A cluster MUST represent exactly ONE physical document.
    SPLIT ON DATE CHANGE: Different dates mean different clusters.

    TASK 2: ENTITY EXTRACTION
    For EACH cluster, extract all People, Organizations, and Roles mentioned in the text.
    THIS IS MANDATORY. Even if a name is not in the vocabulary, extract it.
    
    REFERENCE VOCABULARY (Check against this first): [${vocabSummary.slice(0, 40000)}]
    PRISON LIST: ${PRISON_LIST.join('|')}
    SUBJECTS: ${SUBJECTS_LIST.join('|')}
    
    Input Data (Pages and Transcriptions):
    ${JSON.stringify(inputData)}
    
    Return a JSON array of Clusters. Ensure the 'entities' field is fully populated for every cluster.
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
              senders: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, role: { type: Type.STRING } } } },
              recipients: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, role: { type: Type.STRING } } } },
              entities: { 
                type: Type.OBJECT, 
                properties: { 
                  people: { type: Type.ARRAY, items: { type: Type.STRING } }, 
                  organizations: { type: Type.ARRAY, items: { type: Type.STRING } }, 
                  roles: { type: Type.ARRAY, items: { type: Type.STRING } } 
                },
                required: ["people", "organizations", "roles"]
              }
            },
            required: ["id", "title", "pageIds", "entities"]
          }
        }
      }
    });
    // response.text is a property
    const clusters = salvageJSONList(response.text || "[]");
    return clusters.map(c => ({
      ...c,
      senders: (c.senders || []).map((s: any) => ({ ...s, id: matchInVocabulary(s.name) })),
      recipients: (c.recipients || []).map((r: any) => ({ ...r, id: matchInVocabulary(r.name) })),
      entities: {
        people: (c.entities?.people || []).map((name: string) => ({ name: String(name), id: matchInVocabulary(String(name)) })),
        organizations: (c.entities?.organizations || []).map((name: string) => ({ name: String(name), id: matchInVocabulary(String(name)) })),
        roles: (c.entities?.roles || []).map((name: string) => ({ name: String(name), id: matchInVocabulary(String(name)) })),
      }
    }));
  };

  try { return await runClustering(modelName); } 
  catch (e) { if (modelName === "gemini-3-pro-preview") return await runClustering("gemini-3-flash-preview"); throw e; }
};