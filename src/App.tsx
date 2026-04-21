import React, { useState, useRef, useEffect } from 'react';
import { 
  FolderSearch, 
  Users, 
  Play, 
  CheckCircle2, 
  Loader2, 
  LayoutGrid,
  ChevronRight,
  Trash2,
  FileImage,
  Settings,
  Activity,
  Info,
  FileDown,
  Copy,
  Eye,
  X,
  Zap,
  ShieldCheck,
  Star
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateCollageLocal, generateCollagePreview } from './utils/collageGenerator';
import { buildAndDownloadPDF } from './utils/pdfExporter';
import type { SheetInput } from './utils/pdfExporter';
import type { AIEngine } from './utils/aiService';

interface LocalPackage {
  name: string;
  files: File[];
  sheetIndex: number;
  totalSheets: number;
}

const MEJIKUHIBINIU = [
  '#FF0000', // Merah
  '#FF7F00', // Jingga
  '#FFFF00', // Kuning
  '#22C55E', // Hijau
  '#3B82F6', // Biru
  '#4B0082', // Nila
  '#A855F7', // Ungu
];

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
  const [aiEngine, setAiEngine] = useState<AIEngine | 'none'>('local'); // Default ke Local (Gratis & Cepat)
  const [previewPackage, setPreviewPackage] = useState<LocalPackage | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [batchColor, setBatchColor] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const groups: { [key: string]: File[] } = {};
    
    files.forEach((file: any) => {
      if (!file.type.startsWith('image/')) return;
      const pathParts = (file as any).webkitRelativePath.split('/');
      const folderName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'Main Folder';
      if (!groups[folderName]) groups[folderName] = [];
      groups[folderName].push(file as File);
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
  };
  
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
        null
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
    
    const lastIndex = parseInt(localStorage.getItem('collageTagIndex') || '-1');
    const nextIndex = (lastIndex + 1) % MEJIKUHIBINIU.length;
    localStorage.setItem('collageTagIndex', nextIndex.toString());
    
    const nextColor = MEJIKUHIBINIU[nextIndex];
    setBatchColor(nextColor);

    setIsProcessing(true);
    setProgress(prev => ({ 
      ...prev, 
      log: [
        `[SYSTEM] Starting Batch Analysis...`,
        `[SYSTEM] AI Engine: ${aiEngine.toUpperCase()}`,
        ...prev.log
      ] 
    }));

    if (exportFormat === 'pdf') {
      await runPDFBatch(null);
    } else {
      await runPNGBatch(null); 
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
                
                <input type="file" ref={fileInputRef} onChange={handleFolderSelect} className="hidden" {...({ webkitdirectory: "", directory: "" } as any)} />
                <button onClick={() => fileInputRef.current?.click()} className="w-full group relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-lg p-8 flex flex-col items-center gap-4 hover:border-yellow-500/50 transition-all active:scale-95">
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <FolderSearch className="w-10 h-10 text-zinc-600 group-hover:text-yellow-500 transition-colors" />
                  <div className="text-center">
                    <p className="text-sm font-bold uppercase tracking-tight">Pilih Folder Lokal</p>
                    <p className="text-[10px] text-zinc-500 font-mono mt-1">Automatic subfolder grouping</p>
                  </div>
                </button>
              </div>
            </div>
          </div>

          {/* New Hybrid AI Engine Selector */}
          <div className="hardware-card p-6 border border-zinc-800 bg-black/20">
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-6">
              <Zap className="w-3 h-3 text-cyan-500" /> AI Engine Configuration
            </div>
            
            <div className="space-y-3">
              {[
                { id: 'none', label: 'OFF', desc: 'No Face Detection', icon: <X className="w-3 h-3" /> },
                { id: 'local', label: 'STANDARD', desc: 'FREE / Fast / GPU Local', icon: <Zap className="w-3 h-3" />, color: 'text-yellow-500' },
                { id: 'openai', label: 'PREMIUM', desc: 'PAID / Smart / OpenAI', icon: <Star className="w-4 h-4" />, color: 'text-cyan-500' },
              ].map((engine) => (
                <button
                  key={engine.id}
                  onClick={() => setAiEngine(engine.id as any)}
                  className={`w-full text-left p-3 rounded-lg border transition-all flex items-center gap-4 ${
                    aiEngine === engine.id 
                      ? 'bg-zinc-800 border-zinc-600 shadow-lg' 
                      : 'bg-black/40 border-zinc-900 hover:border-zinc-700 opacity-60'
                  }`}
                >
                  <div className={`p-2 rounded bg-black/40 ${aiEngine === engine.id ? engine.color : 'text-zinc-700'}`}>
                    {engine.icon}
                  </div>
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-tight">{engine.label}</p>
                    <p className="text-[9px] text-zinc-600 font-mono italic">{engine.desc}</p>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-6 p-3 rounded bg-cyan-500/5 border border-cyan-500/10">
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
              <button onClick={startBatch} disabled={isProcessing || packages.length === 0} className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:bg-zinc-900 disabled:text-zinc-700 text-black font-black py-4 rounded uppercase tracking-tighter transition-all flex items-center justify-center gap-3">
                {isProcessing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                {isProcessing ? 'Processing...' : `Execute ${aiEngine.toUpperCase()} Flow`}
              </button>
            </div>
          </div>

          <AnimatePresence>
            {(isProcessing || progress.log.length > 0) && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="hardware-card overflow-hidden">
                <div className="p-3 border-b border-zinc-800 bg-black/40 flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                  <div>System Log | Engine: {aiEngine.toUpperCase()}</div>
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
