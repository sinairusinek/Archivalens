
export enum AnalysisMode {
  PDF = 'PDF',
  FOLDER = 'FOLDER',
  DRIVE = 'DRIVE',
}

export enum Tier {
  FREE = 'FREE',
  PAID = 'PAID',
}

export interface ProcessingStatus {
  total: number;
  processed: number;
  currentStep: string;
  isComplete: boolean;
}

export interface NamedEntities {
  people: string[];
  places: string[];
  organizations: string[];
}

export interface ArchivalPage {
  id: string; // unique ID
  fileName: string; // Original filename
  indexName: string; // The display name (Folder Name + Image Name or PDF Name + Page #)
  fileObj: File;
  previewUrl: string; // Object URL for thumbnail
  
  // Step C Data
  language?: string;
  productionMode?: string;
  hasHebrewHandwriting?: boolean;
  
  // Step E Human Entry / Flags
  manualTranscription?: string;
  manualDescription?: string;
  shouldTranscribe: boolean;
  shouldTranslate: boolean;
  shouldDownloadImage: boolean;
  
  // Step F Data
  generatedTranscription?: string;
  generatedTranslation?: string; // To English
  
  // Processing States
  status: 'pending' | 'analyzing' | 'analyzed' | 'transcribing' | 'done' | 'error';
  error?: string;
}

export interface Cluster {
  id: number;
  title: string;
  pageRange: string;
  summary: string;
  pageIds: string[];
  
  // Detailed Metadata
  prisonName?: string;
  languages?: string[];
  originalDate?: string;
  standardizedDate?: string; // yyyy-mm-dd
  sender?: string; // name | role
  recipient?: string; // name | role
  
  // Aggregated Entities
  entities?: NamedEntities;
}

export interface AppState {
  apiKey: string | null;
  mode: AnalysisMode | null;
  tier: Tier;
  files: ArchivalPage[];
  clusters: Cluster[];
  processingStatus: ProcessingStatus;
  uiState: 'welcome' | 'config' | 'dashboard' | 'clustering';
}
