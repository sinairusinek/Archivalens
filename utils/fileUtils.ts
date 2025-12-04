import { ArchivalPage, Cluster } from "../types";

export const generateTSV = (pages: ArchivalPage[]): string => {
  const headers = [
    "Index Name",
    "Original File",
    "Language",
    "Production Mode",
    "Hebrew Handwriting?",
    "Transcription",
    "Translation"
  ];

  const rows = pages.map(p => [
    p.indexName,
    p.fileName,
    p.language || "",
    p.productionMode || "",
    p.hasHebrewHandwriting ? "YES" : "NO",
    `"${(p.generatedTranscription || p.manualTranscription || "").replace(/"/g, '""').replace(/\n/g, ' ')}"`,
    `"${(p.generatedTranslation || "").replace(/"/g, '""').replace(/\n/g, ' ')}"`
  ]);

  return [headers.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
};

export const generateClustersTSV = (clusters: Cluster[]): string => {
  const headers = [
    "Cluster ID", 
    "Title", 
    "Page Range", 
    "Summary",
    "Original Date",
    "Date (YYYY-MM-DD)",
    "Sender",
    "Recipient",
    "Prison Name",
    "Languages",
    "People Mentioned",
    "Places Mentioned",
    "Organizations Mentioned"
  ];
  
  const rows = clusters.map(c => [
    c.id.toString(),
    c.title,
    c.pageRange,
    `"${c.summary.replace(/"/g, '""').replace(/\n/g, ' ')}"`,
    c.originalDate || "",
    c.standardizedDate || "",
    c.sender || "",
    c.recipient || "",
    c.prisonName || "",
    (c.languages || []).join(", "),
    `"${(c.entities?.people || []).join(', ')}"`,
    `"${(c.entities?.places || []).join(', ')}"`,
    `"${(c.entities?.organizations || []).join(', ')}"`
  ]);
  
  return [headers.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
};

export const generateFullJSON = (
  projectTitle: string, 
  tier: string,
  pageRange: { start: number, end: number } | null,
  files: ArchivalPage[], 
  clusters: Cluster[]
): string => {
  const exportData = {
    projectTitle,
    tier,
    pageRange,
    exportedAt: new Date().toISOString(),
    stats: {
      totalPages: files.length,
      totalClusters: clusters.length
    },
    pages: files.map(p => ({
      id: p.id,
      indexName: p.indexName,
      fileName: p.fileName,
      language: p.language,
      productionMode: p.productionMode,
      hasHebrewHandwriting: p.hasHebrewHandwriting,
      transcription: p.manualTranscription || p.generatedTranscription,
      translation: p.generatedTranslation,
      description: p.manualDescription
    })),
    clusters: clusters
  };
  
  return JSON.stringify(exportData, null, 2);
};

export const downloadFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};