import React, { useState, useRef, useCallback } from 'react';
import { 
  FolderSearch, 
  Users, 
  Play, 
  Loader2, 
  LayoutGrid,
  Trash2,
  FileImage,
  Activity,
  Info,
  Copy,
  Eye,
  X,
  Zap,
  Star,
  Palette,
  Archive,
  Upload
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateCollageLocal, generateCollagePreview } from './utils/collageGenerator';
import { buildAndDownloadPDF } from './utils/pdfExporter';
import type { SheetInput } from './utils/pdfExporter';
import type { AIEngine } from './utils/aiService';
import { generateRandomBatchColor } from './utils/colorUtils';
import { extractZip, isZipFile, type ZipExtractionProgress } from './utils/zipExtractor';

interface LocalPackage {
  name: string;
  files: File[];
  sheetIndex: number;
  totalSheets: number;
}

export default function App() {
  const [customerName, setCustomerName] = useState('');
  const [packages, setPackages] = useState<LocalPackage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; log: string[] }>({
    current: 0,
    total: 0,
    log: []
  });
  const [exportFormat, setExportFormat] = useState<'png' | 'pdf'>('pdf');
  const [aiEngine, setAiEngine] = useState<AIEngine | 'none'>('local');
  const [previewPackage, setPreviewPackage] = useState<LocalPackage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [batchColor, setBatchColor] = useState<string | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState<ZipExtractionProgress | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  /**
   * processFiles — Shared logic for grouping File[] into LocalPackage[].
   * Used by both folder select and ZIP extract flows.
   * Files must have a webkitRelativePath property for subfolder grouping.
   */
  const processFiles = useCallback((files: File[]) => {
    if (files.length === 0) return;

    const groups: { [key: string]: File[] } = {};
    
    files.forEach((file) => {
      const isImage = file.type.startsWith('image/') || /\.(heic|heif|webp|jpg|jpeg|png|bmp|tiff?)$/i.test(file.name);
      if (!isImage) return;

      const relativePath = (file as unknown as { webkitRelativePath: string }).webkitRelativePath || '';
      const pathParts = relativePath.split('/');
      const folderName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'Main Folder';

      if (!groups[folderName]) groups[folderName] = [];
      groups[folderName].push(file);
    });

    const newPackages: LocalPackage[] = [];
    
    Object.entries(groups).forEach(([name, pkgFiles]) => {
      pkgFiles.sort((a, b) => a.name.localeCompare(b.name));
      const numChunks = Math.ceil(pkgFiles.length / 25);
      
      for (let i = 0; i < numChunks; i++) {
        const chunk = pkgFiles.slice(i * 25, (i + 1) * 25);
        const pkgName = numChunks > 1 ? `${name} (Part ${i + 1})` : name;
        newPackages.push({
          name: pkgName,
          files: chunk,
          sheetIndex: 0,
          totalSheets: 0
        });
      }
    });

    newPackages.forEach((pkg, idx, arr) => {
      pkg.sheetIndex = idx + 1;
      pkg.totalSheets = arr.length;
    });

    setPackages(newPackages);
    setProgress({ current: 0, total: 0, log: [] });
  }, []);

  /** Handle native folder selection via webkitdirectory input */
  const handleFolderSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    processFiles(files);
    // Reset input value so re-selecting the same folder works
    if (e.target) e.target.value = '';
  }, [processFiles]);

  /** Handle ZIP file upload — extract and feed into the same pipeline */
  const handleZipUpload = useCallback(async (zipFile: File) => {
    setIsExtracting(true);
    setExtractionProgress({ phase: 'reading', percent: 0, message: 'Memulai...' });

    try {
      const result = await extractZip(zipFile, (progress) => {
        setExtractionProgress(progress);
      });

      processFiles(result.files);

      setProgress(prev => ({
        ...prev,
        log: [
          `[SYSTEM] ZIP Extracted: ${result.imageCount} gambar dari ${zipFile.name}` +
            (result.skippedCount > 0 ? ` (${result.skippedCount} file dilewati)` : ''),
          ...prev.log,
        ],
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gagal mengekstrak ZIP';
      setProgress(prev => ({
        ...prev,
        log: [`[ERROR] ${message}`, ...prev.log],
      }));
    } finally {
      setIsExtracting(false);
      setExtractionProgress(null);
    }
  }, [processFiles]);

  /** Handle ZIP input change event */
  const handleZipInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleZipUpload(file);
    if (e.target) e.target.value = '';
  }, [handleZipUpload]);

  // ─── Drag & Drop Handlers ───────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set false if we've actually left the drop zone
    const rect = dropZoneRef.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = e;
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        setIsDragOver(false);
      }
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const items = e.dataTransfer.files;
    if (!items || items.length === 0) return;

    // Check if dropped file is a ZIP
    const firstFile = items[0];
    if (isZipFile(firstFile)) {
      await handleZipUpload(firstFile);
      return;
    }

    // Otherwise treat as image files (dropped from a folder)
    const files = Array.from(items);
    processFiles(files);
  }, [handleZipUpload, processFiles]);
  
  const recalculateIndices = (pkgs: LocalPackage[]) => {
    return pkgs.map((pkg, idx, arr) => ({
      ...pkg,
      sheetIndex: idx + 1,
      totalSheets: arr.length
    }));
  };

  const handleDuplicate = (index: number) => {
    const pkgToDup = packages[index];
    const newPackages = [...packages];
    newPackages.splice(index + 1, 0, { ...pkgToDup });
    setPackages(recalculateIndices(newPackages));
    setProgress(prev => ({ ...prev, log: [`[SYSTEM] Duplicated ${pkgToDup.name}`, ...prev.log] }));
  };

  const handleDeletePackage = (index: number) => {
    const newPackages = packages.filter((_, i) => i !== index);
    setPackages(recalculateIndices(newPackages));
  };

  const showPreview = async (pkg: LocalPackage) => {
    if (!customerName) {
      alert('Tolong masukkan Nama Customer dulu untuk preview!');
      return;
    }
    setPreviewPackage(pkg);
    setIsPreviewLoading(true);
    try {
      const url = await generateCollagePreview(
        pkg.files,
        customerName,
        pkg.sheetIndex,
        pkg.totalSheets,
        aiEngine === 'none' ? null : aiEngine,
        batchColor
      );
      setPreviewUrl(url);
    } catch (err: any) {
      alert('Gagal membuat preview: ' + err.message);
      setPreviewPackage(null);
    } finally {
      setIsPreviewLoading(false);
    }
  };

  const closePreview = () => {
    setPreviewPackage(null);
    setPreviewUrl(null);
    setIsPreviewLoading(false);
  };

  const startBatch = async () => {
    if (!customerName) {
      alert('Tolong masukkan Nama Customer!');
      return;
    }
    
    // Generate warna acak total setiap kali batch di-eksekusi (Best Practice)
    const nextColor = generateRandomBatchColor();
    setBatchColor(nextColor);

    setIsProcessing(true);
    setProgress(prev => ({ 
      ...prev, 
      log: [
        `[SYSTEM] Starting Batch Analysis...`,
        `[SYSTEM] Batch Color: ${nextColor}`,
        `[SYSTEM] AI Engine: ${aiEngine.toUpperCase()}`,
        ...prev.log
      ] 
    }));

    if (exportFormat === 'pdf') {
      await runPDFBatch(nextColor);
    } else {
      await runPNGBatch(nextColor); 
    }

    setIsProcessing(false);
    setProgress(prev => ({ ...prev, log: ['[SYSTEM] Semua proses selesai.', ...prev.log] }));
  };

  const runPNGBatch = async (tagColor: string | null) => {
    setProgress({ current: 0, total: packages.length, log: [`[SYSTEM] Rendering PNGs...`] });
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      setProgress(prev => ({ ...prev, current: i + 1 }));
      try {
        const blob = await generateCollageLocal(
          pkg.files.slice(0, 25),
          customerName,
          pkg.sheetIndex,
          pkg.totalSheets,
          aiEngine === 'none' ? null : aiEngine,
          (idx, tot, status) => {
            setProgress(prev => ({ ...prev, log: [`[${pkg.name}] ${status}`, ...prev.log.slice(0, 50)] }));
          },
          tagColor
        );
        const url = window.URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        const safeName = customerName.replace(/[^a-zA-Z0-9_\-]/g, ' ');
        a.download = `${safeName} - Pages ${pkg.sheetIndex}_${pkg.totalSheets}.png`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
      } catch (err: any) {
        setProgress(prev => ({ ...prev, log: [`[ERROR] ${pkg.name}: ${err.message}`, ...prev.log] }));
      }
    }
  };

  const runPDFBatch = async (tagColor: string | null) => {
    setProgress({ current: 0, total: packages.length, log: [`[SYSTEM] Generating Optimized PDF...`] });
    const sheetInputs: SheetInput[] = packages.map(pkg => ({
      files:       pkg.files.slice(0, 25),
      name:        pkg.name,
      sheetIndex:  pkg.sheetIndex,
      totalSheets: pkg.totalSheets,
    }));

    try {
      await buildAndDownloadPDF(
        sheetInputs,
        customerName,
        (current, total, sheetName) => {
          setProgress(prev => ({ ...prev, current }));
        },
        aiEngine === 'none' ? null : aiEngine,
        tagColor
      );
      setProgress(prev => ({ ...prev, log: [`[SUCCESS] PDF Downloaded`, ...prev.log] }));
    } catch (err: any) {
      setProgress(prev => ({ ...prev, log: [`[ERROR] PDF Failed: ${err.message}`, ...prev.log] }));
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white p-4 md:p-8 font-sans selection:bg-yellow-500 selection:text-black">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Sidebar: Controls */}
        <aside className="lg:col-span-4 space-y-6">
          <div className="hardware-card p-6 space-y-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-yellow-500 rounded flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.5)]">
                <LayoutGrid className="w-6 h-6 text-black" />
              </div>
              <div>
                <h1 className="text-lg font-black tracking-tighter uppercase italic">AutoCollage v2 <span className="text-[10px] bg-black px-1.5 py-0.5 rounded text-yellow-500 ml-1 border border-yellow-500/30">HYBRID</span></h1>
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">Multi-Engine Processing</p>
              </div>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                  <Users className="w-3 h-3" /> Customer Identity
                </label>
                <input 
                  type="text" 
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="NAMA CUSTOMER"
                  className="w-full bg-black/50 border border-zinc-800 rounded px-4 py-3 text-sm font-mono focus:outline-none focus:border-yellow-500 transition-colors placeholder:text-zinc-700"
                />
              </div>

              <div className="space-y-4">
                <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                  <FolderSearch className="w-3 h-3" /> Source Selection
                </label>
                
                {/* Hidden file inputs */}
                <input type="file" ref={fileInputRef} onChange={handleFolderSelect} className="hidden" {...({ webkitdirectory: "", directory: "" } as any)} />
                <input type="file" ref={zipInputRef} onChange={handleZipInputChange} className="hidden" accept=".zip" />

                {/* Dual upload buttons */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isExtracting}
                    className="group relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col items-center gap-3 hover:border-yellow-500/50 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-yellow-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <FolderSearch className="w-8 h-8 text-zinc-600 group-hover:text-yellow-500 transition-colors" />
                    <div className="text-center">
                      <p className="text-xs font-bold uppercase tracking-tight">Folder</p>
                      <p className="text-[9px] text-zinc-600 font-mono mt-0.5">Subfolder grouping</p>
                    </div>
                  </button>

                  <button
                    onClick={() => zipInputRef.current?.click()}
                    disabled={isExtracting}
                    className="group relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-lg p-5 flex flex-col items-center gap-3 hover:border-cyan-500/50 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <Archive className="w-8 h-8 text-zinc-600 group-hover:text-cyan-500 transition-colors" />
                    <div className="text-center">
                      <p className="text-xs font-bold uppercase tracking-tight">ZIP File</p>
                      <p className="text-[9px] text-zinc-600 font-mono mt-0.5">Auto extract & group</p>
                    </div>
                  </button>
                </div>

                {/* Drag & Drop Zone */}
                <div
                  ref={dropZoneRef}
                  onDragEnter={handleDragEnter}
                  onDragLeave={handleDragLeave}
                  onDragOver={handleDragOver}
                  onDrop={handleDrop}
                  className={`relative rounded-lg border-2 border-dashed p-4 flex items-center justify-center gap-3 transition-all duration-200 ${
                    isDragOver
                      ? 'border-yellow-500 bg-yellow-500/5 scale-[1.02]'
                      : 'border-zinc-800 bg-black/20 hover:border-zinc-700'
                  } ${isExtracting ? 'pointer-events-none opacity-40' : 'cursor-pointer'}`}
                  onClick={() => !isExtracting && zipInputRef.current?.click()}
                >
                  <Upload className={`w-4 h-4 transition-colors ${isDragOver ? 'text-yellow-500' : 'text-zinc-700'}`} />
                  <p className={`text-[10px] font-mono uppercase tracking-wider transition-colors ${isDragOver ? 'text-yellow-500' : 'text-zinc-600'}`}>
                    {isDragOver ? 'Lepas untuk upload' : 'Drag & drop folder atau ZIP di sini'}
                  </p>
                </div>

                {/* ZIP Extraction Progress Overlay */}
                <AnimatePresence>
                  {isExtracting && extractionProgress && (
                    <motion.div
                      initial={{ opacity: 0, y: -5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4 space-y-3"
                    >
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 text-cyan-500 animate-spin" />
                        <span className="text-xs font-mono text-cyan-500 uppercase tracking-wide">Extracting ZIP</span>
                      </div>
                      {/* Progress bar */}
                      <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                        <motion.div
                          className="h-full bg-gradient-to-r from-cyan-500 to-yellow-500 rounded-full"
                          initial={{ width: '0%' }}
                          animate={{ width: `${extractionProgress.percent}%` }}
                          transition={{ duration: 0.3, ease: 'easeOut' }}
                        />
                      </div>
                      <p className="text-[9px] font-mono text-zinc-500 truncate">
                        {extractionProgress.message}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>

          {/* AI Engine & Batch Configuration */}
          <div className="hardware-card p-6 border border-zinc-800 bg-black/20 space-y-6">
            <div>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest">
                  <Zap className="w-3 h-3 text-cyan-500" /> AI Engine
                </div>
                {batchColor && (
                  <div className="flex items-center gap-2 px-2 py-0.5 rounded-full bg-black text-[9px] font-mono border border-zinc-800">
                    <Palette className="w-3 h-3" style={{ color: batchColor }} />
                    <span className="uppercase text-zinc-400">Current Batch</span>
                  </div>
                )}
              </div>
              
              <div className="space-y-2">
                {[
                  { id: 'none', label: 'OFF', desc: 'No Face Detection', icon: <X className="w-3 h-3" /> },
                  { id: 'local', label: 'STANDARD', desc: 'FREE / Fast / GPU Local', icon: <Zap className="w-3 h-3" />, color: 'text-yellow-500' },
                  { id: 'openai', label: 'PREMIUM', desc: 'PAID / Smart / OpenAI', icon: <Star className="w-4 h-4" />, color: 'text-cyan-500' },
                ].map((engine) => (
                  <button
                    key={engine.id}
                    onClick={() => setAiEngine(engine.id as any)}
                    className={`w-full text-left p-2.5 rounded-lg border transition-all flex items-center gap-3 ${
                      aiEngine === engine.id 
                        ? 'bg-zinc-800 border-zinc-600' 
                        : 'bg-black/40 border-zinc-900 opacity-60 hover:opacity-100'
                    }`}
                  >
                    <div className={`p-1.5 rounded bg-black/40 ${aiEngine === engine.id ? engine.color : 'text-zinc-700'}`}>
                      {engine.icon}
                    </div>
                    <div>
                      <p className="text-[10px] font-black uppercase tracking-tight">{engine.label}</p>
                      <p className="text-[8px] text-zinc-600 font-mono italic">{engine.desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3 rounded bg-cyan-500/5 border border-cyan-500/10">
               <p className="text-[9px] text-cyan-500/70 font-mono leading-relaxed flex items-center gap-2">
                  <Info className="w-3 h-3" />
                  {aiEngine === 'openai' 
                    ? 'Premium Mode menggunakan saldo OpenAI GPT-4o-mini untuk hasil paling akurat.'
                    : 'Standard Mode menggunakan GPU browser Anda untuk proses offline & gratis.'}
               </p>
            </div>
          </div>

        </aside>

        {/* Right Content */}
        <main className="lg:col-span-8 space-y-6">
          <div className="hardware-card flex flex-col h-[600px]">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-black/20">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-yellow-500 animate-pulse-accent" />
                <span className="text-xs font-mono uppercase tracking-widest">Sheet Pipeline</span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-2">
              {packages.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {packages.map((pkg, idx) => (
                    <motion.div key={idx} className="p-3 rounded bg-black/40 border border-zinc-900 flex items-center justify-between group hover:border-zinc-700">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileImage className="w-4 h-4 text-zinc-600 group-hover:text-yellow-500" />
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate uppercase">{pkg.name}</p>
                          <p className="text-[9px] text-zinc-600 font-mono">Sheet {pkg.sheetIndex}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <button onClick={() => showPreview(pkg)} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-cyan-500"><Eye className="w-3.5 h-3.5" /></button>
                        <button onClick={() => handleDuplicate(idx)} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-yellow-500"><Copy className="w-3.5 h-3.5" /></button>
                        <button onClick={() => handleDeletePackage(idx)} className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-zinc-700 space-y-4">
                  <FolderSearch className="w-8 h-8 opacity-20" />
                  <p className="text-[10px] font-mono uppercase tracking-widest opacity-50">Ready to Process Batch</p>
                </div>
              )}
            </div>

            <div className="p-6 bg-black/40 border-t border-zinc-800 space-y-4">
              <div className="grid grid-cols-2 gap-2">
                {(['png', 'pdf'] as const).map((fmt) => (
                  <button key={fmt} onClick={() => setExportFormat(fmt)} disabled={isProcessing} className={`py-2.5 rounded text-xs font-mono font-bold uppercase border ${exportFormat === fmt ? 'bg-yellow-500 text-black shadow-[0_0_15px_rgba(234,179,8,0.3)]' : 'bg-black/30 border-zinc-800 text-zinc-500'}`}>{fmt.toUpperCase()}</button>
                ))}
              </div>
              <button 
                onClick={startBatch} 
                disabled={isProcessing || packages.length === 0} 
                className="w-full relative group overflow-hidden bg-yellow-500 hover:bg-yellow-400 disabled:bg-zinc-900 disabled:text-zinc-700 text-black font-black py-4 rounded uppercase tracking-tighter transition-all flex items-center justify-center gap-3"
              >
                {/* Visual Indicator of Batch Color on Button during processing */}
                {isProcessing && batchColor && (
                  <div className="absolute inset-0 opacity-10 animate-pulse" style={{ backgroundColor: batchColor }} />
                )}
                {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                {isProcessing ? 'Processing Batch...' : `Execute Flow (${exportFormat.toUpperCase()})`}
              </button>
            </div>
          </div>

          <AnimatePresence>
            {(isProcessing || progress.log.length > 0) && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="hardware-card overflow-hidden">
                <div className="p-3 border-b border-zinc-800 bg-black/40 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                  <div className="flex items-center gap-2">
                    <Palette className="w-3 h-3" style={{ color: batchColor || 'currentColor' }} />
                    System Log | Engine: {aiEngine.toUpperCase()}
                  </div>
                  <div>{progress.current} / {progress.total}</div>
                </div>
                <div className="p-4 h-32 overflow-y-auto font-mono text-[9px] space-y-1 custom-scrollbar bg-black/60">
                  {progress.log.map((entry, i) => (
                    <div key={i} className={`flex gap-2 ${entry.includes('[ERROR]') ? 'text-red-500' : 'text-zinc-500'}`}>
                      <span className="opacity-20">{new Date().toLocaleTimeString([], { hour12: false })}</span>
                      <span>{entry}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      <AnimatePresence>
        {previewPackage && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90">
            <motion.div initial={{ scale: 0.95 }} animate={{ scale: 1 }} className="relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl max-w-2xl w-full">
              <div className="p-4 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-bold uppercase">{previewPackage.name}</span>
                <button onClick={closePreview} className="text-zinc-500"><X className="w-5 h-5" /></button>
              </div>
              <div className="p-6 aspect-[31/47] flex items-center justify-center bg-black">
                {isPreviewLoading ? <Loader2 className="w-8 h-8 animate-spin" /> : <img src={previewUrl!} className="max-w-full max-h-full" />}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
