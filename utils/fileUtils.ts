
import { ArchivalPage, Cluster, AppState } from "../types";

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
    "Doc Types",
    "Subjects",
    "Sender",
    "Recipient",
    "Prison Name",
    "Languages",
    "People Mentioned",
    "Organizations Mentioned"
  ];
  
  const rows = clusters.map(c => [
    c.id.toString(),
    c.title,
    c.pageRange,
    `"${c.summary.replace(/"/g, '""').replace(/\n/g, ' ')}"`,
    c.originalDate || "",
    c.standardizedDate || "",
    (c.docTypes || []).join(", "),
    (c.subjects || []).join(", "),
    (c.senders || []).map(s => s.name).join(", "),
    (c.recipients || []).map(r => r.name).join(", "),
    c.prisonName || "",
    (c.languages || []).join(", "),
    `"${(c.entities?.people || []).map(p => p.name).join(', ')}"`,
    `"${(c.entities?.organizations || []).map(o => o.name).join(', ')}"`
  ]);
  
  return [headers.join("\t"), ...rows.map(r => r.join("\t"))].join("\n");
};

export const generateFullJSON = (
  projectTitle: string, 
  archiveName: string,
  tier: string,
  pageRange: { start: number, end: number } | null,
  files: ArchivalPage[], 
  clusters: Cluster[]
): string => {
  const exportData = {
    projectTitle,
    archiveName,
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
      rotation: p.rotation,
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

export const generateProjectBackup = (
  state: AppState,
  projectTitle: string,
  archiveName: string,
  pageRange: { start: number, end: number } | null
): string => {
  const serializableFiles = state.files.map(({ fileObj, previewUrl, ...rest }) => rest);

  const backupData = {
    meta: {
      type: 'ARCHIVAL_LENS_BACKUP',
      version: 1,
      createdAt: new Date().toISOString(),
      projectTitle,
      archiveName,
    },
    appState: {
      ...state,
      files: serializableFiles,
      uiState: state.uiState === 'config' ? 'dashboard' : state.uiState
    },
    pageRange
  };

  return JSON.stringify(backupData, null, 2);
};

export const generateProjectZip = async (
  state: AppState,
  projectTitle: string,
  archiveName: string,
  pageRange: { start: number, end: number } | null
): Promise<Blob> => {
  // @ts-ignore
  const zip = new JSZip();
  const folder = zip.folder(projectTitle.replace(/[^a-z0-9]/gi, '_'));
  
  // Add the JSON backup
  const jsonBackup = generateProjectBackup(state, projectTitle, archiveName, pageRange);
  folder.file('project_metadata.json', jsonBackup);
  
  // Add images
  const imagesFolder = folder.folder('images');
  for (const page of state.files) {
    if (page.fileObj) {
      imagesFolder.file(page.fileName, page.fileObj);
    }
  }
  
  return await zip.generateAsync({ type: 'blob' });
};

export const downloadFile = (content: string | Blob, filename: string, mimeType: string) => {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
