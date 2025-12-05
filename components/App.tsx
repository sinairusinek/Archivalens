import React, { useState, useEffect, useRef } from 'react';
import { 
  FolderOpen, FileText, Upload, Settings, Play, Download, 
  CheckCircle, Loader2, AlertCircle, Maximize2, X, Flag, CheckSquare, Square, Info, ExternalLink, Languages, FileUp, Split, Edit3, Bot,
  ZoomIn, ZoomOut, Type, MapPin, Users, Building, Calendar, Mail, User, Filter, Cloud, Code
} from 'lucide-react';
import { ArchivalPage, AppState, AnalysisMode, Tier, ProcessingStatus, Cluster } from '../types';
import { analyzePageContent, transcribeAndTranslatePage, clusterPages } from '../services/geminiService';
import { generateTSV, generateClustersTSV, generateFullJSON, downloadFile } from '../utils/fileUtils';

const INITIAL_STATE: AppState = {
  apiKey: process.env.API_KEY || null,
  mode: null,
  tier: Tier.FREE,
  files: [],
  clusters: [],
  processingStatus: {
    total: 0,
    processed: 0,
    currentStep: 'idle',
    isComplete: false,
  },
  uiState: 'welcome',
};

// Helper to detect if text contains Hebrew for RTL direction
const getTextDirection = (text: string | undefined): 'rtl' | 'ltr' => {
  if (!text) return 'ltr';
  const hebrewRegex = /[\u0590-\u05FF]/;
  return hebrewRegex.test(text) ? 'rtl' : 'ltr';
};

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(INITIAL_STATE);
  const [pageRange, setPageRange] = useState<{start: number, end: number} | null>(null);
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [customFolderName, setCustomFolderName] = useState<string>("");
  const [projectTitle, setProjectTitle] = useState<string>("Archival Project");
  const [expandedField, setExpandedField] = useState<{ pageId: string, field: 'manualTranscription' | 'manualDescription' | 'translation', label: string } | null>(null);
  const [showCredits, setShowCredits] = useState(false);
  const [isProcessingPDF, setIsProcessingPDF] = useState(false);
  const [isConnectingDrive, setIsConnectingDrive] = useState(false);
  const [todoNotes, setTodoNotes] = useState<string>(() => localStorage.getItem("archivalLens_todo") || "");
  
  // Filtering state
  const [filterLanguage, setFilterLanguage] = useState<string>("All");
  const [filterProductionMode, setFilterProductionMode] = useState<string>("All");
  
  // Workstation view controls
  const [imageZoom, setImageZoom] = useState(1);
  const [editorFontSize, setEditorFontSize] = useState(14);

  // --- Helpers for Select All ---
  const allTranscribe = state.files.length > 0 && state.files.every(f => f.shouldTranscribe);
  const allTranslate = state.files.length > 0 && state.files.every(f => f.shouldTranslate);
  const allDownload = state.files.length > 0 && state.files.every(f => f.shouldDownloadImage);

  const toggleAllTranscribe = () => {
    setState(s => ({...s, files: s.files.map(f => ({...f, shouldTranscribe: !allTranscribe}))}));
  };

  const toggleAllTranslate = () => {
    setState(s => ({...s, files: s.files.map(f => ({...f, shouldTranslate: !allTranslate}))}));
  };

  const toggleAllDownload = () => {
    setState(s => ({...s, files: s.files.map(f => ({...f, shouldDownloadImage: !allDownload}))}));
  };

  // Reset zoom when opening workstation
  useEffect(() => {
    if (expandedField) {
      setImageZoom(1);
      setEditorFontSize(14);
    }
  }, [expandedField]);

  // Save To-Do notes to local storage
  useEffect(() => {
    localStorage.setItem("archivalLens_todo", todoNotes);
  }, [todoNotes]);

  // --- Handlers ---

  const processTiff = async (file: File): Promise<string> => {
    try {
      const buffer = await file.arrayBuffer();
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
          return canvas.toDataURL('image/png');
        }
      }
    } catch (e) {
      console.error("Failed to process TIFF", e);
    }
    return ''; // Fail silently or with placeholder
  };

  const processPdf = async (pdfFile: File): Promise<File[]> => {
    try {
      const arrayBuffer = await pdfFile.arrayBuffer();
      // @ts-ignore
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      const images: File[] = [];
      
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const scale = 2.0; // Higher scale for better OCR/Analysis
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        if (context) {
            await page.render({ canvasContext: context, viewport: viewport }).promise;
            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
            if (blob) {
                images.push(new File([blob], `${pdfFile.name.replace('.pdf', '')}_page_${i}.jpg`, { type: 'image/jpeg' }));
            }
        }
      }
      return images;
    } catch (e) {
      console.error("PDF processing error", e);
      alert("Failed to process PDF. Please ensure it is a valid PDF file.");
      return [];
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: AnalysisMode) => {
    if (e.target.files && e.target.files.length > 0) {
      let fileList: File[] = Array.from(e.target.files);
      
      if (mode === AnalysisMode.PDF) {
        setIsProcessingPDF(true);
        // Expect single PDF
        const pdfFile = fileList[0];
        setProjectTitle(pdfFile.name.replace(/\.[^/.]+$/, ""));
        
        // Convert PDF to images
        fileList = await processPdf(pdfFile);
        setIsProcessingPDF(false);
        
        if (fileList.length === 0) return; // Error occurred

      } else {
        // FOLDER Mode or DRIVE Mode
        // Sort files by name (requirement B)
        fileList = fileList.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        // Priority: 1. Custom entered name, 2. Detected folder name from path, 3. Fallback
        const detectedFolderName = (fileList[0] as any).webkitRelativePath 
          ? (fileList[0] as any).webkitRelativePath.split('/')[0] 
          : "";
          
        const folderName = customFolderName.trim() || detectedFolderName || "Folder Analysis";
        setProjectTitle(folderName);
      }

      // Process files (async for TIF support)
      const newFiles = await Promise.all(fileList.map(async (f, index) => {
        let previewUrl = '';
        const isTiff = f.type === 'image/tiff' || f.name.toLowerCase().endsWith('.tif') || f.name.toLowerCase().endsWith('.tiff');
        
        if (isTiff) {
          previewUrl = await processTiff(f);
        } else {
          previewUrl = URL.createObjectURL(f);
        }

        let indexName = '';
        if (mode === AnalysisMode.FOLDER || mode === AnalysisMode.DRIVE) {
          // Use custom folder name if provided, otherwise try path, otherwise default
          const relativePath = (f as any).webkitRelativePath;
          const folderLabel = customFolderName.trim() || (relativePath ? relativePath.split('/')[0] : 'Folder');
          indexName = `${folderLabel} - ${f.name}`;
        } else {
          // PDF mode naming
          indexName = `${projectTitle || 'PDF'} - Pg ${index + 1}`;
        }

        return {
          id: crypto.randomUUID(),
          fileName: f.name,
          indexName: indexName,
          fileObj: f,
          previewUrl: previewUrl || 'https://via.placeholder.com/150?text=No+Preview',
          shouldTranscribe: false,
          shouldTranslate: false,
          status: 'pending',
          shouldDownloadImage: false,
        } as ArchivalPage;
      }));

      setState(prev => ({
        ...prev,
        mode,
        files: newFiles,
        uiState: 'config'
      }));
    }
  };

  const handleDriveConnect = () => {
    setIsConnectingDrive(true);
    // Simulate authentication delay
    setTimeout(() => {
        setIsConnectingDrive(false);
        // Trigger the folder input as a fallback/simulation for selecting "Drive" folders synced to the OS
        const driveInput = document.getElementById('drive-folder-input');
        if (driveInput) {
            driveInput.click();
        }
    }, 1500);
  };

  const handleTranscriptionUpload = (e: React.ChangeEvent<HTMLInputElement>, pageId: string) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const text = event.target?.result as string;
        setState(s => ({
          ...s,
          files: s.files.map(f => f.id === pageId ? { ...f, manualTranscription: text } : f)
        }));
      };
      reader.readAsText(file);
    }
  };

  const startAnalysis = async () => {
    // Apply Range Filter
    let filesToProcess = state.files;
    if (pageRange) {
      filesToProcess = state.files.slice(pageRange.start - 1, pageRange.end);
    }
    
    setState(prev => ({
      ...prev,
      files: filesToProcess, 
      uiState: 'dashboard',
      processingStatus: {
        total: filesToProcess.length,
        processed: 0,
        currentStep: 'Analyzing Metadata...',
        isComplete: false
      }
    }));

    // Start Batch Processing for Step C (Metadata)
    processBatch(filesToProcess, 'METADATA');
  };

  const processBatch = async (files: ArchivalPage[], type: 'METADATA' | 'TRANSCRIPTION') => {
    // Reduce concurrency for free tier to avoid 429
    // PAID: 5 parallel requests
    // FREE: 1 request at a time (Sequential) to prevent rate limit hits
    const concurrency = state.tier === Tier.PAID ? 5 : 1; 
    let processedCount = 0;

    const processItem = async (page: ArchivalPage) => {
      setState(prev => ({
        ...prev,
        files: prev.files.map(f => f.id === page.id ? { ...f, status: type === 'METADATA' ? 'analyzing' : 'transcribing' } : f)
      }));

      let result: Partial<ArchivalPage> = {};
      
      if (type === 'METADATA') {
        result = await analyzePageContent(page, state.tier);
      } else {
        if (page.shouldTranscribe || page.shouldTranslate) {
          result = await transcribeAndTranslatePage(page, state.tier);
        } else {
          result = { status: 'done' }; // Skip if not marked
        }
      }

      setState(prev => {
        const updatedFiles = prev.files.map(f => f.id === page.id ? { ...f, ...result } : f);
        return {
          ...prev,
          files: updatedFiles,
          processingStatus: {
            ...prev.processingStatus,
            processed: prev.processingStatus.processed + 1
          }
        };
      });
    };

    // Simple chunk queue
    for (let i = 0; i < files.length; i += concurrency) {
      const chunk = files.slice(i, i + concurrency);
      await Promise.all(chunk.map(processItem));
    }

    setState(prev => ({
      ...prev,
      processingStatus: {
        ...prev.processingStatus,
        isComplete: true,
        currentStep: type === 'METADATA' ? 'Metadata Analysis Complete' : 'Transcription Complete'
      }
    }));
  };

  const runTranscription = () => {
    // Filter pages that need processing
    const toProcess = state.files.filter(f => f.shouldTranscribe || f.shouldTranslate);
    
    setState(prev => ({
      ...prev,
      processingStatus: {
        total: toProcess.length,
        processed: 0,
        currentStep: 'Transcribing & Translating...',
        isComplete: false
      }
    }));

    processBatch(toProcess, 'TRANSCRIPTION');
  };

  const runClustering = async () => {
    setState(prev => ({ ...prev, processingStatus: { ...prev.processingStatus, currentStep: 'Clustering Documents...', isComplete: false } }));
    try {
      // Pass the current tier to the clustering service to choose the appropriate model
      const clusters = await clusterPages(state.files, state.tier);
      setState(prev => ({ 
        ...prev, 
        clusters, 
        uiState: 'clustering',
        processingStatus: { ...prev.processingStatus, currentStep: 'Clustering Complete', isComplete: true }
      }));
    } catch (e) {
      console.error(e);
      alert("Clustering failed. The system will reset the process. Please check your quota or try again.");
      setState(prev => ({ ...prev, processingStatus: { ...prev.processingStatus, currentStep: 'Clustering Failed', isComplete: true } }));
    }
  };

  const runBatchDownload = async () => {
      const selected = state.files.filter(f => f.shouldDownloadImage);
      if(selected.length === 0) return;
      
      for(const page of selected) {
          const a = document.createElement('a');
          a.href = page.previewUrl;
          a.download = page.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          await new Promise(r => setTimeout(r, 500)); // Delay to prevent blocking
      }
  };

  // --- Render Helpers ---

  const renderCreditsModal = () => {
    if (!showCredits) return null;
    return (
      <div className="fixed inset-0 z-[60] bg-slate-900/50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setShowCredits(false)}>
        <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
           <button onClick={() => setShowCredits(false)} className="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
             <X className="w-5 h-5" />
           </button>
           <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-emerald-600 mb-4">About</h2>
           <div className="space-y-4 text-slate-600">
              <p className="font-medium">ArchivalLens AI</p>
              <p className="text-sm">
                An intelligent tool for analyzing, transcribing, and clustering archival documents.
              </p>
              
              <div className="border-t border-slate-100 pt-4 mt-4">
                <p className="text-xs uppercase font-bold text-slate-400 mb-2">Created By</p>
                <div className="flex flex-col">
                    <span className="text-sm font-semibold text-slate-800">Sinai Rusinek</span>
                    <a href="mailto:sinai.rusinek@gmail.com" className="text-sm text-blue-600 hover:underline">sinai.rusinek@gmail.com</a>
                </div>
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className="text-xs uppercase font-bold text-slate-400 mb-2">My To-Do List / Notes</p>
                <textarea 
                    className="w-full h-32 p-3 bg-yellow-50 border border-yellow-200 rounded-lg text-sm text-slate-700 focus:ring-2 focus:ring-yellow-400 outline-none resize-none placeholder-yellow-300"
                    placeholder="Type your notes here... (Saved automatically)"
                    value={todoNotes}
                    dir={getTextDirection(todoNotes)}
                    onChange={(e) => setTodoNotes(e.target.value)}
                />
              </div>

              <div className="border-t border-slate-100 pt-4">
                <p className="text-xs uppercase font-bold text-slate-400 mb-2">Technology</p>
                <p className="text-sm flex items-center gap-2">
                  Powered by Google Gemini 2.5 Flash & Pro
                </p>
              </div>
           </div>
           <div className="mt-6 text-center">
              <button onClick={() => setShowCredits(false)} className="px-6 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-sm font-medium transition-colors">Close</button>
           </div>
        </div>
      </div>
    );
  };

  const renderWelcome = () => (
    <div className="flex flex-col items-center justify-center min-h-screen bg-slate-50 text-slate-900 p-8 relative">
       <button 
          onClick={() => setShowCredits(true)}
          className="absolute top-6 right-6 p-2 text-slate-400 hover:text-blue-600 transition-colors flex items-center gap-2"
        >
          <span className="text-sm font-medium">About</span>
          <Info className="w-5 h-5" />
      </button>

      <h1 className="text-4xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-emerald-600">ArchivalLens AI</h1>
      <p className="text-slate-500 mb-12 text-center max-w-lg">
        Intelligent analysis for your digital archives. Categorize, Transcribe, Translate, and Cluster documents automatically.
      </p>

      {isProcessingPDF && (
        <div className="fixed inset-0 bg-white/80 z-50 flex flex-col items-center justify-center backdrop-blur-sm">
           <Loader2 className="w-12 h-12 text-blue-600 animate-spin mb-4" />
           <p className="text-xl font-medium text-slate-700">Processing PDF...</p>
           <p className="text-sm text-slate-500 mt-2">Converting pages to high-quality images</p>
        </div>
      )}

      {isConnectingDrive && (
        <div className="fixed inset-0 bg-white/80 z-50 flex flex-col items-center justify-center backdrop-blur-sm">
           <Loader2 className="w-12 h-12 text-emerald-600 animate-spin mb-4" />
           <p className="text-xl font-medium text-slate-700">Connecting to Drive...</p>
           <p className="text-sm text-slate-500 mt-2">Authenticating account</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-8 w-full max-w-6xl">
        {/* PDF Option */}
        <div className="bg-white p-8 rounded-xl border border-slate-200 hover:border-blue-500 shadow-sm hover:shadow-md transition-all flex flex-col items-center group">
          <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
            <FileText className="w-8 h-8 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2">PDF Analysis</h2>
          <p className="text-slate-500 text-sm text-center mb-6">Analyze a single PDF file page by page.</p>
          <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white py-2 px-6 rounded-lg font-medium transition-colors shadow">
            Select PDF
            <input type="file" accept=".pdf" className="hidden" onChange={(e) => handleFileUpload(e, AnalysisMode.PDF)} />
          </label>
        </div>

        {/* Folder Option */}
        <div className="bg-white p-8 rounded-xl border border-slate-200 hover:border-emerald-500 shadow-sm hover:shadow-md transition-all flex flex-col items-center group">
          <div className="w-16 h-16 bg-emerald-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
            <FolderOpen className="w-8 h-8 text-emerald-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Folder Analysis</h2>
          <p className="text-slate-500 text-sm text-center mb-6">Analyze a folder of images, sorted by name.</p>
          
          <div className="w-full mb-6">
            <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">
              Folder Name
            </label>
            <input 
              type="text" 
              value={customFolderName}
              onChange={(e) => setCustomFolderName(e.target.value)}
              placeholder="e.g. Vienna_1920_Letters"
              className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
            />
            <p className="text-[10px] text-slate-400 mt-1">
              Enter the archival folder name (not in Hebrew, without spaces).
            </p>
          </div>

          <label className="cursor-pointer bg-emerald-600 hover:bg-emerald-700 text-white py-2 px-6 rounded-lg font-medium transition-colors shadow w-full text-center">
            Select Folder (Images)
            <input type="file" accept="image/*,.tif,.tiff" multiple className="hidden" onChange={(e) => handleFileUpload(e, AnalysisMode.FOLDER)} />
          </label>
           <p className="text-xs text-slate-400 mt-2 italic text-center">*Upload pages as images (JPG, PNG, TIFF)</p>
        </div>

        {/* Google Drive Option */}
        <div className="bg-white p-8 rounded-xl border border-slate-200 hover:border-indigo-500 shadow-sm hover:shadow-md transition-all flex flex-col items-center group relative overflow-hidden">
          {/* Badge */}
          <div className="absolute top-3 right-3 bg-yellow-100 text-yellow-800 text-[10px] font-bold px-2 py-1 rounded-full border border-yellow-200 uppercase tracking-wide">
            Coming Soon
          </div>

          <div className="w-16 h-16 bg-indigo-50 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
            <Cloud className="w-8 h-8 text-indigo-600" />
          </div>
          <h2 className="text-xl font-semibold mb-2">Google Drive</h2>
          <p className="text-slate-500 text-sm text-center mb-6">Connect account to analyze files directly from Drive.</p>
          
          <button 
             onClick={handleDriveConnect}
             className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-6 rounded-lg font-medium transition-colors shadow"
          >
             Connect & Select
          </button>
          
          {/* Hidden input triggered after mock auth */}
          <input 
             id="drive-folder-input" 
             type="file" 
             accept="image/*,.tif,.tiff" 
             multiple 
             className="hidden" 
             // @ts-ignore - webkitdirectory is standard but often missing in React types
             webkitdirectory="" 
             onChange={(e) => handleFileUpload(e, AnalysisMode.DRIVE)} 
          />
           <p className="text-xs text-slate-400 mt-2 italic text-center">*Supports selecting local Drive folders</p>
        </div>

      </div>
    </div>
  );

  const renderConfig = () => (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-8 flex flex-col items-center relative">
       <button 
          onClick={() => setShowCredits(true)}
          className="absolute top-6 right-6 p-2 text-slate-400 hover:text-blue-600 transition-colors"
        >
          <Info className="w-6 h-6" />
      </button>

      <div className="w-full max-w-2xl bg-white rounded-xl p-8 border border-slate-200 shadow-sm">
        <h2 className="text-2xl font-bold mb-6 flex items-center gap-2">
          <Settings className="w-6 h-6" /> Configuration
        </h2>
        
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-500 mb-2">Project Title</label>
            <input 
              type="text"
              value={projectTitle}
              onChange={(e) => setProjectTitle(e.target.value)}
              className="w-full bg-white border border-slate-300 rounded-lg px-4 py-3 text-slate-900 focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="Enter Project Title"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-500 mb-2">Page Images</label>
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 text-lg font-mono">
              {state.files.length} Pages
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-500 mb-2">Execution Tier</label>
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => setState(s => ({...s, tier: Tier.FREE}))}
                className={`p-4 rounded-lg border flex flex-col items-center transition-all ${state.tier === Tier.FREE ? 'bg-blue-50 border-blue-500 ring-1 ring-blue-500' : 'bg-white border-slate-200 hover:border-slate-400'}`}
              >
                <span className="font-bold text-slate-900">Trial / Free</span>
                <span className="text-xs text-slate-500 text-center mt-1">Slower, strict quotas, auto-retry</span>
              </button>
              <button 
                onClick={() => setState(s => ({...s, tier: Tier.PAID}))}
                className={`p-4 rounded-lg border flex flex-col items-center transition-all ${state.tier === Tier.PAID ? 'bg-emerald-50 border-emerald-500 ring-1 ring-emerald-500' : 'bg-white border-slate-200 hover:border-slate-400'}`}
              >
                <span className="font-bold text-slate-900">Paying Track</span>
                <span className="text-xs text-slate-500 text-center mt-1">Optimized concurrency, faster processing</span>
              </button>
            </div>
            {state.tier === Tier.PAID && (
               <a 
                 href="https://ai.google.dev/gemini-api/docs/billing" 
                 target="_blank" 
                 rel="noopener noreferrer"
                 className="mt-2 text-xs text-blue-600 hover:underline flex items-center gap-1 justify-center"
               >
                 View Google API Billing Documentation <ExternalLink className="w-3 h-3"/>
               </a>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-500 mb-2">Page Range (Optional)</label>
            <div className="flex gap-4 items-center">
              <input 
                type="number" 
                placeholder="Start" 
                min="1"
                max={state.files.length}
                onChange={(e) => setPageRange(prev => ({ start: parseInt(e.target.value) || 1, end: prev?.end || state.files.length }))}
                className="bg-white border border-slate-300 rounded-lg p-3 text-slate-900 w-full focus:ring-2 focus:ring-blue-500 outline-none"
              />
              <span className="text-slate-400">to</span>
              <input 
                type="number" 
                placeholder="End" 
                min="1"
                max={state.files.length}
                onChange={(e) => setPageRange(prev => ({ start: prev?.start || 1, end: parseInt(e.target.value) || state.files.length }))}
                className="bg-white border border-slate-300 rounded-lg p-3 text-slate-900 w-full focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
          </div>

          <button 
            onClick={() => downloadFile(generateFullJSON(projectTitle, state.tier, pageRange, state.files, state.clusters), `${projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_metadata.json`, 'application/json')}
            className="w-full bg-white border border-slate-300 text-slate-700 hover:bg-slate-50 py-3 rounded-lg font-medium shadow-sm flex items-center justify-center gap-2 mt-4"
          >
            <Download className="w-5 h-5" /> Download Project Metadata
          </button>

          <button 
            onClick={startAnalysis}
            className="w-full bg-gradient-to-r from-blue-600 to-emerald-600 hover:from-blue-700 hover:to-emerald-700 text-white py-4 rounded-lg font-bold text-lg shadow-lg flex items-center justify-center gap-2 mt-4"
          >
            <Play className="w-5 h-5" /> Start Analysis
          </button>
        </div>
      </div>
    </div>
  );

  const renderDashboard = () => {
    const progressPercentage = state.processingStatus.total > 0 
      ? Math.round((state.processingStatus.processed / state.processingStatus.total) * 100) 
      : 0;
      
    // Collect unique values for filters
    const availableLanguages = ["All", ...Array.from(new Set(state.files.map(f => f.language).filter(Boolean) as string[]))];
    const availableModes = ["All", ...Array.from(new Set(state.files.map(f => f.productionMode).filter(Boolean) as string[]))];
    
    // Select All helpers for downloads
    const allDownload = state.files.length > 0 && state.files.every(f => f.shouldDownloadImage);
    const toggleAllDownload = () => setState(s => ({...s, files: s.files.map(f => ({...f, shouldDownloadImage: !allDownload}))}));


    // Filter Logic
    const filteredFiles = state.files.filter(f => {
        const langMatch = filterLanguage === "All" || (f.language === filterLanguage);
        const modeMatch = filterProductionMode === "All" || (f.productionMode === filterProductionMode);
        return langMatch && modeMatch;
    });

    return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm flex flex-col">
        <div className="p-4 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-emerald-600">ArchivalLens</h1>
            <div className="flex items-center gap-2 px-3 py-1 bg-slate-100 rounded-full text-xs text-slate-500 border border-slate-200">
              {state.processingStatus.isComplete ? <CheckCircle className="w-3 h-3 text-green-500"/> : <Loader2 className="w-3 h-3 animate-spin"/>}
              <span className="font-medium">{state.processingStatus.currentStep}</span>
              <span className="text-slate-400">|</span>
              <span className="font-mono text-slate-700 font-bold">{progressPercentage}%</span>
              <span className="text-slate-400 text-[10px]">({state.processingStatus.processed}/{state.processingStatus.total})</span>
            </div>
            <button onClick={() => setShowCredits(true)} className="text-slate-400 hover:text-blue-600 transition-colors ml-2" title="Credits">
                <Info className="w-5 h-5" />
            </button>
          </div>
          <div className="flex gap-3">
            <button 
              onClick={runTranscription}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg text-sm font-medium text-white shadow-sm transition-colors"
            >
              Run Transcription
            </button>
            <button 
              onClick={runClustering}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm font-medium text-white shadow-sm transition-colors"
            >
              Generate Document Clusters
            </button>
             <button 
              onClick={() => downloadFile(generateTSV(state.files), `${projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.tsv`, 'text/tab-separated-values')}
              className="flex items-center gap-2 px-4 py-2 bg-white hover:bg-slate-50 rounded-lg text-sm border border-slate-300 text-slate-700 transition-colors shadow-sm"
            >
              <Download className="w-4 h-4" /> Export TSV
            </button>
          </div>
        </div>

        {/* Filters Toolbar */}
        <div className="px-4 pb-3 flex gap-4 items-center border-t border-slate-100 pt-3 bg-slate-50/50">
            <div className="flex items-center gap-2 text-sm text-slate-600">
                <Filter className="w-4 h-4 text-slate-400" />
                <span className="font-medium">Filters:</span>
            </div>
            
            <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Language:</label>
                <select 
                   className="text-xs border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                   value={filterLanguage}
                   onChange={(e) => setFilterLanguage(e.target.value)}
                >
                    {availableLanguages.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
            </div>

            <div className="flex items-center gap-2">
                <label className="text-xs text-slate-500">Production Mode:</label>
                <select 
                   className="text-xs border border-slate-300 rounded px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
                   value={filterProductionMode}
                   onChange={(e) => setFilterProductionMode(e.target.value)}
                >
                    {availableModes.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
            </div>

            {(filterLanguage !== "All" || filterProductionMode !== "All") && (
                <button 
                    onClick={() => { setFilterLanguage("All"); setFilterProductionMode("All"); }}
                    className="text-xs text-blue-600 hover:underline ml-2"
                >
                    Clear Filters
                </button>
            )}
            
            <div className="flex-1 text-right text-xs text-slate-400">
                Showing {filteredFiles.length} of {state.files.length} pages
            </div>
        </div>
        
        {/* Progress Bar */}
        {state.processingStatus.total > 0 && (
          <div className="w-full h-1.5 bg-slate-100">
            <div 
              className={`h-full transition-all duration-500 ease-out ${state.processingStatus.isComplete ? 'bg-emerald-500' : 'bg-gradient-to-r from-blue-500 to-blue-600'}`}
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-auto p-4">
        <div className="min-w-full inline-block align-middle">
          <div className="border border-slate-200 rounded-lg overflow-hidden shadow-sm bg-white">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider sticky left-0 bg-slate-50 z-10 border-r border-slate-200 shadow-[4px_0_8px_-4px_rgba(0,0,0,0.1)]">Index</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Preview</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Language</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">Production Mode</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider w-96">Manual Entry</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                     <div className="flex flex-col gap-2">
                         <div 
                           className="flex items-center gap-1 cursor-pointer hover:text-blue-600 transition-colors"
                           onClick={toggleAllTranscribe}
                           title="Select All Transcribe"
                         >
                            {allTranscribe ? <CheckSquare className="w-3 h-3 text-blue-600" /> : <Square className="w-3 h-3" />}
                            <span>Transcribe</span>
                         </div>
                         <div 
                           className="flex items-center gap-1 cursor-pointer hover:text-blue-600 transition-colors"
                           onClick={toggleAllTranslate}
                           title="Select All Translate"
                         >
                            {allTranslate ? <CheckSquare className="w-3 h-3 text-blue-600" /> : <Square className="w-3 h-3" />}
                            <span>Translate</span>
                         </div>
                         <div 
                           className="flex items-center gap-1 cursor-pointer hover:text-blue-600 transition-colors"
                           onClick={toggleAllDownload}
                           title="Select All Download"
                         >
                            {allDownload ? <CheckSquare className="w-3 h-3 text-blue-600" /> : <Square className="w-3 h-3" />}
                            <span>Download Images</span>
                         </div>
                     </div>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {filteredFiles.map((page) => {
                  // Determine visual state for transcription
                  const hasManual = !!page.manualTranscription;
                  const hasAI = !!page.generatedTranscription;
                  const hasContent = hasManual || hasAI;
                  
                  let borderColor = "border-slate-300";
                  let bgColor = "bg-white";
                  let badge = null;

                  if (hasManual) {
                    borderColor = "border-blue-300 focus:ring-blue-500 focus:border-blue-500";
                    badge = <span className="text-[10px] text-blue-600 flex items-center gap-1"><Edit3 className="w-3 h-3"/> User Edited</span>;
                  } else if (hasAI) {
                    borderColor = "border-dashed border-emerald-300 focus:ring-emerald-500 focus:border-emerald-500";
                    bgColor = "bg-emerald-50/20";
                    badge = <span className="text-[10px] text-emerald-600 flex items-center gap-1"><Bot className="w-3 h-3"/> AI Draft</span>;
                  }
                  
                  // Detect direction for description field
                  const descDir = getTextDirection(page.manualDescription || "");

                  return (
                  <tr key={page.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-700 font-mono sticky left-0 bg-white border-r border-slate-100">{page.indexName}</td>
                    
                    <td className="px-4 py-4 whitespace-nowrap">
                      <div className="flex flex-col gap-2 items-center">
                        {/* Enlarged Thumbnail w-40 h-40 (~25% larger than w-32) */}
                        <div className="relative group w-40 h-40 cursor-pointer shadow-sm" onClick={() => setZoomedImage(page.previewUrl)}>
                          <img src={page.previewUrl} alt="Preview" className="w-full h-full object-cover rounded-md border border-slate-200" />
                          <div className="absolute inset-0 bg-black/20 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity rounded-md">
                            <Maximize2 className="w-6 h-6 text-white drop-shadow-md" />
                          </div>
                        </div>
                      </div>
                    </td>

                    <td className="px-4 py-4 text-sm text-slate-700">
                      {page.status === 'analyzing' ? (
                        <div className="text-blue-500 text-xs"><Loader2 className="w-4 h-4 animate-spin inline mr-1"/> Analyzing...</div>
                      ) : (
                        <span>{page.language || '-'}</span>
                      )}
                    </td>

                    <td className="px-4 py-4 text-sm text-slate-700">
                       <div className="flex flex-col items-start gap-1">
                          <span className="truncate max-w-[150px]" title={page.productionMode}>{page.productionMode || '-'}</span>
                          {page.hasHebrewHandwriting && (
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-yellow-50 border border-yellow-200 text-yellow-700 rounded text-xs">
                              <Flag className="w-3 h-3" /> Hebrew Handwritten
                            </div>
                          )}
                       </div>
                    </td>

                    <td className="px-4 py-4 text-sm">
                       <div className="space-y-3">
                         <div className="relative group">
                             <div className="flex justify-between items-center mb-1">
                                <label className="block text-[10px] uppercase font-bold text-slate-400">Transcription</label>
                                <div className="flex items-center gap-2">
                                  {badge}
                                  <label className="cursor-pointer text-slate-400 hover:text-blue-600" title="Upload Transcription (.txt)">
                                    <FileUp className="w-3 h-3" />
                                    <input 
                                      type="file" 
                                      accept=".txt" 
                                      className="hidden" 
                                      onChange={(e) => handleTranscriptionUpload(e, page.id)}
                                    />
                                  </label>
                                </div>
                             </div>
                             <textarea 
                               className={`w-full ${bgColor} border ${borderColor} rounded px-2 py-2 text-xs outline-none text-slate-900 min-h-[80px] resize-y transition-all`}
                               placeholder="Transcription (Manual or Generated)"
                               value={page.manualTranscription || page.generatedTranscription || ''}
                               dir={getTextDirection(page.manualTranscription || page.generatedTranscription || '')}
                               onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, manualTranscription: e.target.value} : f)}))}
                             />
                             <button 
                                onClick={() => setExpandedField({pageId: page.id, field: 'manualTranscription', label: 'Transcription'})}
                                className={`absolute ${hasContent ? 'bottom-2 right-2' : 'top-9 right-1'} px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded shadow-sm hover:bg-emerald-600 hover:text-white transition-all text-xs font-medium flex items-center gap-1 group/btn`}
                                title="Open Workstation"
                             >
                                <Maximize2 className="w-3 h-3 group-hover/btn:text-white" />
                                Open Editor
                             </button>
                         </div>

                         <div className="relative group">
                             <label className="block text-[10px] uppercase font-bold text-slate-400 mb-1">Description</label>
                             <textarea 
                               className="w-full bg-white border border-slate-300 rounded px-2 py-2 text-xs focus:ring-1 focus:ring-blue-500 focus:border-blue-500 outline-none text-slate-900 min-h-[60px] resize-y"
                               placeholder="Manual Description..."
                               value={page.manualDescription || ''}
                               dir={descDir}
                               onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, manualDescription: e.target.value} : f)}))}
                             />
                             <button 
                                onClick={() => setExpandedField({pageId: page.id, field: 'manualDescription', label: 'Description'})}
                                className="absolute top-7 right-1 px-3 py-1 bg-emerald-50 border border-emerald-200 text-emerald-600 rounded shadow-sm hover:bg-emerald-600 hover:text-white transition-all text-xs font-medium flex items-center gap-1 group/btn"
                                title="Open Workstation"
                             >
                                <Maximize2 className="w-3 h-3 group-hover/btn:text-white" />
                                Open Editor
                             </button>
                         </div>
                       </div>
                    </td>

                    <td className="px-4 py-4 text-sm">
                      <div className="flex flex-col gap-2">
                        <label className="flex items-center gap-2 cursor-pointer select-none group">
                          <input 
                            type="checkbox" 
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={page.shouldTranscribe}
                            onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, shouldTranscribe: e.target.checked} : f)}))}
                          />
                          <span className="text-xs text-slate-600 group-hover:text-blue-600 transition-colors">Transcribe</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer select-none group">
                          <input 
                            type="checkbox" 
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={page.shouldTranslate}
                            onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, shouldTranslate: e.target.checked} : f)}))}
                          />
                          <span className="text-xs text-slate-600 group-hover:text-blue-600 transition-colors">Translate</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer select-none group">
                          <input 
                            type="checkbox" 
                            className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            checked={page.shouldDownloadImage}
                            onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, shouldDownloadImage: e.target.checked} : f)}))}
                          />
                          <span className="text-xs text-slate-600 group-hover:text-blue-600 transition-colors">Download Images</span>
                        </label>
                      </div>
                    </td>

                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )};

  const renderClustering = () => (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h2 className="text-3xl font-bold text-slate-800">Document Clusters</h2>
          <div className="flex gap-4">
            <button 
              onClick={() => setState(s => ({...s, uiState: 'dashboard'}))}
              className="px-4 py-2 border border-slate-300 rounded-lg hover:bg-slate-100 text-slate-700 bg-white shadow-sm"
            >
              Back to Dashboard
            </button>
            <button 
              onClick={() => downloadFile(generateFullJSON(projectTitle, state.tier, pageRange, state.files, state.clusters), `${projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`, 'application/json')}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium flex items-center gap-2 text-white shadow-sm"
            >
              <Code className="w-4 h-4" /> Download JSON
            </button>
            <button 
              onClick={() => downloadFile(generateClustersTSV(state.clusters), 'clusters.tsv', 'text/tab-separated-values')}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg font-medium flex items-center gap-2 text-white shadow-sm"
            >
              <Download className="w-4 h-4" /> Download TSV
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6">
          {state.clusters.map(cluster => (
            <div key={cluster.id} className="bg-white border border-slate-200 rounded-xl p-6 hover:border-blue-300 hover:shadow-md transition-all">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-xl font-bold text-blue-600">{cluster.title} - {cluster.id}</h3>
                  <div className="flex items-center gap-2 text-sm text-slate-500 mt-1">
                      <span>Range: {cluster.pageRange}</span>
                      {cluster.languages && cluster.languages.length > 0 && (
                          <>
                           <span>•</span>
                           <span>{cluster.languages.join(", ")}</span>
                          </>
                      )}
                  </div>
                </div>
                <span className="bg-slate-100 border border-slate-200 px-3 py-1 rounded-full text-xs text-slate-600">
                  {cluster.pageIds.length} Pages
                </span>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                 {/* Left: Summary & Core Data */}
                 <div className="space-y-4">
                    <div className="prose prose-slate max-w-none">
                        <label className="text-xs font-bold text-slate-400 uppercase block mb-1">Summary</label>
                        <textarea 
                           className="w-full min-h-[100px] p-2 border border-slate-200 rounded bg-slate-50 text-sm text-slate-700 focus:ring-1 focus:ring-blue-500 outline-none resize-y"
                           value={cluster.summary}
                           dir={getTextDirection(cluster.summary)}
                           onChange={(e) => setState(s => ({...s, clusters: s.clusters.map(c => c.id === cluster.id ? {...c, summary: e.target.value} : c)}))}
                        />
                    </div>
                    
                    <div className="grid grid-cols-2 gap-4 text-sm">
                        {cluster.originalDate && (
                           <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><Calendar className="w-3 h-3"/> Original Date</label>
                              <div className="text-slate-800">{cluster.originalDate}</div>
                           </div>
                        )}
                        {cluster.standardizedDate && (
                           <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><Calendar className="w-3 h-3"/> Std. Date</label>
                              <div className="text-slate-800">{cluster.standardizedDate}</div>
                           </div>
                        )}
                        {cluster.prisonName && (
                           <div className="col-span-2">
                              <label className="text-[10px] font-bold text-red-400 uppercase flex items-center gap-1"><Building className="w-3 h-3"/> Prison Mentioned</label>
                              <div className="text-red-700 font-medium">{cluster.prisonName}</div>
                           </div>
                        )}
                        {cluster.sender && (
                           <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><User className="w-3 h-3"/> From</label>
                              <div className="text-slate-800">{cluster.sender}</div>
                           </div>
                        )}
                        {cluster.recipient && (
                           <div>
                              <label className="text-[10px] font-bold text-slate-400 uppercase flex items-center gap-1"><Mail className="w-3 h-3"/> To</label>
                              <div className="text-slate-800">{cluster.recipient}</div>
                           </div>
                        )}
                    </div>
                 </div>
                 
                 {/* Right: Entities */}
                 <div className="bg-slate-50 rounded-lg p-4 border border-slate-100 space-y-4 text-center">
                    <h4 className="text-xs font-bold text-slate-500 uppercase border-b border-slate-200 pb-2">Detected Entities</h4>
                    
                    <div>
                        <div className="flex items-center justify-center gap-2 text-xs font-semibold text-blue-600 mb-1"><Users className="w-3 h-3"/> People</div>
                        <textarea
                            className="w-full p-2 text-xs border border-slate-200 rounded text-center focus:ring-1 focus:ring-blue-500 outline-none resize-none bg-white"
                            rows={2}
                            value={(cluster.entities?.people || []).join(", ")}
                            dir={getTextDirection((cluster.entities?.people || []).join(", "))}
                            onChange={(e) => {
                                const newPeople = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                                setState(s => ({...s, clusters: s.clusters.map(c => c.id === cluster.id ? {...c, entities: {...(c.entities || {places:[], organizations:[]}), people: newPeople}} : c)}));
                            }}
                            placeholder="Name 1, Name 2..."
                        />
                    </div>

                    <div>
                        <div className="flex items-center justify-center gap-2 text-xs font-semibold text-emerald-600 mb-1"><MapPin className="w-3 h-3"/> Places</div>
                        <textarea
                            className="w-full p-2 text-xs border border-slate-200 rounded text-center focus:ring-1 focus:ring-emerald-500 outline-none resize-none bg-white"
                            rows={2}
                            value={(cluster.entities?.places || []).join(", ")}
                            dir={getTextDirection((cluster.entities?.places || []).join(", "))}
                            onChange={(e) => {
                                const newPlaces = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                                setState(s => ({...s, clusters: s.clusters.map(c => c.id === cluster.id ? {...c, entities: {...(c.entities || {people:[], organizations:[]}), places: newPlaces}} : c)}));
                            }}
                            placeholder="Place 1, Place 2..."
                        />
                    </div>

                    <div>
                        <div className="flex items-center justify-center gap-2 text-xs font-semibold text-purple-600 mb-1"><Building className="w-3 h-3"/> Organizations</div>
                        <textarea
                            className="w-full p-2 text-xs border border-slate-200 rounded text-center focus:ring-1 focus:ring-purple-500 outline-none resize-none bg-white"
                            rows={2}
                            value={(cluster.entities?.organizations || []).join(", ")}
                            dir={getTextDirection((cluster.entities?.organizations || []).join(", "))}
                            onChange={(e) => {
                                const newOrgs = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                                setState(s => ({...s, clusters: s.clusters.map(c => c.id === cluster.id ? {...c, entities: {...(c.entities || {people:[], places:[]}), organizations: newOrgs}} : c)}));
                            }}
                            placeholder="Org 1, Org 2..."
                        />
                    </div>
                 </div>
              </div>

              <div className="mt-6 flex gap-2 overflow-x-auto pb-2 scrollbar-thin scrollbar-thumb-slate-300">
                {cluster.pageIds.map(pid => {
                    const page = state.files.find(f => f.id === pid);
                    if(!page) return null;
                    return (
                        <div 
                          key={pid} 
                          className="min-w-[80px] w-20 h-20 relative rounded-md overflow-hidden border border-slate-200 shrink-0 cursor-pointer hover:ring-2 hover:ring-blue-500 transition-all"
                          onClick={() => setZoomedImage(page.previewUrl)}
                        >
                            <img src={page.previewUrl} className="w-full h-full object-cover" />
                        </div>
                    )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const renderExpandedEditor = () => {
    if (!expandedField) return null;
    const page = state.files.find(f => f.id === expandedField.pageId);
    if (!page) return null;

    const transcriptionText = page.manualTranscription !== undefined ? page.manualTranscription : page.generatedTranscription;
    const dir = getTextDirection(transcriptionText || "");
    const descDir = getTextDirection(page.manualDescription || "");

    return (
        <div className="fixed inset-0 z-50 bg-slate-900/90 flex items-center justify-center p-4 backdrop-blur-md">
            <div className="bg-white w-full max-w-[95vw] h-[95vh] rounded-xl shadow-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-white z-10">
                    <div>
                        <h3 className="font-bold text-lg text-slate-800">Transcription Workstation</h3>
                        <h4 className="text-sm text-slate-500">{page.indexName}</h4>
                    </div>
                    <button onClick={() => { setExpandedField(null); }} className="p-2 hover:bg-slate-100 rounded-full text-slate-500 transition-colors">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                {/* Split Content */}
                <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
                    {/* Left Panel: Image (Expanded to 60%) */}
                    <div className="w-full md:w-3/5 bg-slate-100 p-4 relative overflow-hidden flex flex-col">
                        <div className="absolute top-4 left-4 z-20 flex gap-2 bg-white/90 rounded-lg p-1 shadow-sm backdrop-blur-sm">
                           <button onClick={() => setImageZoom(z => Math.max(0.5, z - 0.25))} className="p-1.5 hover:bg-slate-100 rounded text-slate-600"><ZoomOut className="w-4 h-4"/></button>
                           <span className="text-xs font-mono flex items-center w-8 justify-center">{Math.round(imageZoom * 100)}%</span>
                           <button onClick={() => setImageZoom(z => Math.min(3, z + 0.25))} className="p-1.5 hover:bg-slate-100 rounded text-slate-600"><ZoomIn className="w-4 h-4"/></button>
                        </div>
                        <div className="flex-1 overflow-auto flex items-center justify-center border-r border-slate-200">
                          <img 
                            src={page.previewUrl} 
                            className="max-w-none shadow-lg rounded-sm transition-transform duration-200 ease-out" 
                            style={{ 
                              transform: `scale(${imageZoom})`, 
                              transformOrigin: 'center center',
                              maxHeight: imageZoom === 1 ? '100%' : 'auto', 
                              maxWidth: imageZoom === 1 ? '100%' : 'auto' 
                            }} 
                          />
                        </div>
                    </div>

                    {/* Right Panel: Inputs (Reduced to 40%) */}
                    <div className="w-full md:w-2/5 flex flex-col bg-white">
                        <div className="flex-1 p-6 overflow-y-auto space-y-6">
                            
                            <div className="space-y-2">
                                <div className="flex justify-between items-center">
                                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700 uppercase tracking-wide">
                                        <FileText className="w-4 h-4 text-blue-600"/> 
                                        Manual Transcription
                                    </label>
                                    <div className="flex items-center gap-2">
                                        <div className="flex items-center gap-1 bg-slate-100 rounded p-1 mr-2">
                                           <Type className="w-3 h-3 text-slate-500"/>
                                           <input 
                                             type="range" min="10" max="24" step="1" 
                                             value={editorFontSize}
                                             onChange={(e) => setEditorFontSize(parseInt(e.target.value))}
                                             className="w-16 h-1 bg-slate-300 rounded-lg appearance-none cursor-pointer"
                                           />
                                        </div>
                                    </div>
                                </div>
                                
                                <textarea
                                    className="w-full h-64 p-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none resize-none text-slate-800 font-mono leading-relaxed shadow-sm transition-all"
                                    style={{ fontSize: `${editorFontSize}px` }}
                                    dir={dir}
                                    value={transcriptionText || ''}
                                    onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, manualTranscription: e.target.value} : f)}))}
                                    placeholder="Type transcription here..."
                                    autoFocus={expandedField.field === 'manualTranscription'}
                                />

                                {page.generatedTranscription && !page.manualTranscription && (
                                   <div className="text-xs text-slate-500 italic text-right">Auto-filled from AI</div>
                                )}
                            </div>
                            
                            <div className="space-y-2 pt-2 border-t border-slate-100">
                                <label className="flex items-center gap-2 text-sm font-bold text-slate-700 uppercase tracking-wide">
                                    <Flag className="w-4 h-4 text-emerald-600"/> 
                                    Description / Notes
                                </label>
                                <textarea
                                    className="w-full h-24 p-4 border border-slate-300 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none resize-none text-slate-800 text-sm leading-relaxed shadow-sm transition-all"
                                    value={page.manualDescription || ''}
                                    dir={descDir}
                                    onChange={(e) => setState(s => ({...s, files: s.files.map(f => f.id === page.id ? {...f, manualDescription: e.target.value} : f)}))}
                                    placeholder="Enter description or notes..."
                                    autoFocus={expandedField.field === 'manualDescription'}
                                />
                            </div>

                            {/* Read-only Translation Area */}
                            {page.generatedTranslation && (
                                <div className="space-y-2 pt-2 border-t border-slate-100">
                                    <label className="flex items-center gap-2 text-sm font-bold text-slate-700 uppercase tracking-wide">
                                        <Languages className="w-4 h-4 text-purple-600"/> 
                                        Generated Translation
                                    </label>
                                    <div className="w-full h-24 p-4 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-sm overflow-y-auto">
                                        {page.generatedTranslation}
                                    </div>
                                </div>
                            )}

                        </div>
                        
                        <div className="p-4 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                             <button 
                                onClick={() => { setExpandedField(null); }}
                                className="px-6 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg font-medium shadow-md transition-all transform active:scale-95"
                             >
                                Save & Close
                             </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    )
  }

  return (
    <>
      {state.uiState === 'welcome' && renderWelcome()}
      {state.uiState === 'config' && renderConfig()}
      {state.uiState === 'dashboard' && renderDashboard()}
      {state.uiState === 'clustering' && renderClustering()}
      {renderExpandedEditor()}
      {renderCreditsModal()}

      {/* Lightbox for Image Zoom (still available from table thumbnail) */}
      {zoomedImage && (
        <div className="fixed inset-0 z-50 bg-slate-900/80 flex items-center justify-center p-8 backdrop-blur-sm" onClick={() => setZoomedImage(null)}>
          <button className="absolute top-4 right-4 text-white hover:text-slate-200 p-2">
            <X className="w-8 h-8" />
          </button>
          <img src={zoomedImage} alt="Zoomed" className="max-w-full max-h-full object-contain shadow-2xl rounded-lg" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </>
  );
};

export default App;