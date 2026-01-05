import React, { useState, useEffect, useMemo } from 'react';
import { 
  FolderOpen, FileText, Settings, Play, Download, CheckCircle, Loader2, Maximize2, X, Flag, CheckSquare, Square, Info, 
  Languages, FileUp, Edit3, Bot, ZoomIn, ZoomOut, Type, MapPin, Users, Building, Calendar, Mail, User, Filter, Cloud, Code, 
  LayoutGrid, Save, FileJson, RotateCw, RotateCcw, Library, AlertTriangle, Upload, ChevronDown, Hash, ListChecks, ArrowRightLeft,
  Search, ExternalLink, Globe, UserCheck, Tag, FileOutput, Package, Briefcase, Sparkles, Bookmark, CloudUpload, Clock, Trash2,
  ChevronRight, PanelLeft, StickyNote, Activity, PieChart, Database, ListFilter, Briefcase as RoleIcon, Plus, Link as LinkIcon, Link2Off,
  FileSpreadsheet, ShieldCheck, Star, Fingerprint, History, Check, UserMinus, UserPlus, Save as SaveIcon, BookOpen, Layers,
  ChevronDown as ChevronDownIcon, FileSearch, GraduationCap, FlagTriangleLeft, HandMetal, Heart, Landmark
} from 'lucide-react';
import { ArchivalPage, AppState, AnalysisMode, Tier, ProcessingStatus, Cluster, Correspondent, EntityReference, NamedEntities, ReconciliationRecord, SourceAppearance } from '../types';
import { analyzePageContent, transcribeAndTranslatePage, clusterPages } from '../services/geminiService';
import { listFilesFromDrive, fetchFileFromDrive, uploadFileToDrive } from '../services/googleDriveService';
import { generateTSV, generateClustersTSV, generateVocabularyCSV, generateMasterVocabularyCSV, generateFullJSON, generateProjectBackup, generateProjectZip, downloadFile } from '../utils/fileUtils';
import { CONTROLLED_VOCABULARY, SUBJECTS_LIST } from '../services/vocabulary';

const PRESET_ARCHIVES = [
  "CAHJP - Central Archives for the History of the Jewish People (Magnes)",
  "CZA - Central Zionist Archive",
  "HA - Haganah Archives",
  "HMA - Haifa Municipality Archives",
  "IPA - Israeli Press Archive",
  "ISA - Israel State Archives",
  "JIA - Jabotinsky Institute Archives",
  "JMA - Jerusalem Municipal Archives",
  "Press",
  "TAMA - Tel Aviv Municipal Archives"
];

const INITIAL_STATE: AppState = {
  apiKey: process.env.API_KEY || null,
  mode: null,
  tier: Tier.FREE,
  files: [],
  clusters: [],
  reconciliationList: [],
  masterVocabulary: CONTROLLED_VOCABULARY as EntityReference[],
  processingStatus: { total: 0, processed: 0, currentStep: 'idle', isComplete: false },
  uiState: 'welcome',
  archiveName: "",
};

const getTextDirection = (text: string | undefined): 'rtl' | 'ltr' => {
  if (!text) return 'ltr';
  return /[\u0590-\u05FF]/.test(text) ? 'rtl' : 'ltr';
};

export const App: React.FC = () => {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [pageRange, setPageRange] = useState<{start: number, end: number} | null>(null);
  const [useRange, setUseRange] = useState(false);
  const [rangeStart, setRangeStart] = useState(1);
  const [rangeEnd, setRangeEnd] = useState(1);

  const [zoomedPageId, setZoomedPageId] = useState<string | null>(null);
  const [projectTitle, setProjectTitle] = useState<string>("Archival Project");
  const [archiveName, setArchiveName] = useState<string>("");
  const [expandedField, setExpandedField] = useState<{ pageId: string, field: 'manualTranscription' | 'manualDescription' | 'generatedTranslation', label: string } | null>(null);
  const [editingClusterId, setEditingClusterId] = useState<number | null>(null);
  
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [filterLanguage, setFilterLanguage] = useState<string>("All");
  const [filterProductionMode, setFilterProductionMode] = useState<string>("All");
  const [filterHandwriting, setFilterHandwriting] = useState<boolean | null>(null);
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isZipping, setIsZipping] = useState(false);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);

  // Research Index States
  const [indexSubTab, setIndexSubTab] = useState<'project' | 'master'>('project');
  const [recSearch, setRecSearch] = useState("");
  const [vocabSearch, setVocabSearch] = useState("");
  const [activeRecId, setActiveRecId] = useState<string | null>(null);
  const [activeMasterId, setActiveMasterId] = useState<number | null>(null);
  const [recFilterType, setRecFilterType] = useState<'all' | 'person' | 'organization' | 'role'>('all');
  const [isEditingEntityName, setIsEditingEntityName] = useState(false);
  const [tempEntityName, setTempEntityName] = useState("");
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);

  const resolveEntity = (name: string): EntityReference => {
    const low = name.toLowerCase().trim();
    const match = state.masterVocabulary.find(v => v.name.toLowerCase() === low);
    return { name, id: match?.id };
  };

  const vocabularySets = useMemo(() => {
    const people = new Set<string>();
    const roles = new Set<string>();
    const orgs = new Set<string>();
    const subjects = new Set<string>();
    state.masterVocabulary.forEach(item => {
      if (item.type === 'person') people.add(item.name.toLowerCase());
      if (item.type === 'role') roles.add(item.name.toLowerCase());
      if (item.type === 'organization') orgs.add(item.name.toLowerCase());
    });
    SUBJECTS_LIST.forEach(s => subjects.add(s.toLowerCase()));
    return { people, roles, orgs, subjects };
  }, [state.masterVocabulary]);

  // Fix: Added isNameInVocabulary to check against pre-processed sets
  const isNameInVocabulary = (name: string, category: string): boolean => {
    const lowName = name.toLowerCase().trim();
    if (category === 'people') return vocabularySets.people.has(lowName);
    if (category === 'roles') return vocabularySets.roles.has(lowName);
    if (category === 'orgs') return vocabularySets.orgs.has(lowName);
    if (category === 'subjects') return vocabularySets.subjects.has(lowName);
    return false;
  };

  const filteredPages = useMemo(() => {
    return state.files.filter(f => {
      const matchesSearch = searchTerm === "" || 
        f.indexName.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (f.generatedTranscription || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (f.manualTranscription || "").toLowerCase().includes(searchTerm.toLowerCase());
      const matchesLanguage = filterLanguage === "All" || f.language === filterLanguage;
      const matchesMode = filterProductionMode === "All" || f.productionMode === filterProductionMode;
      const matchesHandwriting = filterHandwriting === null || f.hasHebrewHandwriting === filterHandwriting;
      return matchesSearch && matchesLanguage && matchesMode && matchesHandwriting;
    });
  }, [state.files, searchTerm, filterLanguage, filterProductionMode, filterHandwriting]);

  const syncReconciliation = () => {
    const uniqueMap = new Map<string, ReconciliationRecord>();
    const existingMap = new Map<string, ReconciliationRecord>();
    state.reconciliationList.forEach(r => existingMap.set(`${r.type}:${r.extractedName.toLowerCase()}`, r));

    const add = (name: string, type: 'person' | 'organization' | 'role', source: string) => {
      if (!name) return;
      const key = `${type}:${name.toLowerCase()}`;
      if (uniqueMap.has(key)) {
        const existing = uniqueMap.get(key)!;
        if (!existing.sourceAppearances.find(s => s.id === source)) {
          existing.sourceAppearances.push({ id: source, note: "" });
        }
      } else {
        const vocabMatch = resolveEntity(name);
        const prev = existingMap.get(key);
        uniqueMap.set(key, {
          id: prev?.id || crypto.randomUUID(),
          extractedName: name,
          type,
          matchedId: vocabMatch.id,
          matchedName: vocabMatch.id ? state.masterVocabulary.find(v => v.id === vocabMatch.id)?.name : undefined,
          status: vocabMatch.id ? 'matched' : (prev?.status || 'pending'),
          sourceAppearances: prev?.sourceAppearances && prev.sourceAppearances.length > 0 ? prev.sourceAppearances : [{ id: source, note: "" }],
          addedAt: prev?.addedAt
        });
      }
    };

    state.clusters.forEach(c => {
      c.entities?.people?.forEach(p => add(p.name, 'person', `Doc #${c.id}`));
      c.entities?.organizations?.forEach(o => add(o.name, 'organization', `Doc #${c.id}`));
      c.entities?.roles?.forEach(r => add(r.name, 'role', `Doc #${c.id}`));
      c.senders?.forEach(s => add(s.name, 'person', `Doc #${c.id}`));
      c.recipients?.forEach(r => add(r.name, 'person', `Doc #${c.id}`));
    });

    state.files.forEach(f => {
      f.entities?.people?.forEach(p => add(p.name, 'person', f.indexName));
      f.entities?.organizations?.forEach(o => add(o.name, 'organization', f.indexName));
      f.entities?.roles?.forEach(r => add(r.name, 'role', f.indexName));
    });

    setState(s => ({ ...s, reconciliationList: Array.from(uniqueMap.values()) }));
  };

  const updateSourceNote = (recId: string, sourceId: string, note: string) => {
    setState(s => ({
      ...s,
      reconciliationList: s.reconciliationList.map(r => 
        r.id === recId ? { 
          ...r, 
          sourceAppearances: r.sourceAppearances.map(sa => sa.id === sourceId ? { ...sa, note } : sa) 
        } : r
      )
    }));
  };

  const getMatchingPages = (clusterId: number, entityName: string): ArchivalPage[] => {
    const cluster = state.clusters.find(c => c.id === clusterId);
    if (!cluster) return [];
    const lowName = entityName.toLowerCase();
    return state.files.filter(f => 
      cluster.pageIds.includes(f.id) && 
      (f.manualTranscription?.toLowerCase().includes(lowName) || f.generatedTranscription?.toLowerCase().includes(lowName))
    );
  };

  // Fix: Moved restoreProjectFromBlob up to be available for loadFromDrive
  const restoreProjectFromBlob = async (blob: Blob) => {
    // @ts-ignore
    const zip = await JSZip.loadAsync(blob);
    const jsonFile = Object.keys(zip.files).find(name => name.endsWith('project_metadata.json'));
    if (!jsonFile) throw new Error("Metadata not found in zip.");
    const jsonStr = await zip.files[jsonFile].async('string');
    const j = JSON.parse(jsonStr);
    const restoredFiles: ArchivalPage[] = [];
    for (const savedFile of j.appState.files) {
      const zipImagePath = Object.keys(zip.files).find(name => name.endsWith(savedFile.fileName));
      if (zipImagePath) {
        const b = await zip.files[zipImagePath].async('blob');
        const fileObj = new File([b], savedFile.fileName, { type: b.type });
        restoredFiles.push({ ...savedFile, fileObj, previewUrl: URL.createObjectURL(fileObj) });
      } else {
        restoredFiles.push({ ...savedFile, previewUrl: "https://via.placeholder.com/150?text=Missing" });
      }
    }
    setState({ ...INITIAL_STATE, ...j.appState, files: restoredFiles, uiState: 'dashboard' });
    setProjectTitle(j.meta?.projectTitle || "Restored Project");
    if (j.meta?.archiveName) setArchiveName(j.meta.archiveName);
  };

  // Fix: Added loadFromDrive to handle Google Drive integration
  const loadFromDrive = async () => {
    setIsProcessingFiles(true);
    try {
      const files = await listFilesFromDrive();
      if (files.length === 0) {
        alert("No project files found on Google Drive.");
        return;
      }
      // Simple selection logic for the exercise - usually would use a modal
      const selectedFile = files[0]; 
      const confirmed = window.confirm(`Load latest project from Drive: ${selectedFile.name}?`);
      if (confirmed) {
        const blob = await fetchFileFromDrive(selectedFile.id);
        await restoreProjectFromBlob(blob);
      }
    } catch (err: any) {
      alert("Drive load failed: " + err.message);
    } finally {
      setIsProcessingFiles(false);
    }
  };

  // Fix: Added saveToDrive to handle saving project to Google Drive
  const saveToDrive = async () => {
    setIsUploadingToDrive(true);
    try {
      const zipBlob = await generateProjectZip(state, projectTitle, archiveName || "", pageRange);
      const fileName = `${projectTitle.replace(/[^a-z0-9]/gi, '_')}.aln_project.zip`;
      await uploadFileToDrive(zipBlob, fileName);
      alert("Project successfully saved to Google Drive!");
    } catch (err: any) {
      alert("Drive save failed: " + err.message);
    } finally {
      setIsUploadingToDrive(false);
    }
  };

  const renderBadge = (item: EntityReference | string | undefined, category: string) => {
    const name = typeof item === 'string' ? item : item?.name;
    const id = typeof item === 'string' ? undefined : item?.id;
    if (!name) return null;
    const isLinked = id !== undefined || isNameInVocabulary(name, category);
    const colors: Record<string, string> = { people: 'blue', roles: 'orange', orgs: 'purple', subjects: 'indigo', mixed: 'slate' };
    const baseColor = colors[category] || 'slate';
    if (category === 'subjects' && isLinked) {
      return (
        <span key={name} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black transition-all bg-indigo-600 text-white border border-indigo-700 shadow-sm uppercase tracking-tighter">
          <Bookmark className="w-2.5 h-2.5" /> {name}
        </span>
      );
    }
    return (
      <span key={name} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold border transition-all ${!isLinked ? `bg-yellow-50 text-yellow-800 border-yellow-300 shadow-sm` : `bg-${baseColor}-50 text-${baseColor}-700 border-${baseColor}-100`}`}>
        {!isLinked && <Sparkles className="w-2.5 h-2.5" />} 
        {name}
        {id && <span className="ml-1 opacity-40 font-mono text-[8px]">#{id}</span>}
      </span>
    );
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: AnalysisMode) => {
    if (!e.target.files?.length) return;
    setIsProcessingFiles(true);
    const fileList = Array.from(e.target.files) as File[];
    let processedPages: { file: File, fileName: string, indexName: string }[] = [];
    let derivedTitle = "Project Analysis";
    if (mode === AnalysisMode.PDF || mode === AnalysisMode.BATCH_PDF) {
      for (const pdf of fileList) {
        const pdfTitle = pdf.name.replace(/\.[^/.]+$/, "");
        if (fileList.length === 1) derivedTitle = pdfTitle;
        const images = await processPdf(pdf);
        processedPages.push(...images.map((img, i) => ({ file: img, fileName: img.name, indexName: `${pdfTitle} - Pg ${i + 1}` })));
      }
    } else {
      fileList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      derivedTitle = ((fileList[0] as any).webkitRelativePath?.split('/')[0]) || fileList[0].name.replace(/\.[^/.]+$/, "");
      processedPages = fileList.map(f => ({ file: f, fileName: f.name, indexName: `${derivedTitle} - ${f.name}` }));
    }
    const newFiles = await Promise.all(processedPages.map(async (p) => ({
      id: crypto.randomUUID(), fileName: p.fileName, indexName: p.indexName, fileObj: p.file, previewUrl: URL.createObjectURL(p.file),
      shouldTranscribe: false, shouldTranslate: false, status: 'pending', shouldDownloadImage: false, rotation: 0,
    } as ArchivalPage)));
    setState(s => ({ ...s, mode, files: newFiles, uiState: 'config' }));
    setProjectTitle(derivedTitle);
    setRangeStart(1);
    setRangeEnd(newFiles.length);
    setIsProcessingFiles(false);
  };

  const renderWelcome = () => (
    <div className="flex-1 flex flex-col items-center justify-center p-8 bg-white text-slate-900 overflow-y-auto">
      <div className="max-w-4xl w-full text-center space-y-12">
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-blue-50 text-blue-600 rounded-full text-xs font-black uppercase tracking-widest border border-blue-100"><Sparkles className="w-4 h-4" /> Powered by Gemini 3</div>
          <h1 className="text-8xl font-black italic tracking-tighter uppercase leading-[0.8] text-transparent bg-clip-text bg-gradient-to-br from-slate-900 via-slate-800 to-slate-500">Archival<br />Lens</h1>
          <p className="text-xl text-slate-500 font-medium max-w-2xl mx-auto italic">Advanced AI-driven processing for mandate-era archival collections. Transcribe, translate, and cluster historical documents at scale.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="group relative bg-white border border-slate-200 rounded-[48px] p-10 hover:border-blue-500 hover:shadow-2xl hover:shadow-blue-500/10 transition-all cursor-pointer">
            <input type="file" multiple {...({webkitdirectory: "", mozdirectory: ""} as any)} className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={e => handleFileUpload(e, AnalysisMode.FOLDER)} />
            <div className="w-16 h-16 bg-blue-500 rounded-3xl flex items-center justify-center mx-auto mb-6 transition-transform group-hover:scale-110 shadow-lg group-hover:shadow-blue-500/20"><FolderOpen className="w-8 h-8 text-white" /></div>
            <h3 className="text-2xl font-black uppercase italic tracking-tight text-slate-800">Process Folder</h3>
            <p className="text-slate-400 text-sm font-bold uppercase tracking-widest">Local Images or TIFFs</p>
          </div>
          <div className="group relative bg-white border border-slate-200 rounded-[48px] p-10 hover:border-emerald-500 hover:shadow-2xl hover:shadow-emerald-500/10 transition-all cursor-pointer">
            <input type="file" multiple accept=".pdf" className="absolute inset-0 opacity-0 cursor-pointer z-10" onChange={e => handleFileUpload(e, AnalysisMode.BATCH_PDF)} />
            <div className="w-16 h-16 bg-emerald-500 rounded-3xl flex items-center justify-center mx-auto mb-6 transition-transform group-hover:scale-110 shadow-lg group-hover:shadow-emerald-500/20"><FileText className="w-8 h-8 text-white" /></div>
            <h3 className="text-2xl font-black uppercase italic tracking-tight text-slate-800">Process PDFs</h3>
            <p className="text-slate-400 text-sm font-bold uppercase tracking-widest">Multi-page analysis</p>
          </div>
        </div>
        <div className="flex items-center justify-center gap-12 pt-8 border-t border-slate-100">
           <label className="flex items-center gap-3 cursor-pointer group">
              <input type="file" accept=".zip,.json" className="hidden" onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setIsProcessingFiles(true);
                try {
                  if (file.name.endsWith('.zip')) { await restoreProjectFromBlob(file); } 
                  else { const text = await file.text(); const j = JSON.parse(text); setState({ ...INITIAL_STATE, ...j.appState, uiState: 'dashboard' }); setProjectTitle(j.meta?.projectTitle || "Restored Project"); }
                } catch (err: any) { alert("Restore failed: " + err.message); } finally { setIsProcessingFiles(false); }
              }} />
              <div className="p-3 bg-slate-50 rounded-2xl group-hover:bg-blue-50 transition-colors border border-slate-100 group-hover:border-blue-100"><CloudUpload className="w-5 h-5 text-slate-400 group-hover:text-blue-500" /></div>
              <div className="text-left">
                <div className="text-xs font-black uppercase tracking-widest text-slate-800">Resume Local</div>
                <div className="text-[10px] font-bold text-slate-400 uppercase">Load .aln backup</div>
              </div>
           </label>
           <button onClick={loadFromDrive} className="flex items-center gap-3 group">
              <div className="p-3 bg-slate-50 rounded-2xl group-hover:bg-emerald-50 transition-colors border border-slate-100 group-hover:border-emerald-100"><Cloud className="w-5 h-5 text-slate-400 group-hover:text-emerald-500" /></div>
              <div className="text-left">
                <div className="text-xs font-black uppercase tracking-widest text-slate-800">Resume Drive</div>
                <div className="text-[10px] font-bold text-slate-400 uppercase">Import from Google</div>
              </div>
           </button>
        </div>
      </div>
      {isProcessingFiles && <div className="fixed inset-0 bg-white/80 flex items-center justify-center z-[100] backdrop-blur-md flex-col gap-4 text-slate-900"><Loader2 className="w-12 h-12 text-blue-500 animate-spin" /><span className="font-black uppercase tracking-widest text-blue-600">Reconstructing Research...</span></div>}
    </div>
  );

  const renderCommonHeader = (actions?: React.ReactNode) => (
    <header className="bg-white border-b px-8 py-4 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-6">
        <div className="flex bg-slate-100 p-1 rounded-xl">
          {['dashboard', 'clustering', 'entities'].map((view: any) => (
            <button key={view} onClick={() => setState(s => ({ ...s, uiState: view }))} className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-tight flex items-center gap-1.5 ${state.uiState === view ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
              {view === 'dashboard' && <LayoutGrid className="w-3.5 h-3.5" />}
              {view === 'clustering' && <Library className="w-3.5 h-3.5" />}
              {view === 'entities' && <Users className="w-3.5 h-3.5" />}
              {view === 'entities' ? 'Research Index' : view === 'dashboard' ? 'Pages' : 'Documents'}
            </button>
          ))}
        </div>
        {state.processingStatus.total > 0 && !state.processingStatus.isComplete && (
          <div className="flex items-center gap-3 px-4 py-1.5 bg-blue-50 border border-blue-100 rounded-xl animate-pulse">
            <Loader2 className="w-3.5 h-3.5 text-blue-600 animate-spin" />
            <div className="flex flex-col"><span className="text-[10px] font-black text-blue-600 uppercase tracking-widest">{state.processingStatus.currentStep}</span><span className="text-[9px] font-bold text-blue-400 uppercase">{state.processingStatus.processed} / {state.processingStatus.total} pages</span></div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {actions}
        <div className="h-6 w-px bg-slate-200 mx-2" />
        <div className="flex items-center gap-1 bg-slate-50 p-1 rounded-xl border border-slate-100">
            <button onClick={() => downloadFile(generateTSV(state.files), `${projectTitle}_pages.tsv`, 'text/tab-separated-values')} className="p-2 hover:bg-white hover:shadow-sm rounded-lg transition-all text-slate-500 hover:text-blue-600 group relative"><FileSpreadsheet className="w-4 h-4" /><span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Pages TSV</span></button>
            <button onClick={() => downloadFile(generateClustersTSV(state.clusters), `${projectTitle}_clusters.tsv`, 'text/tab-separated-values')} className="p-2 hover:bg-white hover:shadow-sm rounded-lg transition-all text-slate-500 hover:text-emerald-600 group relative"><LayoutGrid className="w-4 h-4" /><span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Clusters TSV</span></button>
            <button onClick={() => downloadFile(generateProjectBackup(state, projectTitle, archiveName || "", pageRange), `${projectTitle}_backup.json`, 'application/json')} className="p-2 hover:bg-white hover:shadow-sm rounded-lg transition-all text-slate-500 hover:text-orange-600 group relative"><FileJson className="w-4 h-4" /><span className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Backup JSON</span></button>
        </div>
        <button onClick={saveToDrive} disabled={isUploadingToDrive} className="p-2.5 bg-white border border-slate-200 hover:border-emerald-400 text-slate-600 hover:text-emerald-600 rounded-xl transition-all shadow-sm active:scale-95 group relative">{isUploadingToDrive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Cloud className="w-4 h-4" />}<span className="absolute top-full right-0 mt-2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Save to Drive</span></button>
        <button onClick={async () => { setIsZipping(true); try { const zipBlob = await generateProjectZip(state, projectTitle, archiveName || "", pageRange); downloadFile(zipBlob, `${projectTitle}.zip`, 'application/zip'); } finally { setIsZipping(false); } }} className="p-2.5 bg-slate-900 text-white rounded-xl transition-all shadow-xl hover:bg-blue-600 active:scale-95 group relative">{isZipping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}<span className="absolute top-full right-0 mt-2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Export Project ZIP</span></button>
      </div>
    </header>
  );

  const renderUnifiedEntities = () => {
    const projectList = state.reconciliationList.filter(r => {
      const matchesSearch = r.extractedName.toLowerCase().includes(recSearch.toLowerCase()) || (r.matchedName || "").toLowerCase().includes(recSearch.toLowerCase());
      const matchesType = recFilterType === 'all' || r.type === recFilterType;
      return matchesSearch && matchesType;
    });

    const masterList = state.masterVocabulary.filter(v => {
        const matchesSearch = v.name.toLowerCase().includes(recSearch.toLowerCase());
        const matchesType = recFilterType === 'all' || v.type === recFilterType;
        return matchesSearch && matchesType;
    });

    const activeRec = activeRecId ? state.reconciliationList.find(r => r.id === activeRecId) : null;
    const activeMaster = activeMasterId ? state.masterVocabulary.find(v => v.id === activeMasterId) : null;

    const updateRec = (id: string, updates: Partial<ReconciliationRecord>) => {
      setState(s => ({
        ...s,
        reconciliationList: s.reconciliationList.map(r => r.id === id ? { ...r, ...updates } : r)
      }));
    };

    const handleSaveEntityName = () => {
      if (indexSubTab === 'project' && activeRec && tempEntityName.trim()) {
        updateRec(activeRec.id, { extractedName: tempEntityName.trim() });
        setIsEditingEntityName(false);
      } else if (indexSubTab === 'master' && activeMaster && tempEntityName.trim()) {
        setState(s => ({
            ...s,
            masterVocabulary: s.masterVocabulary.map(v => v.id === activeMaster.id ? { ...v, name: tempEntityName.trim() } : v)
        }));
        setIsEditingEntityName(false);
      }
    };

    const vocabMatches = vocabSearch.length > 1 ? state.masterVocabulary.filter(v => 
      v.name.toLowerCase().includes(vocabSearch.toLowerCase())
    ) : [];

    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
        {renderCommonHeader(
          <div className="flex items-center gap-2">
            <button onClick={() => indexSubTab === 'project' ? downloadFile(generateVocabularyCSV(state.reconciliationList), `${projectTitle}_project_index.csv`, 'text/csv') : downloadFile(generateMasterVocabularyCSV(state.masterVocabulary), `universal_authority_file.csv`, 'text/csv')} className="px-4 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-emerald-100 transition-all flex items-center gap-2 border border-emerald-100 shadow-sm"><Download className="w-3.5 h-3.5" /> Download {indexSubTab === 'project' ? 'Project Index' : 'Authority File'}</button>
            {indexSubTab === 'project' && <button onClick={syncReconciliation} className="px-4 py-2 bg-blue-50 text-blue-600 rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-blue-100 transition-all flex items-center gap-2 border border-blue-100 shadow-sm"><RotateCw className="w-3.5 h-3.5" /> Re-Sync Index</button>}
          </div>
        )}
        <div className="flex-1 flex overflow-hidden">
          <div className="w-[400px] border-r bg-white flex flex-col shadow-lg z-10">
            <div className="p-8 border-b space-y-6">
              <div className="flex bg-slate-100 p-1.5 rounded-[18px] gap-1">
                 <button onClick={() => { setIndexSubTab('project'); setRecSearch(""); setActiveMasterId(null); }} className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-tight flex items-center justify-center gap-2 transition-all ${indexSubTab === 'project' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}><Layers className="w-3.5 h-3.5" /> Project Index</button>
                 <button onClick={() => { setIndexSubTab('master'); setRecSearch(""); setActiveRecId(null); }} className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-tight flex items-center justify-center gap-2 transition-all ${indexSubTab === 'master' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}><BookOpen className="w-3.5 h-3.5" /> Universal Vocab</button>
              </div>
              <div className="space-y-4">
                 <div className="flex bg-slate-50 p-1 rounded-xl gap-1 border border-slate-100">
                    {(['all', 'person', 'organization', 'role'] as const).map(type => (
                      <button 
                        key={type} 
                        onClick={() => setRecFilterType(type)} 
                        className={`flex-1 py-1 rounded-lg text-[8px] font-black uppercase tracking-tight transition-all ${recFilterType === type ? 'bg-white text-slate-700 shadow-sm border' : 'text-slate-400 hover:text-slate-500'}`}
                      >
                        {type}
                      </button>
                    ))}
                 </div>
                 <div className="relative">
                   <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-300" />
                   <input type="text" value={recSearch} onChange={e => setRecSearch(e.target.value)} placeholder={`Search ${indexSubTab === 'project' ? 'extracted records' : 'authority records'}...`} className="w-full bg-slate-50 border border-slate-100 rounded-2xl pl-12 pr-4 py-3 text-sm font-bold outline-none focus:ring-2 ring-blue-500/10 transition-all" />
                 </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {indexSubTab === 'project' ? (
                projectList.length > 0 ? projectList.map(rec => (
                  <button key={rec.id} onClick={() => { setActiveRecId(rec.id); setActiveMasterId(null); setIsEditingEntityName(false); setExpandedSourceId(null); }} className={`w-full p-6 border-b text-left transition-all flex items-center justify-between group ${activeRecId === rec.id ? 'bg-blue-50/50 border-l-4 border-l-blue-600' : 'hover:bg-slate-50'}`}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 mb-2">
                        <div className={`w-8 h-8 rounded-xl flex items-center justify-center shadow-sm ${rec.type === 'person' ? 'bg-blue-100 text-blue-600' : rec.type === 'organization' ? 'bg-purple-100 text-purple-600' : 'bg-orange-100 text-orange-600'}`}>
                          {rec.type === 'person' && <User className="w-4 h-4" />}
                          {rec.type === 'organization' && <Building className="w-4 h-4" />}
                          {rec.type === 'role' && <Briefcase className="w-4 h-4" />}
                        </div>
                        <span className="text-sm font-black italic text-slate-800 truncate leading-tight">{rec.extractedName}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className={`text-[9px] font-black uppercase tracking-widest flex items-center gap-1 ${rec.status === 'matched' ? 'text-emerald-600' : rec.status === 'pending' ? 'text-amber-600' : rec.status === 'rejected' ? 'text-red-600' : 'text-indigo-600'}`}>
                          {rec.status}
                        </span>
                        <span className="text-[9px] font-bold text-slate-300 uppercase tracking-tighter">{rec.sourceAppearances.length} appearances</span>
                      </div>
                    </div>
                    <ChevronRight className={`w-5 h-5 text-slate-200 transition-all ${activeRecId === rec.id ? 'translate-x-1 text-blue-400' : 'group-hover:translate-x-1 group-hover:text-slate-400'}`} />
                  </button>
                )) : <div className="p-20 text-center text-slate-300"><Search className="w-12 h-12 mx-auto mb-4 opacity-20" /><p className="text-xs font-black uppercase tracking-widest opacity-40">No records</p></div>
              ) : (
                masterList.length > 0 ? masterList.map(v => (
                    <button key={v.id} onClick={() => { setActiveMasterId(v.id!); setActiveRecId(null); setIsEditingEntityName(false); }} className={`w-full p-6 border-b text-left transition-all flex items-center justify-between group ${activeMasterId === v.id ? 'bg-slate-900 border-l-4 border-l-emerald-400 text-white' : 'hover:bg-slate-50'}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1">
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center font-black text-[10px] ${activeMasterId === v.id ? 'bg-white/10 text-emerald-400' : 'bg-slate-100 text-slate-400'}`}>{v.name[0]}</div>
                          <span className={`text-sm font-black italic truncate leading-tight ${activeMasterId === v.id ? 'text-white' : 'text-slate-800'}`}>{v.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                           <span className={`text-[8px] font-black uppercase tracking-[0.2em] ${activeMasterId === v.id ? 'text-emerald-300/60' : 'text-slate-300'}`}>{v.type}</span>
                           <span className={`text-[8px] font-mono ${activeMasterId === v.id ? 'text-white/20' : 'text-slate-200'}`}>#ID{v.id}</span>
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 transition-all ${activeMasterId === v.id ? 'translate-x-1 text-emerald-400' : 'text-slate-200 group-hover:text-slate-400 group-hover:translate-x-1'}`} />
                    </button>
                )) : <div className="p-20 text-center text-slate-300"><Search className="w-12 h-12 mx-auto mb-4 opacity-20" /><p className="text-xs font-black uppercase tracking-widest opacity-40">No authority records</p></div>
              )}
            </div>
          </div>

          {/* Workspace */}
          <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
            {indexSubTab === 'project' && activeRec && (
              <div className="flex-1 flex flex-col p-16 overflow-y-auto custom-scrollbar space-y-16 max-w-6xl mx-auto w-full">
                <div className="space-y-8">
                    <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0 pr-10">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="inline-flex items-center gap-2 px-3 py-1 bg-slate-100 text-slate-500 rounded-full text-[10px] font-black uppercase tracking-[0.2em]">{activeRec.type} Project Record</div>
                                <button onClick={() => { setIsEditingEntityName(true); setTempEntityName(activeRec.extractedName); }} className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-400 transition-colors"><Edit3 className="w-3.5 h-3.5" /></button>
                            </div>
                            {isEditingEntityName ? (
                                <div className="flex items-center gap-4">
                                    <input type="text" value={tempEntityName} onChange={e => setTempEntityName(e.target.value)} autoFocus className="text-6xl font-black text-slate-900 tracking-tighter uppercase italic leading-[0.8] bg-transparent border-b-4 border-blue-500 outline-none w-full" onKeyDown={e => e.key === 'Enter' && handleSaveEntityName()} />
                                    <button onClick={handleSaveEntityName} className="p-4 bg-emerald-500 text-white rounded-2xl shadow-xl hover:bg-emerald-600 transition-all"><Check className="w-8 h-8" /></button>
                                </div>
                            ) : (
                                <h2 className="text-6xl font-black text-slate-900 tracking-tighter uppercase italic leading-[0.8] truncate">{activeRec.extractedName}</h2>
                            )}
                            <p className="text-slate-400 font-bold text-lg mt-6">Detected in {activeRec.sourceAppearances.length} locations across the current archival project stack.</p>
                        </div>
                        <div className="flex flex-col gap-3">
                           <button onClick={() => updateRec(activeRec.id, { status: 'rejected', matchedId: undefined, matchedName: undefined })} className="px-8 py-3 bg-white border-2 border-slate-100 rounded-2xl text-[10px] font-black uppercase text-red-500 hover:bg-red-50 hover:border-red-100 transition-all shadow-md active:scale-95 flex items-center gap-2 tracking-widest"><UserMinus className="w-4 h-4" /> Flag as Junk</button>
                           <button onClick={() => updateRec(activeRec.id, { status: 'custom', addedAt: new Date().toISOString().split('T')[0] })} className="px-8 py-3 bg-white border-2 border-slate-100 rounded-2xl text-[10px] font-black uppercase text-emerald-600 hover:bg-emerald-50 hover:border-emerald-100 transition-all shadow-md active:scale-95 flex items-center gap-2 tracking-widest"><UserPlus className="w-4 h-4" /> Add to Local Vocab</button>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
                  <section className="bg-white rounded-[48px] border border-slate-200 p-12 shadow-sm space-y-10 flex flex-col">
                      <div className="flex items-center justify-between border-b border-slate-100 pb-6 shrink-0">
                        <h4 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-3"><History className="w-5 h-5 text-blue-500" /> Source Contexts</h4>
                      </div>
                      <div className="flex-1 space-y-6 overflow-y-auto custom-scrollbar pr-2 min-h-[400px]">
                        {activeRec.sourceAppearances.map((sa, idx) => {
                          const isDoc = sa.id.startsWith('Doc #');
                          const clusterId = isDoc ? parseInt(sa.id.replace('Doc #', '')) : null;
                          const isExpanded = expandedSourceId === `${sa.id}-${idx}`;
                          const matchingPages = (clusterId !== null && !isNaN(clusterId)) ? getMatchingPages(clusterId, activeRec.extractedName) : [];

                          return (
                            <div key={`${sa.id}-${idx}`} className="p-8 bg-slate-50/50 rounded-3xl border border-slate-100 space-y-6 group hover:border-blue-200 transition-all">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                  <div className="w-10 h-10 bg-white border rounded-xl flex items-center justify-center text-slate-400 shadow-sm"><FileText className="w-5 h-5" /></div>
                                  <span className="text-sm font-black italic text-slate-700">{sa.id}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {isDoc && (
                                    <button 
                                      onClick={() => setExpandedSourceId(isExpanded ? null : `${sa.id}-${idx}`)}
                                      className={`p-2 rounded-xl border transition-all ${isExpanded ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-400 hover:bg-blue-50 hover:text-blue-600 border-slate-100 shadow-sm'}`}
                                    >
                                      <FileSearch className="w-4 h-4" />
                                    </button>
                                  )}
                                  <button onClick={() => {
                                    if (isDoc && clusterId) { setState(s => ({ ...s, uiState: 'clustering' })); setEditingClusterId(clusterId); }
                                    else { setSearchTerm(sa.id); setState(s => ({ ...s, uiState: 'dashboard' })); }
                                  }} className="px-4 py-2 bg-white rounded-xl text-[10px] font-black uppercase text-blue-500 shadow-sm border border-slate-100 hover:bg-slate-900 hover:text-white flex items-center gap-2">Jump <ExternalLink className="w-3 h-3" /></button>
                                </div>
                              </div>
                              
                              <div className="space-y-2">
                                <label className="text-[8px] font-black uppercase text-slate-400 tracking-widest pl-1">Researcher Context Note</label>
                                <textarea 
                                  value={sa.note || ""} 
                                  onChange={e => updateSourceNote(activeRec.id, sa.id, e.target.value)}
                                  placeholder="Add specific context for this appearance..." 
                                  className="w-full bg-white border border-slate-100 rounded-2xl p-4 text-xs font-bold outline-none focus:border-blue-500/50 transition-all resize-none h-20 shadow-inner"
                                />
                              </div>

                              {isExpanded && (
                                <div className="pt-4 border-t border-slate-200 animate-in slide-in-from-top-2 duration-300">
                                  <div className="flex items-center justify-between mb-4">
                                    <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Pages Mentioning Entity ({matchingPages.length})</h5>
                                  </div>
                                  <div className="grid grid-cols-1 gap-2">
                                    {matchingPages.length > 0 ? matchingPages.map(p => (
                                      <button 
                                        key={p.id}
                                        onClick={() => {
                                          setSearchTerm(p.indexName);
                                          setState(s => ({ ...s, uiState: 'dashboard' }));
                                        }}
                                        className="flex items-center justify-between p-3 bg-white border border-slate-100 rounded-xl hover:border-blue-400 hover:bg-blue-50/50 transition-all group/page"
                                      >
                                        <span className="text-[11px] font-bold text-slate-600">{p.indexName}</span>
                                        <ExternalLink className="w-3 h-3 text-slate-300 group-hover/page:text-blue-500" />
                                      </button>
                                    )) : (
                                      <div className="text-[10px] italic text-slate-400 py-4 text-center bg-slate-100/50 rounded-2xl">No string matches found in transcriptions</div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                  </section>

                  <section className="bg-slate-900 rounded-[48px] p-12 shadow-2xl space-y-10 flex flex-col shrink-0 h-fit">
                      <div className="space-y-4">
                        <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] border-b border-white/10 pb-4 flex items-center gap-3"><Globe className="w-5 h-5 text-blue-400" /> Authority Match</h4>
                        <div className="relative">
                          <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-5 h-5 text-white/20" />
                          <input type="text" value={vocabSearch} onChange={e => setVocabSearch(e.target.value)} placeholder="Search master authority file..." className="w-full bg-white/5 border border-white/10 rounded-3xl py-5 pl-14 pr-6 text-white text-base font-bold outline-none focus:border-blue-500/50 transition-all shadow-inner focus:ring-4 ring-blue-500/5 placeholder:text-white/10" />
                        </div>
                      </div>
                      <div className="flex-1 space-y-4 overflow-y-auto custom-scrollbar pr-3 max-h-[500px]">
                        {vocabSearch.length > 1 ? (
                          vocabMatches.length > 0 ? vocabMatches.map(v => (
                            <button key={v.id} onClick={() => updateRec(activeRec.id, { status: 'matched', matchedId: v.id, matchedName: v.name })} className={`w-full p-6 rounded-3xl border-2 text-left transition-all flex items-center justify-between group ${activeRec.matchedId === v.id ? 'bg-blue-600 border-blue-400 text-white shadow-2xl shadow-blue-500/20' : 'bg-white/5 border-white/5 text-white/70 hover:border-white/20 hover:bg-white/10'}`}>
                              <div className="flex items-center gap-5">
                                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center font-black text-lg ${activeRec.matchedId === v.id ? 'bg-white/20 text-white' : 'bg-white/5 text-slate-500'}`}>{v.name[0]}</div>
                                <div className="flex flex-col">
                                  <span className="text-lg font-black italic leading-none mb-1">{v.name}</span>
                                  <span className={`text-[10px] font-bold uppercase tracking-widest ${activeRec.matchedId === v.id ? 'text-blue-100' : 'text-slate-500'}`}>Auth ID: #{v.id} • {v.type}</span>
                                </div>
                              </div>
                              <div className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${activeRec.matchedId === v.id ? 'bg-white/20' : 'bg-white/5 opacity-0 group-hover:opacity-100 shadow-inner'}`}>
                                <Check className="w-5 h-5" />
                              </div>
                            </button>
                          )) : <div className="text-center py-20 text-slate-600 uppercase text-[10px] font-black tracking-widest opacity-20 italic">No match found</div>
                        ) : activeRec.status === 'matched' ? (
                          <div className="bg-blue-600/10 border-2 border-blue-500/30 p-8 rounded-[40px] space-y-8 animate-in zoom-in-95 duration-300">
                            <div className="flex items-center gap-6">
                                <div className="w-16 h-16 bg-blue-600 rounded-[20px] flex items-center justify-center text-white shadow-2xl"><ShieldCheck className="w-8 h-8" /></div>
                                <div className="flex-1">
                                  <div className="text-[10px] font-black uppercase tracking-widest text-blue-400 mb-1">Universal Authority Connection</div>
                                  <div className="text-3xl font-black text-white italic leading-none">{activeRec.matchedName}</div>
                                  <div className="text-[10px] font-bold text-white/30 uppercase mt-2">Authenticated as ID: #{activeRec.matchedId}</div>
                                </div>
                            </div>
                            <button onClick={() => updateRec(activeRec.id, { status: 'pending', matchedId: undefined, matchedName: undefined })} className="w-full py-4 bg-white/5 hover:bg-red-500/20 hover:text-red-400 text-white/40 text-[10px] font-black uppercase rounded-2xl transition-all border border-white/10 hover:border-red-500/50 tracking-widest">Sever Authority Link</button>
                          </div>
                        ) : (
                          <div className="text-center py-24 text-slate-700 flex flex-col items-center gap-6">
                            <div className="w-20 h-20 rounded-full border-2 border-white/5 flex items-center justify-center opacity-20"><Search className="w-10 h-10" /></div>
                            <div className="text-sm font-black uppercase tracking-[0.3em] text-white/20">Awaiting Reconciliation</div>
                          </div>
                        )}
                      </div>
                  </section>
                </div>
              </div>
            )}

            {indexSubTab === 'master' && activeMaster && (
              <div className="flex-1 flex flex-col p-16 overflow-y-auto custom-scrollbar space-y-16 max-w-6xl mx-auto w-full animate-in fade-in duration-500">
                  <div className="space-y-8">
                    <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0 pr-10">
                            <div className="flex items-center gap-3 mb-6">
                                <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-100 text-emerald-600 rounded-full text-[10px] font-black uppercase tracking-[0.2em]">Universal Authority Record</div>
                                <button onClick={() => { setIsEditingEntityName(true); setTempEntityName(activeMaster.name); }} className="p-1.5 hover:bg-slate-200 rounded-lg text-slate-400 transition-colors"><Edit3 className="w-3.5 h-3.5" /></button>
                            </div>
                            {isEditingEntityName ? (
                                <div className="flex items-center gap-4">
                                    <input type="text" value={tempEntityName} onChange={e => setTempEntityName(e.target.value)} autoFocus className="text-6xl font-black text-slate-900 tracking-tighter uppercase italic leading-[0.8] bg-transparent border-b-4 border-emerald-500 outline-none w-full" onKeyDown={e => e.key === 'Enter' && handleSaveEntityName()} />
                                    <button onClick={handleSaveEntityName} className="p-4 bg-emerald-500 text-white rounded-2xl shadow-xl hover:bg-emerald-600 transition-all"><Check className="w-8 h-8" /></button>
                                </div>
                            ) : (
                                <h2 className="text-6xl font-black text-slate-900 tracking-tighter uppercase italic leading-[0.8] truncate">{activeMaster.name}</h2>
                            )}
                            <div className="mt-8 flex items-center gap-6">
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Global ID</span>
                                    <span className="text-xl font-mono font-bold text-slate-700">#{activeMaster.id}</span>
                                </div>
                                <div className="h-10 w-px bg-slate-200" />
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Categorization</span>
                                    <div className="flex items-center gap-2 text-sm font-bold text-slate-600 px-3 py-1 bg-white border rounded-xl shadow-sm uppercase tracking-tighter">
                                        {activeMaster.type === 'person' && <User className="w-3.5 h-3.5 text-blue-500" />}
                                        {activeMaster.type === 'organization' && <Building className="w-3.5 h-3.5 text-purple-500" />}
                                        {activeMaster.type === 'role' && <Briefcase className="w-3.5 h-3.5 text-orange-500" />}
                                        {activeMaster.type}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                  </div>
                  
                  {/* Rich Metadata Section */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                     <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm space-y-8">
                        <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-3"><Fingerprint className="w-5 h-5 text-indigo-500" /> Biographical Profile</h3>
                        <div className="grid grid-cols-1 gap-6">
                           <div className="space-y-1">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Life Span</span>
                              <p className="text-sm font-bold text-slate-700 flex items-center gap-2"><Calendar className="w-3.5 h-3.5" /> {activeMaster.lifeSpan || 'Unrecorded'}</p>
                           </div>
                           <div className="space-y-1">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Political Affiliation</span>
                              <p className="text-sm font-bold text-slate-700 flex items-center gap-2"><FlagTriangleLeft className="w-3.5 h-3.5" /> {activeMaster.politicalAffiliation || 'Neutral/Unknown'}</p>
                           </div>
                           <div className="space-y-1">
                              <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Religion & Nationality</span>
                              <p className="text-sm font-bold text-slate-700 flex items-center gap-2"><Landmark className="w-3.5 h-3.5" /> {activeMaster.religion}{activeMaster.nationality ? ` / ${activeMaster.nationality}` : ''}</p>
                           </div>
                           {activeMaster.gender && (
                              <div className="space-y-1">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Gender</span>
                                <p className="text-sm font-bold text-slate-700">{activeMaster.gender === 'm' || activeMaster.gender === 'male' ? 'Male' : activeMaster.gender === 'f' || activeMaster.gender === 'female' ? 'Female' : 'Unknown'}</p>
                              </div>
                           )}
                           {activeMaster.otherNames && (
                              <div className="space-y-1">
                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Alias / Hebrew Variant</span>
                                <p className="text-sm font-bold text-slate-700 italic" dir={getTextDirection(activeMaster.otherNames)}>{activeMaster.otherNames}</p>
                              </div>
                           )}
                        </div>
                     </div>

                     <div className="flex flex-col gap-8">
                        <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm space-y-6">
                           <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-3"><Globe className="w-5 h-5 text-blue-500" /> External Authorities</h3>
                           <div className="space-y-4">
                              {activeMaster.wikidata && (
                                <a href={activeMaster.wikidata} target="_blank" className="flex items-center justify-between p-4 bg-slate-50 border rounded-2xl hover:border-blue-400 transition-all group">
                                   <span className="text-xs font-black uppercase text-slate-500">Wikidata Entry</span>
                                   <ExternalLink className="w-4 h-4 text-slate-300 group-hover:text-blue-500" />
                                </a>
                              )}
                              {activeMaster.otherLinks && (
                                <div className="space-y-2">
                                  <span className="text-[9px] font-black text-slate-400 uppercase">Additional Bibliography</span>
                                  <div className="flex flex-wrap gap-2">
                                     {activeMaster.otherLinks.split(/[ ,|]+/).filter(l => l.startsWith('http')).map((link, idx) => (
                                        <a key={idx} href={link} target="_blank" className="p-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-all"><ExternalLink className="w-3 h-3" /></a>
                                     ))}
                                  </div>
                                </div>
                              )}
                           </div>
                        </div>

                        <div className="bg-white rounded-[40px] p-10 border border-slate-200 shadow-sm space-y-4">
                           <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-3"><StickyNote className="w-5 h-5 text-amber-500" /> Researcher Notes</h3>
                           <p className="text-sm font-medium text-slate-600 leading-relaxed italic">{activeMaster.notes || 'No extended historical notes available for this authority record.'}</p>
                        </div>
                     </div>
                  </div>

                  <div className="bg-white rounded-[48px] p-12 border border-slate-200 shadow-sm space-y-6">
                    <h3 className="text-xs font-black text-slate-900 uppercase tracking-widest flex items-center gap-3"><Layers className="w-5 h-5 text-emerald-500" /> Linked Project Index Entries</h3>
                    <p className="text-slate-400 font-bold text-sm">Below are project index entries currently linked to this universal record in this session:</p>
                    <div className="grid grid-cols-1 gap-3">
                        {state.reconciliationList.filter(r => r.matchedId === activeMaster.id).map(r => (
                            <div key={r.id} className="p-4 bg-slate-50 rounded-2xl border border-slate-100 flex items-center justify-between">
                                <span className="font-bold text-slate-700 italic">{r.extractedName}</span>
                                <span className="text-[10px] font-black uppercase text-slate-300">Project Record Link</span>
                            </div>
                        ))}
                    </div>
                  </div>
              </div>
            )}

            {!activeRec && !activeMaster && (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-200 gap-8 animate-pulse">
                 <div className="w-40 h-40 rounded-[56px] border-4 border-slate-100 flex items-center justify-center"><Fingerprint className="w-20 h-20 opacity-10" /></div>
                 <div className="text-center space-y-2">
                   <h3 className="text-2xl font-black uppercase tracking-[0.3em] opacity-10 italic">Research Index</h3>
                   <p className="text-xs font-bold text-slate-300 uppercase">Select a project record or authority file to begin analysis.</p>
                 </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Fix: Added renderConfidence to visualize AI confidence scores
  const renderConfidence = (score: number | undefined) => {
    if (!score) return null;
    return (
      <div className="flex items-center gap-0.5 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-lg shadow-sm">
        {[...Array(5)].map((_, i) => (
          <Star key={i} className={`w-2.5 h-2.5 ${i < score ? 'text-amber-500 fill-amber-500' : 'text-slate-300'}`} />
        ))}
      </div>
    );
  };

  const renderDashboard = () => {
    const isTranscribingActive = !state.processingStatus.isComplete && state.processingStatus.currentStep.includes('OCR');
    return (
      <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
        {renderCommonHeader(
          <button onClick={() => {
              const toProc = state.files.filter(f => f.shouldTranscribe || f.shouldTranslate);
              if (toProc.length === 0) { alert("Select pages first."); return; }
              setState(s => ({ ...s, processingStatus: { total: toProc.length, processed: 0, currentStep: 'Gemini OCR Pipeline...', isComplete: false } }));
              (async () => {
                const concurrency = state.tier === Tier.PAID ? 5 : 1;
                for (let i = 0; i < toProc.length; i += concurrency) {
                  await Promise.all(toProc.slice(i, i + concurrency).map(async (p) => {
                    setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, status: 'transcribing' } : f) }));
                    const res = await transcribeAndTranslatePage(p, state.tier);
                    setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, ...res, manualTranscription: (!f.manualTranscription || f.manualTranscription === "") ? res.generatedTranscription : f.manualTranscription, manualDescription: (!f.manualDescription || f.manualDescription === "") ? res.generatedTranslation : f.manualDescription } : f), processingStatus: { ...prev.processingStatus, processed: prev.processingStatus.processed + 1 } }));
                  }));
                }
                setState(prev => ({ ...prev, processingStatus: { ...prev.processingStatus, isComplete: true } }));
              })();
            }} disabled={isTranscribingActive} className={`px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-xl active:scale-95 transition-all border-b-4 ${isTranscribingActive ? 'bg-slate-300 text-slate-500 border-slate-400 grayscale' : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-800'}`}>{isTranscribingActive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />} Transcribe</button>
        )}
        <div className="flex-1 overflow-auto p-8 custom-scrollbar">
          <div className="max-w-[1500px] mx-auto space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6">
                <div className="relative flex-1 w-full">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Filter pages..." className="w-full bg-white border border-slate-200 rounded-2xl py-3 pl-12 pr-4 text-sm font-medium outline-none" />
                </div>
                <div className="flex items-center gap-4 shrink-0">
                    <div className="flex items-center gap-2 bg-slate-200/50 p-1.5 rounded-2xl border border-slate-200">
                        <span className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">OCR:</span>
                        <button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranscribe: true })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">All</button>
                        <button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranscribe: false })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">None</button>
                    </div>
                </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {filteredPages.map(page => (
                <div key={page.id} className="bg-white rounded-[32px] border border-slate-200 overflow-hidden group hover:border-blue-500 hover:shadow-2xl transition-all flex flex-col shadow-sm">
                  <div className="relative aspect-[4/5] overflow-hidden bg-slate-100 cursor-zoom-in" onClick={() => setZoomedPageId(page.id)}>
                      <img src={page.previewUrl} alt={page.indexName} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" style={{ transform: `rotate(${page.rotation || 0}deg)` }} />
                      <div className="absolute top-4 left-4 flex flex-col gap-2">
                        <div className="bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-xl text-[10px] font-black text-slate-800 shadow-xl uppercase tracking-tighter">{page.indexName.split('-').pop()?.trim()}</div>
                        {page.hasHebrewHandwriting && <div className="bg-amber-500 px-3 py-1.5 rounded-xl text-[10px] font-black text-white shadow-xl flex items-center gap-1.5 uppercase tracking-tighter"><Flag className="w-3 h-3" /> HBW</div>}
                      </div>
                      <div className="absolute top-4 right-4">{renderConfidence(page.confidenceScore)}</div>
                      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                        <button onClick={(e) => { e.stopPropagation(); setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, rotation: ((f.rotation || 0) - 90 + 360) % 360 } : f) })); }} className="p-3 bg-white rounded-2xl shadow-2xl hover:bg-slate-900 hover:text-white transition-all"><RotateCcw className="w-5 h-5" /></button>
                        <button onClick={(e) => { e.stopPropagation(); setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, rotation: ((f.rotation || 0) + 90) % 360 } : f) })); }} className="p-3 bg-white rounded-2xl shadow-2xl hover:bg-slate-900 hover:text-white transition-all"><RotateCw className="w-5 h-5" /></button>
                      </div>
                  </div>
                  <div className="p-6 flex-1 flex flex-col gap-5">
                    <div>
                      <h4 className="font-black text-slate-800 truncate text-sm tracking-tight mb-1">{page.indexName}</h4>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] text-slate-400 font-mono truncate flex-1">{page.fileName}</p>
                        <span className="text-[8px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">{page.language || '...'}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">{page.entities?.people?.slice(0, 3).map(p => renderBadge(p, 'people'))}</div>
                    <div className="mt-auto pt-5 border-t flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 cursor-pointer select-none group/cb">
                          <div className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-all ${page.shouldTranscribe ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>{page.shouldTranscribe && <CheckSquare className="w-4 h-4 text-white" />}</div>
                          <input type="checkbox" className="hidden" checked={page.shouldTranscribe} onChange={e => setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, shouldTranscribe: e.target.checked } : f) }))} />
                          <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">OCR</span>
                        </label>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => setExpandedField({ pageId: page.id, field: 'manualTranscription', label: 'Transcription Editor' })} className="flex-1 py-2 rounded-xl bg-slate-50 text-[10px] font-black uppercase text-slate-600 hover:bg-slate-900 hover:text-white transition-all border shadow-sm flex items-center justify-center gap-2"><Edit3 className="w-3.5 h-3.5" /> Edit OCR</button>
                        <button onClick={() => setExpandedField({ pageId: page.id, field: 'manualDescription', label: 'Research Notes' })} className="flex-1 py-2 rounded-xl bg-slate-50 text-[10px] font-black uppercase text-slate-600 hover:bg-slate-900 hover:text-white transition-all border shadow-sm flex items-center justify-center gap-2"><StickyNote className="w-3.5 h-3.5" /> Notes</button>
                      </div>
                      {page.status === 'transcribing' && <div className="h-1 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 animate-pulse" style={{ width: '100%' }} /></div>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  /* MODAL COMPONENT FOR EDITING CLUSTERS */
  const ClusterEditor: React.FC<{ cluster: Cluster, onClose: () => void }> = ({ cluster, onClose }) => {
    const [localCluster, setLocalCluster] = useState<Cluster>({ ...cluster });

    const handleSave = () => {
      setState(prev => ({
        ...prev,
        clusters: prev.clusters.map(c => c.id === cluster.id ? localCluster : c)
      }));
      onClose();
    };

    return (
      <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-2xl p-8 flex items-center justify-center">
        <div className="bg-white w-full max-w-4xl h-[90vh] rounded-[56px] shadow-2xl overflow-hidden flex flex-col">
          <header className="p-10 border-b flex justify-between items-center shrink-0">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center text-white shadow-xl">
                <Library className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-2xl font-black uppercase italic tracking-tight">Edit Document Group</h3>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Document #{cluster.id}</p>
              </div>
            </div>
            <button onClick={onClose} className="p-4 hover:bg-slate-100 rounded-2xl transition-all">
              <X className="w-10 h-10 text-slate-400" />
            </button>
          </header>
          <div className="flex-1 overflow-y-auto p-12 space-y-10 custom-scrollbar">
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Title</label>
              <input type="text" value={localCluster.title} onChange={e => setLocalCluster({ ...localCluster, title: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none" />
            </div>
            <div className="space-y-4">
              <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Summary</label>
              <textarea value={localCluster.summary} onChange={e => setLocalCluster({ ...localCluster, summary: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none h-32 resize-none" />
            </div>
            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Original Date</label>
                <input type="text" value={localCluster.originalDate || ''} onChange={e => setLocalCluster({ ...localCluster, originalDate: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none" />
              </div>
              <div className="space-y-4">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Prison Repository</label>
                <input type="text" value={localCluster.prisonName || ''} onChange={e => setLocalCluster({ ...localCluster, prisonName: e.target.value })} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm font-bold outline-none" />
              </div>
            </div>
          </div>
          <footer className="p-10 border-t bg-slate-50 flex gap-4">
            <button onClick={onClose} className="flex-1 py-5 bg-white border border-slate-200 rounded-[28px] font-black uppercase text-slate-400">Cancel</button>
            <button onClick={handleSave} className="flex-1 py-5 bg-slate-900 text-white rounded-[28px] font-black uppercase hover:bg-emerald-600 transition-all shadow-xl">Save Changes</button>
          </footer>
        </div>
      </div>
    );
  };

  const renderClustering = () => (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {renderCommonHeader(<button onClick={async () => { setState(s => ({ ...s, processingStatus: { total: state.files.length, processed: 0, currentStep: 'Running Gemini Cluster Analysis...', isComplete: false } })); try { const clusters = await clusterPages(state.files, state.tier); setState(s => ({ ...s, clusters, processingStatus: { ...s.processingStatus, isComplete: true } })); } catch (e) { alert("Clustering failed."); } }} className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-xs font-black uppercase tracking-tight flex items-center gap-2 shadow-lg"><Sparkles className="w-4 h-4" /> AI Document Indexing</button>)}
      <div className="flex-1 p-12 overflow-y-auto custom-scrollbar">
        <div className="max-w-7xl mx-auto space-y-12">
          {state.clusters.map(c => (
            <div key={c.id} className="bg-white rounded-[40px] border border-slate-200 overflow-hidden shadow-sm hover:shadow-2xl transition-all p-12 group relative">
              <button onClick={() => setEditingClusterId(c.id)} className="absolute top-12 right-12 p-3.5 bg-slate-50 text-slate-400 hover:bg-slate-900 hover:text-white rounded-2xl transition-all opacity-0 group-hover:opacity-100"><Edit3 className="w-5 h-5" /></button>
              <div className="flex items-center gap-3 mb-8"><div className="bg-blue-600 text-white text-xs font-black px-5 py-1.5 rounded-full uppercase">Doc #{c.id}</div><div className="text-slate-300 font-black uppercase text-[10px] tracking-widest">{c.pageRange}</div></div>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
                 <div className="lg:col-span-8 space-y-8"><h3 className="text-3xl font-black text-slate-800 leading-tight tracking-tight">{c.title}</h3><p className="text-slate-500 leading-relaxed text-base font-medium italic border-l-4 border-slate-100 pl-6">{c.summary}</p><div className="flex flex-wrap gap-2.5">{c.subjects?.map(s => renderBadge(s, 'subjects'))}</div></div>
                 <div className="lg:col-span-4 bg-slate-50/50 rounded-[32px] p-8 border border-slate-100 space-y-6">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b pb-2">Archival Metadata</h4>
                    <div className="space-y-4">
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><Calendar className="w-4 h-4 text-indigo-600" /> {c.standardizedDate || c.originalDate || 'Unknown'}</div>
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><MapPin className="w-4 h-4 text-red-500" /> {c.prisonName || 'Repository Unidentified'}</div>
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><FileText className="w-4 h-4 text-orange-500" /> {(c.docTypes || []).join(', ')}</div>
                    </div>
                 </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mt-12 pt-12 border-t">
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><Users className="w-4 h-4 text-blue-500" /> People</h4><div className="flex flex-wrap gap-2">{c.entities?.people?.map(p => renderBadge(p, 'people'))}</div></div>
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><Building className="w-4 h-4 text-purple-500" /> Organizations</h4><div className="flex flex-wrap gap-2">{c.entities?.organizations?.map(o => renderBadge(o, 'orgs'))}</div></div>
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><RoleIcon className="w-4 h-4 text-orange-500" /> Roles</h4><div className="flex flex-wrap gap-2">{c.entities?.roles?.map(r => renderBadge(r, 'roles'))}</div></div>
              </div>
              <div className="mt-12 flex gap-4 overflow-x-auto pb-4 custom-scrollbar">
                 {c.pageIds.map(pid => { const p = state.files.find(f => f.id === pid); return p ? <div key={pid} className="shrink-0"><img src={p.previewUrl} className="h-32 w-24 object-cover rounded-xl border border-slate-200 cursor-zoom-in hover:scale-105 transition-all shadow-sm" onClick={() => setZoomedPageId(p.id)} /></div> : null; })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {editingClusterId && <ClusterEditor cluster={state.clusters.find(c => c.id === editingClusterId)!} onClose={() => setEditingClusterId(null)} />}
    </div>
  );

  const processPdf = async (pdfFile: File): Promise<File[]> => {
    const arrayBuffer = await pdfFile.arrayBuffer();
    // @ts-ignore
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const images: File[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.height = viewport.height;
      canvas.width = viewport.width;
      if (context) {
        await page.render({ canvasContext: context, viewport: viewport }).promise;
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
        if (blob) images.push(new File([blob], `${pdfFile.name.replace('.pdf', '')}_page_${i}.jpg`, { type: 'image/jpeg' }));
      }
    }
    return images;
  };

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans selection:bg-blue-100">
      {state.uiState === 'welcome' ? renderWelcome() : (
        <>
          <aside className={`bg-white border-r flex flex-col transition-all duration-300 ${isSidebarOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
            <div className="p-6 border-b flex items-center justify-between shrink-0"><div className="flex items-center gap-2"><div className="w-8 h-8 bg-slate-900 rounded-lg flex items-center justify-center"><Sparkles className="w-5 h-5 text-white" /></div><span className="font-black italic uppercase tracking-tighter text-xl">Archival Lens</span></div><button onClick={() => setIsSidebarOpen(false)} className="p-1 hover:bg-slate-100 rounded-lg"><PanelLeft className="w-4 h-4 text-slate-400" /></button></div>
            <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
              <div className="space-y-4"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Project</h4><div className="bg-slate-50 p-5 rounded-3xl border shadow-inner"><div className="text-sm font-black text-slate-800 leading-tight mb-1">{projectTitle}</div><div className="text-[10px] font-bold text-slate-400 uppercase truncate">{archiveName || 'Repository Unassigned'}</div></div></div>
              <div className="space-y-6"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Filter Archive</h4><div className="space-y-4"><div className="space-y-1"><label className="text-[9px] font-bold text-slate-400 uppercase">Language</label><select value={filterLanguage} onChange={e => setFilterLanguage(e.target.value)} className="w-full bg-slate-50 border rounded-xl px-3 py-2 text-xs font-bold"><option value="All">All</option>{Array.from(new Set(state.files.map(f => f.language).filter(Boolean))).map(l => <option key={l} value={l}>{l}</option>)}</select></div></div></div>
            </div>
            <div className="p-6 border-t bg-slate-50/50"><button onClick={() => setState(s => ({ ...s, uiState: 'welcome' }))} className="w-full flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 transition-colors py-2"><X className="w-3.5 h-3.5" /> Close Project</button></div>
          </aside>
          {!isSidebarOpen && <button onClick={() => setIsSidebarOpen(true)} className="fixed left-4 bottom-4 z-30 p-4 bg-slate-900 text-white rounded-2xl shadow-2xl active:scale-95 transition-all"><PanelLeft className="w-6 h-6" /></button>}
          <div className="flex-1 flex flex-col overflow-hidden">
             {state.uiState === 'config' && (
                <div className="flex-1 flex items-center justify-center p-8 bg-slate-100 overflow-y-auto">
                   <div className="bg-white p-12 rounded-[56px] shadow-2xl border border-slate-200 max-w-2xl w-full">
                      <h2 className="text-3xl font-black text-slate-900 italic uppercase mb-10 flex items-center gap-3"><Settings className="w-8 h-8 text-blue-600" /> Init Research</h2>
                      <div className="space-y-8">
                        <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Project Title</label><input type="text" value={projectTitle} onChange={e => setProjectTitle(e.target.value)} className="w-full bg-slate-50 border rounded-2xl p-4 text-sm font-bold outline-none" /></div>
                        <div className="space-y-2"><label className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Archive Repository</label><input list="archive-options" value={archiveName} onChange={e => setArchiveName(e.target.value)} className="w-full bg-slate-50 border rounded-2xl p-4 text-sm font-bold outline-none" /><datalist id="archive-options">{PRESET_ARCHIVES.map(a => <option key={a} value={a} />)}</datalist></div>
                        <div className="bg-slate-50 p-6 rounded-[32px] border border-slate-100 shadow-inner">
                          <div className="flex items-center justify-between mb-4">
                            <span className="text-xs font-black uppercase tracking-tight flex items-center gap-2"><ListChecks className="w-4 h-4 text-blue-500" /> Scope Limit</span>
                            <button onClick={() => setUseRange(!useRange)} className={`w-10 h-6 rounded-full transition-all relative ${useRange ? 'bg-blue-600 shadow-lg shadow-blue-100' : 'bg-slate-300'}`}>
                              <div className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-all ${useRange ? 'translate-x-4' : ''}`} />
                            </button>
                          </div>
                          {useRange && (
                            <div className="flex items-center gap-3 animate-in slide-in-from-top-2 duration-300">
                              <div className="flex-1 space-y-1"><label className="text-[9px] font-bold text-slate-400 uppercase">Start Page</label><input type="number" min={1} value={rangeStart} onChange={e => setRangeStart(parseInt(e.target.value) || 1)} className="w-full p-3 bg-white border rounded-xl text-xs font-bold" /></div>
                              <div className="flex-1 space-y-1"><label className="text-[9px] font-bold text-slate-400 uppercase">End Page</label><input type="number" max={state.files.length} value={rangeEnd} onChange={e => setRangeEnd(parseInt(e.target.value) || 1)} className="w-full p-3 bg-white border rounded-xl text-xs font-bold" /></div>
                            </div>
                          )}
                        </div>
                        <button onClick={async () => {
                          let finalFiles = [...state.files];
                          if (useRange) finalFiles = finalFiles.slice(rangeStart - 1, rangeEnd);
                          setState(s => ({ ...s, files: finalFiles, uiState: 'dashboard', archiveName, processingStatus: { total: finalFiles.length, processed: 0, currentStep: 'Analyzing Topography...', isComplete: false } }));
                          (async () => {
                            for (const p of finalFiles) {
                                setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, status: 'analyzing' } : f) }));
                                try { const res = await analyzePageContent(p, state.tier); setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, ...res } : f), processingStatus: { ...prev.processingStatus, processed: prev.processingStatus.processed + 1 } })); } 
                                catch (e) { setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, status: 'error' } : f) })); }
                            }
                            setState(prev => ({ ...prev, processingStatus: { ...prev.processingStatus, isComplete: true } }));
                          })();
                        }} className="w-full bg-slate-900 text-white py-5 rounded-[28px] font-black uppercase tracking-widest hover:bg-blue-600 transition-all active:scale-95 shadow-2xl"><Play className="w-5 h-5 inline mr-2" /> Activate Scope</button>
                      </div>
                   </div>
                </div>
             )}
             {state.uiState === 'dashboard' && renderDashboard()}
             {state.uiState === 'clustering' && renderClustering()}
             {state.uiState === 'entities' && renderUnifiedEntities()}
          </div>
        </>
      )}
      {expandedField && (
        <div className="fixed inset-0 z-[100] bg-slate-900/95 backdrop-blur-2xl p-8 flex items-center justify-center">
          <div className="bg-white w-full h-full rounded-[56px] shadow-2xl overflow-hidden flex flex-col">
            <header className="p-10 border-b flex justify-between items-center shrink-0"><div className="flex items-center gap-4"><div className="w-12 h-12 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-xl"><Edit3 className="w-6 h-6" /></div><div><h3 className="text-2xl font-black uppercase italic tracking-tight">{expandedField.label}</h3><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{state.files.find(f => f.id === expandedField.pageId)?.indexName}</p></div></div><button onClick={() => setExpandedField(null)} className="p-4 hover:bg-slate-100 rounded-2xl transition-all"><X className="w-10 h-10 text-slate-400" /></button></header>
            <div className="flex-1 flex overflow-hidden">
               <div className="w-1/2 bg-slate-900 p-12 flex items-center justify-center overflow-auto"><img src={state.files.find(f => f.id === expandedField.pageId)?.previewUrl} alt="Preview" className="max-w-full max-h-full shadow-2xl rounded-lg" style={{ transform: `rotate(${state.files.find(f => f.id === expandedField.pageId)?.rotation || 0}deg)` }} /></div>
               <div className="w-1/2 p-12 flex flex-col bg-white">
                  <textarea className="flex-1 border-2 border-slate-100 rounded-[40px] p-10 font-mono text-base outline-none focus:border-blue-500 bg-slate-50 shadow-inner leading-relaxed resize-none" value={(state.files.find(f => f.id === expandedField.pageId) as any)?.[expandedField.field] || ''} dir={getTextDirection((state.files.find(f => f.id === expandedField.pageId) as any)?.[expandedField.field] || '')} onChange={e => setState(s => ({ ...s, files: s.files.map(f => f.id === expandedField.pageId ? { ...f, [expandedField.field]: e.target.value } : f) }))} />
                  <div className="grid grid-cols-2 gap-4 mt-8"><button onClick={() => setExpandedField(null)} className="bg-slate-100 text-slate-500 py-5 rounded-[28px] font-black uppercase hover:bg-slate-200 transition-all">Cancel</button><button onClick={() => setExpandedField(null)} className="bg-slate-900 text-white py-5 rounded-[28px] font-black uppercase hover:bg-blue-600 transition-all active:scale-95 shadow-xl">Commit</button></div>
               </div>
            </div>
          </div>
        </div>
      )}
      {zoomedPageId && (
        <div className="fixed inset-0 z-[110] bg-slate-900/98 backdrop-blur-2xl flex items-center justify-center p-12 cursor-zoom-out" onClick={() => setZoomedPageId(null)}><img src={state.files.find(f => f.id === zoomedPageId)?.previewUrl} alt="Zoomed" className="max-w-full max-h-full object-contain shadow-2xl rounded-sm" style={{ transform: `rotate(${state.files.find(f => f.id === zoomedPageId)?.rotation || 0}deg)` }} /></div>
      )}
    </div>
  );
};
