
import React, { useState, useEffect, useMemo } from 'react';
import { 
  FolderOpen, FileText, Settings, Play, Download, CheckCircle, Loader2, Maximize2, X, Flag, CheckSquare, Square, Info, 
  Languages, FileUp, Edit3, Bot, ZoomIn, ZoomOut, Type, MapPin, Users, Building, Calendar, Mail, User, Filter, Cloud, Code, 
  LayoutGrid, Save, FileJson, RotateCw, RotateCcw, Library, AlertTriangle, Upload, ChevronDown, Hash, ListChecks, ArrowRightLeft,
  Search, ExternalLink, Globe, UserCheck, Tag, FileOutput, Package, Briefcase, Sparkles, Bookmark, CloudUpload, Clock, Trash2,
  ChevronRight, PanelLeft, StickyNote, Activity, PieChart, Database, ListFilter, Briefcase as RoleIcon, Plus, Link as LinkIcon, Link2Off,
  FileSpreadsheet, ShieldCheck, Star
} from 'lucide-react';
import { ArchivalPage, AppState, AnalysisMode, Tier, ProcessingStatus, Cluster, Correspondent, EntityReference, NamedEntities } from '../types';
import { analyzePageContent, transcribeAndTranslatePage, clusterPages } from '../services/geminiService';
import { listFilesFromDrive, fetchFileFromDrive, uploadFileToDrive } from '../services/googleDriveService';
import { generateTSV, generateClustersTSV, generateFullJSON, generateProjectBackup, generateProjectZip, downloadFile } from '../utils/fileUtils';
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
  processingStatus: { total: 0, processed: 0, currentStep: 'idle', isComplete: false },
  uiState: 'welcome',
  archiveName: "",
};

const getTextDirection = (text: string | undefined): 'rtl' | 'ltr' => {
  if (!text) return 'ltr';
  return /[\u0590-\u05FF]/.test(text) ? 'rtl' : 'ltr';
};

const resolveEntity = (name: string): EntityReference => {
  const low = name.toLowerCase();
  const match = CONTROLLED_VOCABULARY.find(v => v.name.toLowerCase() === low);
  return { name, id: match?.id };
};

const App: React.FC = () => {
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
  const [selectedEntity, setSelectedEntity] = useState<{name: string, type: 'person' | 'organization' | 'role'} | null>(null);
  
  const [searchTerm, setSearchTerm] = useState("");
  const [filterLanguage, setFilterLanguage] = useState<string>("All");
  const [filterProductionMode, setFilterProductionMode] = useState<string>("All");
  const [filterHandwriting, setFilterHandwriting] = useState<boolean | null>(null);
  
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isZipping, setIsZipping] = useState(false);
  const [isUploadingToDrive, setIsUploadingToDrive] = useState(false);

  const vocabulary = useMemo(() => {
    const people = new Set<string>();
    const roles = new Set<string>();
    const orgs = new Set<string>();
    const subjects = new Set<string>();
    CONTROLLED_VOCABULARY.forEach(item => {
      if (item.type === 'person') people.add(item.name.toLowerCase());
      if (item.type === 'role') roles.add(item.name.toLowerCase());
      if (item.type === 'organization') orgs.add(item.name.toLowerCase());
    });
    SUBJECTS_LIST.forEach(s => subjects.add(s.toLowerCase()));
    return { people, roles, orgs, subjects };
  }, []);

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

  const allEntities = useMemo(() => {
    const peopleMap = new Map<string, string[]>();
    const orgsMap = new Map<string, string[]>();
    const rolesMap = new Map<string, string[]>();
    const addEntity = (map: Map<string, string[]>, name: string, contextId: string) => {
      if (!name) return;
      const list = map.get(name) || [];
      if (!list.includes(contextId)) list.push(contextId);
      map.set(name, list);
    };
    state.clusters.forEach(c => {
      c.entities?.people?.forEach(p => addEntity(peopleMap, p.name, `Doc #${c.id}`));
      c.entities?.organizations?.forEach(o => addEntity(orgsMap, o.name, `Doc #${c.id}`));
      c.entities?.roles?.forEach(r => addEntity(rolesMap, r.name, `Doc #${c.id}`));
      c.senders?.forEach(s => addEntity(peopleMap, s.name, `Doc #${c.id} (Sender)`));
      c.recipients?.forEach(r => addEntity(peopleMap, r.name, `Doc #${c.id} (Recipient)`));
    });
    state.files.forEach(f => {
      f.entities?.people?.forEach(p => addEntity(peopleMap, p.name, f.indexName));
      f.entities?.organizations?.forEach(o => addEntity(orgsMap, o.name, f.indexName));
      f.entities?.roles?.forEach(r => addEntity(rolesMap, r.name, f.indexName));
    });
    return {
      people: Array.from(peopleMap.entries()).map(([name, ids]) => ({ name, ids })),
      organizations: Array.from(orgsMap.entries()).map(([name, ids]) => ({ name, ids })),
      roles: Array.from(rolesMap.entries()).map(([name, ids]) => ({ name, ids }))
    };
  }, [state.clusters, state.files]);

  const isNameInVocabulary = (name: string, category?: string): boolean => {
    const low = name.toLowerCase();
    if (category === 'subjects') return vocabulary.subjects.has(low);
    return vocabulary.people.has(low) || vocabulary.roles.has(low) || vocabulary.orgs.has(low);
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

  const renderConfidence = (score: number | undefined) => {
    if (!score) return null;
    return (
      <div className="flex items-center gap-0.5" title={`Confidence: ${score}/5`}>
        {[1, 2, 3, 4, 5].map(s => (
          <Star key={s} className={`w-2.5 h-2.5 ${s <= score ? 'text-amber-400 fill-amber-400' : 'text-slate-200 fill-slate-200'}`} />
        ))}
      </div>
    );
  };

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

  const loadFromDrive = async () => {
    try {
      const files = await listFilesFromDrive();
      if (files.length === 0) { alert("No backup files found on Drive."); return; }
      const fileId = prompt("Select File ID:\n" + files.map(f => `${f.name} (ID: ${f.id})`).join('\n'));
      if (!fileId) return;
      setIsProcessingFiles(true);
      const blob = await fetchFileFromDrive(fileId);
      await restoreProjectFromBlob(blob);
    } catch (e: any) { alert("Drive load failed: " + e.message); } finally { setIsProcessingFiles(false); }
  };

  const saveToDrive = async () => {
    setIsUploadingToDrive(true);
    try {
      const zipBlob = await generateProjectZip(state, projectTitle, archiveName || "", pageRange);
      await uploadFileToDrive(zipBlob, `${projectTitle.replace(/[^a-z0-9]/gi, '_')}.aln_project.zip`);
      alert("Successfully saved to Google Drive!");
    } catch (e: any) { alert("Drive upload failed: " + e.message); } finally { setIsUploadingToDrive(false); }
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
      <div className="flex items-center gap-8">
        <div className="flex bg-slate-100 p-1 rounded-xl">
          {['dashboard', 'clustering', 'entities'].map((view: any) => (
            <button key={view} onClick={() => setState(s => ({ ...s, uiState: view }))} className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-tight transition-all ${state.uiState === view ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>{view === 'dashboard' ? <LayoutGrid className="w-3.5 h-3.5 inline mr-1.5" /> : view === 'clustering' ? <Library className="w-3.5 h-3.5 inline mr-1.5" /> : <Users className="w-3.5 h-3.5 inline mr-1.5" />}{view}</button>
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
        <button onClick={async () => { setIsZipping(true); try { const zipBlob = await generateProjectZip(state, projectTitle, archiveName || "", pageRange); downloadFile(zipBlob, `${projectTitle}.zip`, 'application/zip'); } finally { setIsZipping(false); } }} className="p-2.5 bg-slate-900 text-white rounded-xl transition-all shadow-xl hover:bg-blue-600 active:scale-95 group relative">{isZipping ? <Loader2 className="w-4 h-4 animate-spin" /> : <Package className="w-4 h-4" />}<span className="absolute top-full right-0 mt-2 hidden group-hover:block bg-slate-900 text-white text-[8px] font-black uppercase px-2 py-1 rounded whitespace-nowrap">Export Project ZIP</span></button>
      </div>
    </header>
  );

  const ClusterEditor: React.FC<{ cluster: Cluster, onClose: () => void }> = ({ cluster, onClose }) => {
    const [draft, setDraft] = useState<Cluster>({ ...cluster });
    const updateField = (field: keyof Cluster, value: any) => setDraft(d => ({ ...d, [field]: value }));
    const updateEntityList = (cat: keyof NamedEntities, index: number, field: keyof EntityReference, val: string) => {
      const newList = [...(draft.entities?.[cat] || [])];
      newList[index] = { ...newList[index], [field]: val };
      if (field === 'name') newList[index].id = resolveEntity(val).id;
      updateField('entities', { ...draft.entities, [cat]: newList });
    };
    const addEntity = (cat: keyof NamedEntities) => updateField('entities', { ...draft.entities, [cat]: [...(draft.entities?.[cat] || []), { name: "" }] });
    const deleteEntity = (cat: keyof NamedEntities, index: number) => { const c = [...(draft.entities?.[cat] || [])]; c.splice(index, 1); updateField('entities', { ...draft.entities, [cat]: c }); };
    const updateCorrespondent = (type: 'senders' | 'recipients', index: number, field: keyof Correspondent, val: string) => {
      const newList = [...(draft[type] || [])];
      newList[index] = { ...newList[index], [field]: val };
      if (field === 'name') newList[index].id = resolveEntity(val).id;
      updateField(type, newList);
    };
    const saveChanges = () => { setState(s => ({ ...s, clusters: s.clusters.map(c => c.id === cluster.id ? draft : c) })); onClose(); };
    return (
      <div className="fixed inset-0 z-[200] bg-slate-900/90 backdrop-blur-xl p-8 flex items-center justify-center">
        <div className="bg-white w-full max-w-5xl max-h-[90vh] rounded-[48px] shadow-2xl flex flex-col overflow-hidden border border-white/20">
          <header className="p-8 border-b flex justify-between items-center bg-white shrink-0"><div className="flex items-center gap-4"><div className="w-12 h-12 bg-emerald-600 rounded-2xl flex items-center justify-center text-white shadow-lg"><Edit3 className="w-6 h-6" /></div><div><h2 className="text-2xl font-black italic tracking-tight uppercase">Refine Metadata</h2><p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Doc #{cluster.id}</p></div></div><button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-xl transition-all"><X className="w-8 h-8 text-slate-400" /></button></header>
          <div className="flex-1 overflow-y-auto p-10 custom-scrollbar space-y-12">
            <div className="grid grid-cols-2 gap-10">
              <div className="space-y-6">
                <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Research Title</label><input type="text" value={draft.title} onChange={e => updateField('title', e.target.value)} className="w-full bg-slate-50 border p-4 rounded-2xl text-sm font-bold" /></div>
                <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">AI Summary</label><textarea value={draft.summary} onChange={e => updateField('summary', e.target.value)} className="w-full bg-slate-50 border p-4 rounded-2xl text-sm font-medium h-32 resize-none" /></div>
              </div>
              <div className="space-y-6 bg-slate-50 p-8 rounded-[32px] border border-slate-100">
                <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Document Types</label><input type="text" value={(draft.docTypes || []).join(', ')} onChange={e => updateField('docTypes', e.target.value.split(',').map(s => s.trim()))} className="w-full bg-white border p-3 rounded-xl text-xs font-bold" /></div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Original Date</label><input type="text" value={draft.originalDate || ""} onChange={e => updateField('originalDate', e.target.value)} className="w-full bg-white border p-3 rounded-xl text-xs font-bold" /></div>
                  <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">ISO Date</label><input type="text" placeholder="YYYY-MM-DD" value={draft.standardizedDate || ""} onChange={e => setDraft(d => ({ ...d, standardizedDate: e.target.value }))} className="w-full bg-white border p-3 rounded-xl text-xs font-bold" /></div>
                </div>
                <div className="space-y-2"><label className="text-[10px] font-black uppercase text-slate-400 tracking-widest">Subjects</label><input type="text" value={(draft.subjects || []).join(', ')} onChange={e => updateField('subjects', e.target.value.split(',').map(s => s.trim()))} className="w-full bg-white border p-3 rounded-xl text-xs font-bold" /></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-10">
              <section className="space-y-4">
                <div className="flex items-center justify-between"><h3 className="text-xs font-black uppercase tracking-widest text-slate-800 flex items-center gap-2"><User className="w-4 h-4 text-emerald-500" /> Senders</h3><button onClick={() => updateField('senders', [...(draft.senders || []), { name: "" }])} className="p-1 hover:bg-slate-100 rounded-lg text-emerald-600"><Plus className="w-4 h-4" /></button></div>
                <div className="space-y-2">{(draft.senders || []).map((s, idx) => (<div key={idx} className="flex gap-2 items-center bg-white p-3 border rounded-xl shadow-sm"><div className="flex-1"><input type="text" value={s.name} onChange={e => updateCorrespondent('senders', idx, 'name', e.target.value)} placeholder="Name" className="text-xs font-bold w-full outline-none" /><input type="text" value={s.role || ""} onChange={e => updateCorrespondent('senders', idx, 'role', e.target.value)} placeholder="Assign Role" className="text-[10px] text-slate-400 italic outline-none w-full" /></div><button onClick={() => { const nl = [...(draft.senders || [])]; nl.splice(idx, 1); updateField('senders', nl); }} className="text-slate-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button></div>))}</div>
              </section>
              <section className="space-y-4">
                <div className="flex items-center justify-between"><h3 className="text-xs font-black uppercase tracking-widest text-slate-800 flex items-center gap-2"><Mail className="w-4 h-4 text-purple-500" /> Recipients</h3><button onClick={() => updateField('recipients', [...(draft.recipients || []), { name: "" }])} className="p-1 hover:bg-slate-100 rounded-lg text-purple-600"><Plus className="w-4 h-4" /></button></div>
                <div className="space-y-2">{(draft.recipients || []).map((r, idx) => (<div key={idx} className="flex gap-2 items-center bg-white p-3 border rounded-xl shadow-sm"><div className="flex-1"><input type="text" value={r.name} onChange={e => updateCorrespondent('recipients', idx, 'name', e.target.value)} placeholder="Name" className="text-xs font-bold w-full outline-none" /><input type="text" value={r.role || ""} onChange={e => updateCorrespondent('recipients', idx, 'role', e.target.value)} placeholder="Assign Role" className="text-[10px] text-slate-400 italic outline-none w-full" /></div><button onClick={() => { const nl = [...(draft.recipients || [])]; nl.splice(idx, 1); updateField('recipients', nl); }} className="text-slate-300 hover:text-red-500"><Trash2 className="w-4 h-4" /></button></div>))}</div>
              </section>
            </div>
            <div className="grid grid-cols-3 gap-8 pt-8 border-t border-slate-100">{(['people', 'organizations', 'roles'] as (keyof NamedEntities)[]).map(cat => (<section key={cat} className="space-y-4"><div className="flex items-center justify-between"><h4 className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">{cat}</h4><button onClick={() => addEntity(cat)} className="p-1 hover:bg-slate-100 rounded text-slate-400"><Plus className="w-3 h-3" /></button></div><div className="space-y-2">{(draft.entities?.[cat] || []).map((ent, idx) => (<div key={idx} className="flex items-center gap-2 group"><input type="text" value={ent.name} onChange={e => updateEntityList(cat, idx, 'name', e.target.value)} className={`flex-1 text-[10px] font-bold p-2.5 rounded-lg border transition-all ${ent.id ? 'bg-indigo-50 border-indigo-600 text-indigo-900 shadow-sm' : 'bg-white border-slate-200 focus:border-emerald-500'}`} /><button onClick={() => deleteEntity(cat, idx)} className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 p-1 transition-all"><X className="w-3.5 h-3.5" /></button></div>))}</div></section>))}</div>
          </div>
          <footer className="p-8 border-t bg-slate-50 flex justify-end gap-3"><button onClick={onClose} className="px-6 py-3 rounded-2xl font-black uppercase text-xs text-slate-500 hover:bg-slate-100">Cancel</button><button onClick={saveChanges} className="px-10 py-3 bg-slate-900 text-white rounded-2xl font-black uppercase text-xs shadow-2xl hover:bg-emerald-600 transition-all">Commit Research</button></footer>
        </div>
      </div>
    );
  };

  const renderClustering = () => (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {renderCommonHeader(<button onClick={async () => { setState(s => ({ ...s, processingStatus: { total: state.files.length, processed: 0, currentStep: 'Running Gemini Cluster Analysis...', isComplete: false } })); try { const clusters = await clusterPages(state.files, state.tier); setState(s => ({ ...s, clusters, processingStatus: { ...s.processingStatus, isComplete: true } })); } catch (e) { alert("Clustering failed."); } }} className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2 rounded-xl text-xs font-black uppercase tracking-tight flex items-center gap-2 shadow-lg"><Sparkles className="w-4 h-4" /> AI Document Indexing</button>)}
      <div className="flex-1 p-12 overflow-y-auto custom-scrollbar">
        <div className="max-w-7xl mx-auto space-y-12">
          <div className="flex justify-between items-end mb-8"><div><h2 className="text-4xl font-black text-slate-900 tracking-tighter uppercase italic">Clustered Documents</h2><p className="text-slate-400 font-bold text-sm mt-1">Cross-referencing content, handwriting, and temporal data</p></div></div>
          {state.clusters.map(c => (
            <div key={c.id} className="bg-white rounded-[40px] border border-slate-200 overflow-hidden shadow-sm hover:shadow-2xl transition-all p-12 group relative">
              <button onClick={() => setEditingClusterId(c.id)} className="absolute top-12 right-12 p-3.5 bg-slate-50 text-slate-400 hover:bg-slate-900 hover:text-white rounded-2xl transition-all opacity-0 group-hover:opacity-100"><Edit3 className="w-5 h-5" /></button>
              <div className="flex items-center gap-3 mb-8"><div className="bg-blue-600 text-white text-xs font-black px-5 py-1.5 rounded-full uppercase">Doc #{c.id}</div><div className="text-slate-300 font-black uppercase text-[10px] tracking-widest">{c.pageRange}</div></div>
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-16">
                 <div className="lg:col-span-8 space-y-8"><h3 className="text-3xl font-black text-slate-800 leading-tight tracking-tight">{c.title}</h3><p className="text-slate-500 leading-relaxed text-base font-medium italic border-l-4 border-slate-100 pl-6">{c.summary}</p><div className="flex flex-wrap gap-2.5">{c.subjects?.map(s => renderBadge(s, 'subjects'))}</div></div>
                 <div className="lg:col-span-4 bg-slate-50/50 rounded-[32px] p-8 border border-slate-100 space-y-6">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest border-b pb-2">Research Metadata</h4>
                    <div className="space-y-4">
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><Calendar className="w-4 h-4 text-indigo-600" /> {c.standardizedDate || c.originalDate || 'Unidentified Date'}</div>
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><MapPin className="w-4 h-4 text-red-500" /> {c.prisonName || 'Repository Unknown'}</div>
                        <div className="flex items-center gap-3 text-xs font-bold text-slate-700"><FileText className="w-4 h-4 text-orange-500" /> {(c.docTypes || []).join(', ')}</div>
                    </div>
                    <div className="space-y-6 pt-4 border-t">
                      <div><div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3"><User className="w-3 h-3" /> Senders</div><div className="space-y-3">{c.senders?.length ? c.senders.map((s, idx) => (<div key={idx} className="flex flex-col pl-6 relative"><div className={`absolute left-1.5 top-1.5 w-1.5 h-1.5 rounded-full ${s.id ? 'bg-indigo-600' : 'bg-emerald-400'}`} /><div className="text-xs font-bold text-slate-800">{s.name}</div>{s.role && <div className="text-[9px] font-bold text-slate-400 italic mt-0.5 uppercase">{s.role}</div>}</div>)) : <div className="text-[10px] text-slate-300 italic pl-6">Unidentified</div>}</div></div>
                      <div><div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-400 mb-3"><Mail className="w-3 h-3" /> Recipients</div><div className="space-y-3">{c.recipients?.length ? c.recipients.map((r, idx) => (<div key={idx} className="flex flex-col pl-6 relative"><div className={`absolute left-1.5 top-1.5 w-1.5 h-1.5 rounded-full ${r.id ? 'bg-indigo-600' : 'bg-purple-400'}`} /><div className="text-xs font-bold text-slate-800">{r.name}</div>{r.role && <div className="text-[9px] font-bold text-slate-400 italic mt-0.5 uppercase">{r.role}</div>}</div>)) : <div className="text-[10px] text-slate-300 italic pl-6">Unidentified</div>}</div></div>
                    </div>
                 </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-10 mt-12 pt-12 border-t">
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><Users className="w-4 h-4 text-blue-500" /> People</h4><div className="flex flex-wrap gap-2">{c.entities?.people?.map(p => renderBadge(p, 'people'))}</div></div>
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><Building className="w-4 h-4 text-purple-500" /> Organizations</h4><div className="flex flex-wrap gap-2">{c.entities?.organizations?.map(o => renderBadge(o, 'orgs'))}</div></div>
                 <div><h4 className="flex items-center gap-2 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] mb-5"><RoleIcon className="w-4 h-4 text-orange-500" /> Roles</h4><div className="flex flex-wrap gap-2">{c.entities?.roles?.map(r => renderBadge(r, 'roles'))}</div></div>
              </div>
              <div className="mt-12 flex gap-4 overflow-x-auto pb-4 custom-scrollbar">
                 {c.pageIds.map(pid => { const p = state.files.find(f => f.id === pid); return p ? <div key={pid} className="relative group/img shrink-0"><img src={p.previewUrl} className="h-32 w-24 object-cover rounded-xl border border-slate-200 cursor-zoom-in hover:scale-105 transition-all shadow-sm" onClick={() => setZoomedPageId(p.id)} /></div> : null; })}
              </div>
            </div>
          ))}
        </div>
      </div>
      {editingClusterId && <ClusterEditor cluster={state.clusters.find(c => c.id === editingClusterId)!} onClose={() => setEditingClusterId(null)} />}
    </div>
  );

  const renderDashboard = () => {
    const isAnalysisActive = !state.processingStatus.isComplete && state.processingStatus.currentStep.includes('Analyzing');
    const isTranscribingActive = !state.processingStatus.isComplete && state.processingStatus.currentStep.includes('OCR');
    const isBatchActive = isAnalysisActive || isTranscribingActive;
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
            }} disabled={isBatchActive} className={`px-6 py-2.5 rounded-2xl text-xs font-black uppercase tracking-widest flex items-center gap-2 shadow-xl active:scale-95 transition-all border-b-4 ${isBatchActive ? 'bg-slate-300 text-slate-500 border-slate-400 grayscale' : 'bg-blue-600 hover:bg-blue-700 text-white border-blue-800'}`}>{isTranscribingActive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bot className="w-4 h-4" />} Transcribe</button>
        )}
        <div className="flex-1 overflow-auto p-8 custom-scrollbar">
          <div className="max-w-[1500px] mx-auto space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6"><div className="relative flex-1 w-full"><Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" /><input type="text" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} placeholder="Filter pages..." className="w-full bg-white border border-slate-200 rounded-2xl py-3 pl-12 pr-4 text-sm font-medium outline-none" /></div><div className="flex items-center gap-4 shrink-0"><div className="flex items-center gap-2 bg-slate-200/50 p-1.5 rounded-2xl border border-slate-200"><span className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">OCR:</span><button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranscribe: true })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">All</button><button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranscribe: false })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">None</button></div><div className="flex items-center gap-2 bg-slate-200/50 p-1.5 rounded-2xl border border-slate-200"><span className="text-[10px] font-black uppercase text-slate-400 px-2 tracking-widest">EN:</span><button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranslate: true })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">All</button><button onClick={() => setState(s => ({ ...s, files: s.files.map(f => ({ ...f, shouldTranslate: false })) }))} className="px-3 py-1.5 bg-white border rounded-xl text-[10px] font-black uppercase text-slate-500">None</button></div></div></div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-8">
              {filteredPages.map(page => (
                <div key={page.id} className="bg-white rounded-[32px] border border-slate-200 overflow-hidden group hover:border-blue-500 hover:shadow-2xl transition-all flex flex-col shadow-sm">
                  <div className="relative aspect-[4/5] overflow-hidden bg-slate-100 cursor-zoom-in" onClick={() => setZoomedPageId(page.id)}><img src={page.previewUrl} alt={page.indexName} className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-110" style={{ transform: `rotate(${page.rotation || 0}deg)` }} /><div className="absolute top-4 left-4 flex flex-col gap-2"><div className="bg-white/95 backdrop-blur-sm px-3 py-1.5 rounded-xl text-[10px] font-black text-slate-800 shadow-xl uppercase tracking-tighter">{page.indexName.split('-').pop()?.trim()}</div>{page.hasHebrewHandwriting && <div className="bg-amber-500 px-3 py-1.5 rounded-xl text-[10px] font-black text-white shadow-xl flex items-center gap-1.5 uppercase tracking-tighter"><Flag className="w-3 h-3" /> HBW</div>}</div><div className="absolute top-4 right-4">{renderConfidence(page.confidenceScore)}</div><div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-2"><button onClick={(e) => { e.stopPropagation(); setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, rotation: ((f.rotation || 0) - 90 + 360) % 360 } : f) })); }} className="p-3 bg-white rounded-2xl shadow-2xl hover:bg-slate-900 hover:text-white transition-all"><RotateCcw className="w-5 h-5" /></button><button onClick={(e) => { e.stopPropagation(); setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, rotation: ((f.rotation || 0) + 90) % 360 } : f) })); }} className="p-3 bg-white rounded-2xl shadow-2xl hover:bg-slate-900 hover:text-white transition-all"><RotateCw className="w-5 h-5" /></button></div></div>
                  <div className="p-6 flex-1 flex flex-col gap-5">
                    <div>
                      <h4 className="font-black text-slate-800 truncate text-sm tracking-tight mb-1">{page.indexName}</h4>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[10px] text-slate-400 font-mono truncate flex-1">{page.fileName}</p>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {page.productionMode && (
                            <span className="text-[8px] font-black uppercase tracking-widest text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-100" title="Production Mode">
                              {page.productionMode}
                            </span>
                          )}
                          <span className="text-[8px] font-black uppercase tracking-widest text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100" title="Detected Language">
                            {page.language || '...'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">{page.entities?.people?.slice(0, 3).map(p => renderBadge(p, 'people'))}</div>
                    <div className="mt-auto pt-5 border-t flex flex-col gap-4">
                      <div className="flex items-center justify-between"><label className="flex items-center gap-2 cursor-pointer select-none group/cb"><div className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-all ${page.shouldTranscribe ? 'bg-blue-600 border-blue-600' : 'bg-white border-slate-300'}`}>{page.shouldTranscribe && <CheckSquare className="w-4 h-4 text-white" />}</div><input type="checkbox" className="hidden" checked={page.shouldTranscribe} onChange={e => setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, shouldTranscribe: e.target.checked } : f) }))} /><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">OCR</span></label><label className="flex items-center gap-2 cursor-pointer select-none group/cb"><div className={`w-5 h-5 rounded-lg border flex items-center justify-center transition-all ${page.shouldTranslate ? 'bg-emerald-600 border-emerald-600' : 'bg-white border-slate-300'}`}>{page.shouldTranslate && <CheckSquare className="w-4 h-4 text-white" />}</div><input type="checkbox" className="hidden" checked={page.shouldTranslate} onChange={e => setState(s => ({ ...s, files: s.files.map(f => f.id === page.id ? { ...f, shouldTranslate: e.target.checked } : f) }))} /><span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">EN</span></label></div>
                      <div className="flex gap-2"><button onClick={() => setExpandedField({ pageId: page.id, field: 'manualTranscription', label: 'Transcription Editor' })} className="flex-1 py-2 rounded-xl bg-slate-50 text-[10px] font-black uppercase text-slate-600 hover:bg-slate-900 hover:text-white transition-all border shadow-sm flex items-center justify-center gap-2"><Edit3 className="w-3.5 h-3.5" /> OCR</button><button onClick={() => setExpandedField({ pageId: page.id, field: 'manualDescription', label: 'Notes' })} className="flex-1 py-2 rounded-xl bg-slate-50 text-[10px] font-black uppercase text-slate-600 hover:bg-slate-900 hover:text-white transition-all border shadow-sm flex items-center justify-center gap-2"><StickyNote className="w-3.5 h-3.5" /> Notes</button></div>
                      {page.status === 'transcribing' && <div className="h-1 bg-slate-100 rounded-full overflow-hidden"><div className="h-full bg-blue-500 animate-pulse" style={{ width: '100%' }} /></div>}
                      {page.status === 'error' && <div className="text-[9px] font-black text-red-500 uppercase flex items-center gap-1 justify-center"><AlertTriangle className="w-3 h-3" /> Error</div>}
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

  const renderEntityExplorer = () => (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {renderCommonHeader()}
      <div className="flex-1 flex overflow-hidden">
        <div className="w-1/2 overflow-auto p-12 custom-scrollbar bg-white border-r">
          <div className="mb-12"><h2 className="text-4xl font-black text-slate-900 tracking-tighter uppercase italic">Research Map</h2><p className="text-slate-400 font-bold text-sm mt-1">Cross-referencing entities across docs</p></div>
          <div className="space-y-12">
             <section><h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.3em] mb-6 flex items-center gap-2"><UserCheck className="w-4 h-4 text-blue-500" /> People ({allEntities.people.length})</h3><div className="grid grid-cols-1 gap-3">{allEntities.people.sort((a,b) => b.ids.length - a.ids.length).map(p => (<div key={p.name} onClick={() => setSelectedEntity({name: p.name, type: 'person'})} className={`flex items-center justify-between p-4 rounded-2xl border cursor-pointer ${selectedEntity?.name === p.name ? 'bg-blue-600 border-blue-600 text-white shadow-xl shadow-blue-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}><div className="flex items-center gap-3"><div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs ${selectedEntity?.name === p.name ? 'bg-white/20' : 'bg-blue-100 text-blue-600'}`}>{p.name[0]}</div><span className="font-bold text-sm">{p.name}</span></div><div className="flex items-center gap-2"><span className={`text-[10px] font-black uppercase tracking-widest ${selectedEntity?.name === p.name ? 'text-blue-100' : 'text-slate-400'}`}>{p.ids.length} docs</span><ChevronRight className={`w-4 h-4 transition-transform ${selectedEntity?.name === p.name ? 'rotate-90' : ''}`} /></div></div>))}</div></section>
             <section><h3 className="text-xs font-black text-slate-400 uppercase tracking-[0.3em] mb-6 flex items-center gap-2"><RoleIcon className="w-4 h-4 text-orange-500" /> Roles ({allEntities.roles.length})</h3><div className="grid grid-cols-1 gap-3">{allEntities.roles.sort((a,b) => b.ids.length - a.ids.length).map(r => (<div key={r.name} onClick={() => setSelectedEntity({name: r.name, type: 'role'})} className={`flex items-center justify-between p-4 rounded-2xl border cursor-pointer ${selectedEntity?.name === r.name ? 'bg-orange-600 border-orange-600 text-white shadow-xl shadow-orange-200' : 'bg-slate-50 border-slate-100 hover:bg-slate-100'}`}><div className="flex items-center gap-3"><div className={`w-8 h-8 rounded-full flex items-center justify-center font-black text-xs ${selectedEntity?.name === r.name ? 'bg-white/20' : 'bg-orange-100 text-orange-600'}`}><RoleIcon className="w-4 h-4" /></div><span className="font-bold text-sm">{r.name}</span></div><div className="flex items-center gap-2"><span className={`text-[10px] font-black uppercase tracking-widest ${selectedEntity?.name === r.name ? 'text-orange-100' : 'text-slate-400'}`}>{r.ids.length} docs</span><ChevronRight className={`w-4 h-4 transition-transform ${selectedEntity?.name === r.name ? 'rotate-90' : ''}`} /></div></div>))}</div></section>
          </div>
        </div>
        <div className="w-1/2 flex items-center justify-center p-12 text-center bg-slate-50/50">
           {selectedEntity ? (
             <div className="w-full max-w-lg space-y-8 animate-in slide-in-from-right-4 duration-300">
                <div className="space-y-2"><div className={`w-20 h-20 rounded-3xl flex items-center justify-center text-3xl font-black mx-auto shadow-xl ${selectedEntity.type === 'person' ? 'bg-blue-600 text-white' : 'bg-orange-600 text-white'}`}>{selectedEntity.type === 'person' ? <User className="w-10 h-10" /> : <RoleIcon className="w-10 h-10" />}</div><h3 className="text-3xl font-black text-slate-900 tracking-tight">{selectedEntity.name}</h3></div>
                <div className="space-y-4"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Appearances</h4><div className="grid grid-cols-1 gap-2">{(allEntities.people.find(p => p.name === selectedEntity.name)?.ids || allEntities.roles.find(r => r.name === selectedEntity.name)?.ids || []).map((id, i) => (<div key={i} className="bg-white p-4 rounded-xl border border-slate-200 text-left font-bold text-sm text-slate-700 flex items-center justify-between group hover:border-blue-500 transition-all cursor-pointer"><span>{id}</span><ExternalLink className="w-4 h-4 text-slate-300 group-hover:text-blue-500" /></div>))}</div></div>
             </div>
           ) : (
             <div><Users className="w-16 h-16 mx-auto mb-4 opacity-20" /><h3 className="text-xl font-black text-slate-800 tracking-tight">Select Pivot</h3><p className="text-sm font-medium mt-1 text-slate-400">Map connections landscape</p></div>
           )}
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen w-full bg-slate-50 font-sans selection:bg-blue-100">
      {state.uiState === 'welcome' ? renderWelcome() : (
        <>
          <aside className={`bg-white border-r flex flex-col transition-all duration-300 ${isSidebarOpen ? 'w-80' : 'w-0 overflow-hidden border-none'}`}>
            <div className="p-6 border-b flex items-center justify-between shrink-0"><div className="flex items-center gap-2"><div className="w-8 h-8 bg-slate-900 rounded-lg flex items-center justify-center"><Sparkles className="w-5 h-5 text-white" /></div><span className="font-black italic uppercase tracking-tighter text-xl">Archival Lens</span></div><button onClick={() => setIsSidebarOpen(false)} className="p-1 hover:bg-slate-100 rounded-lg"><PanelLeft className="w-4 h-4 text-slate-400" /></button></div>
            <div className="flex-1 overflow-y-auto p-6 space-y-8 custom-scrollbar">
              <div className="space-y-4"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Active Stack</h4><div className="bg-slate-50 p-5 rounded-3xl border shadow-inner"><div className="text-sm font-black text-slate-800 leading-tight mb-1">{projectTitle}</div><div className="text-[10px] font-bold text-slate-400 uppercase truncate">{archiveName || 'Repository Unassigned'}</div></div></div>
              <div className="space-y-6"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Pivots</h4><div className="space-y-4"><div className="space-y-1"><label className="text-[9px] font-bold text-slate-400 uppercase">Lang</label><select value={filterLanguage} onChange={e => setFilterLanguage(e.target.value)} className="w-full bg-slate-50 border rounded-xl px-3 py-2 text-xs font-bold"><option value="All">All</option>{Array.from(new Set(state.files.map(f => f.language).filter(Boolean))).map(l => <option key={l} value={l}>{l}</option>)}</select></div></div></div>
            </div>
            <div className="p-6 border-t bg-slate-50/50"><button onClick={() => setState(s => ({ ...s, uiState: 'welcome' }))} className="w-full flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-500 transition-colors py-2"><X className="w-3.5 h-3.5" /> Close</button></div>
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
                              <div className="flex-1 space-y-1">
                                <label className="text-[9px] font-bold text-slate-400 uppercase">Start Page</label>
                                <input type="number" min={1} max={state.files.length} value={rangeStart} onChange={e => setRangeStart(Math.max(1, parseInt(e.target.value) || 1))} className="w-full p-3 bg-white border rounded-xl text-xs font-bold shadow-sm" />
                              </div>
                              <div className="pt-4 text-slate-300 font-black">TO</div>
                              <div className="flex-1 space-y-1">
                                <label className="text-[9px] font-bold text-slate-400 uppercase">End Page</label>
                                <input type="number" min={rangeStart} max={state.files.length} value={rangeEnd} onChange={e => setRangeEnd(Math.min(state.files.length, Math.max(rangeStart, parseInt(e.target.value) || 1)))} className="w-full p-3 bg-white border rounded-xl text-xs font-bold shadow-sm" />
                              </div>
                            </div>
                          )}
                          <div className="mt-4 text-[10px] font-bold text-slate-400 uppercase text-center">Total Uploaded: {state.files.length} pages</div>
                        </div>

                        <button onClick={async () => {
                          let finalFiles = [...state.files];
                          if (useRange) { 
                            finalFiles = finalFiles.slice(rangeStart - 1, rangeEnd); 
                            setPageRange({ start: rangeStart, end: rangeEnd }); 
                          } else { 
                            setPageRange(null); 
                          }
                          setState(s => ({ ...s, files: finalFiles, uiState: 'dashboard', archiveName, processingStatus: { total: finalFiles.length, processed: 0, currentStep: 'Analyzing Topography...', isComplete: false } }));
                          (async () => {
                            const concurrency = state.tier === Tier.PAID ? 5 : 2; 
                            for (let i = 0; i < finalFiles.length; i += concurrency) {
                              await Promise.all(finalFiles.slice(i, i + concurrency).map(async (p) => {
                                setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, status: 'analyzing' } : f) }));
                                try { const res = await analyzePageContent(p, state.tier); setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, ...res } : f), processingStatus: { ...prev.processingStatus, processed: prev.processingStatus.processed + 1 } })); } 
                                catch (e) { setState(prev => ({ ...prev, files: prev.files.map(f => f.id === p.id ? { ...f, status: 'error' } : f) })); }
                              }));
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
             {state.uiState === 'entities' && renderEntityExplorer()}
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
                  {(() => {
                      const currentPage = state.files.find(f => f.id === expandedField.pageId);
                      const currentVal = (currentPage as any)?.[expandedField.field];
                      const aiFallback = expandedField.field === 'manualTranscription' ? currentPage?.generatedTranscription : (expandedField.field === 'manualDescription' ? currentPage?.generatedTranslation : null);
                      return (
                          <div className="flex-1 flex flex-col relative">
                              <textarea className="flex-1 border-2 border-slate-100 rounded-[40px] p-10 font-mono text-base outline-none focus:border-blue-500 bg-slate-50 shadow-inner leading-relaxed resize-none" value={currentVal || ''} placeholder={aiFallback ? "Loading AI Draft..." : "Start typing..."} dir={getTextDirection(currentVal || aiFallback || '')} onChange={e => setState(s => ({ ...s, files: s.files.map(f => f.id === expandedField.pageId ? { ...f, [expandedField.field]: e.target.value } : f) }))} />
                              {(!currentVal && aiFallback) && (<div className="absolute inset-0 p-10 font-mono text-base pointer-events-none opacity-40 italic whitespace-pre-wrap overflow-hidden" dir={getTextDirection(aiFallback)}>{aiFallback}</div>)}
                          </div>
                      );
                  })()}
                  <div className="grid grid-cols-2 gap-4 mt-8"><button onClick={() => setExpandedField(null)} className="bg-slate-100 text-slate-500 py-5 rounded-[28px] font-black uppercase hover:bg-slate-200 transition-all">Discard</button><button onClick={() => setExpandedField(null)} className="bg-slate-900 text-white py-5 rounded-[28px] font-black uppercase hover:bg-blue-600 transition-all active:scale-95 shadow-xl">Commit</button></div>
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

export default App;
