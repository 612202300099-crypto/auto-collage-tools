import React, { useState, useRef } from 'react';
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
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { generateCollageLocal, generateCollagePreview } from './utils/collageGenerator';
import { buildAndDownloadPDF } from './utils/pdfExporter';
import type { SheetInput } from './utils/pdfExporter';

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
  const [exportFormat, setExportFormat] = useState<'png' | 'pdf'>('png');
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
      // Properly extract the folder name
      const folderName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'Main Folder';
      if (!groups[folderName]) groups[folderName] = [];
      groups[folderName].push(file as File);
    });

    const newPackages: LocalPackage[] = [];
    
    Object.entries(groups).forEach(([name, pkgFiles]) => {
      // Sort files to ensure consistency
      pkgFiles.sort((a, b) => a.name.localeCompare(b.name));
      
      // Calculate how many chunks of 25 we need
      const numChunks = Math.ceil(pkgFiles.length / 25);
      
      for (let i = 0; i < numChunks; i++) {
        const chunk = pkgFiles.slice(i * 25, (i + 1) * 25);
        const pkgName = numChunks > 1 ? `${name} (Part ${i + 1})` : name;
        newPackages.push({
          name: pkgName,
          files: chunk,
          sheetIndex: 0, // will assign sequentially next
          totalSheets: 0
        });
      }
    });

    // Assign sequential sheet indices
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
    if (pkgToDup.files.length > 25) return; // safety although button hidden

    const newPackages = [...packages];
    const duplicate = { ...pkgToDup };
    
    // Insert right after the original
    newPackages.splice(index + 1, 0, duplicate);
    
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
        batchColor || MEJIKUHIBINIU[(parseInt(localStorage.getItem('collageTagIndex') || '6') + 1) % MEJIKUHIBINIU.length]
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
    
    // Looping warna MEJIKUHIBINIU secara berurutan
    const lastIndex = parseInt(localStorage.getItem('collageTagIndex') || '-1');
    const nextIndex = (lastIndex + 1) % MEJIKUHIBINIU.length;
    localStorage.setItem('collageTagIndex', nextIndex.toString());
    
    const nextColor = MEJIKUHIBINIU[nextIndex];
    setBatchColor(nextColor);

    setIsProcessing(true);
    setProgress(prev => ({ ...prev, log: [`[SYSTEM] Batch Tag Color: ${nextColor}`, ...prev.log] }));

    if (exportFormat === 'pdf') {
      await runPDFBatch(nextColor);
    } else {
      await runPNGBatch(nextColor);
    }

    setIsProcessing(false);
    setProgress(prev => ({ ...prev, log: ['[SYSTEM] Semua proses selesai.', ...prev.log] }));
  };

  // ── Mode PNG: render + download satu per satu ──────────────────────────────
  const runPNGBatch = async (tagColor: string) => {
    setProgress({ current: 0, total: packages.length, log: ['[SYSTEM] Mode PNG — mulai proses batch...'] });

    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      setProgress(prev => ({
        ...prev,
        current: i + 1,
        log: [`[PROCESS] Render ${pkg.name} (${pkg.files.length} foto)...`, ...prev.log]
      }));

      try {
        const blob = await generateCollageLocal(
          pkg.files.slice(0, 25),
          customerName,
          pkg.sheetIndex,
          pkg.totalSheets,
          (idx, tot, status) => {
            setProgress(prev => ({ 
              ...prev, 
              log: [`[${pkg.name}] ${status}`, ...prev.log.slice(0, 100)] // Limit log length for performance
            }));
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
        setProgress(prev => ({ ...prev, log: [`[SUCCESS] Downloaded Sheet ${pkg.sheetIndex}.png`, ...prev.log] }));
      } catch (err: any) {
        setProgress(prev => ({ ...prev, log: [`[ERROR] ${pkg.name}: ${err.message}`, ...prev.log] }));
      }
    }
  };

  // ── Mode PDF: streaming — 1 sheet masuk PDF lalu langsung dibuang dari RAM ─
  const runPDFBatch = async (tagColor: string) => {
    setProgress({ current: 0, total: packages.length, log: ['[SYSTEM] Mode PDF — streaming satu sheet per satu...'] });

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
          setProgress(prev => ({
            ...prev,
            current,
          log: [`[PDF] Sheet ${current}/${total} — ${sheetName}`, ...prev.log]
          }));
        },
        tagColor
      );
      setProgress(prev => ({
        ...prev,
        log: [`[SUCCESS] PDF berhasil didownload (${sheetInputs.length} halaman)`, ...prev.log]
      }));
    } catch (err: any) {
      setProgress(prev => ({ ...prev, log: [`[ERROR] Gagal membuat PDF: ${err.message}`, ...prev.log] }));
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-white p-4 md:p-8 font-sans selection:bg-yellow-500 selection:text-black">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Sidebar: Controls */}
        <aside className="lg:col-span-4 space-y-6">
          <div className="hardware-card p-6 space-y-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-yellow-500 rounded flex items-center justify-center shadow-[0_0_20px_rgba(251,191,36,0.3)]">
                <LayoutGrid className="w-6 h-6 text-black" />
              </div>
              <div>
                <h1 className="text-lg font-black tracking-tighter uppercase italic">AutoCollage v2</h1>
                <p className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">A3+ Batch Processor</p>
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
                
                <input 
                  type="file" 
                  ref={fileInputRef}
                  onChange={handleFolderSelect}
                  className="hidden"
                  {...({ webkitdirectory: "", directory: "" } as any)}
                />
                
                <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full group relative overflow-hidden bg-zinc-900 border border-zinc-800 rounded-lg p-8 flex flex-col items-center gap-4 hover:border-yellow-500/50 transition-all active:scale-95"
                >
                  <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-yellow-500/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                  <FolderSearch className="w-10 h-10 text-zinc-600 group-hover:text-yellow-500 transition-colors" />
                  <div className="text-center">
                    <p className="text-sm font-bold uppercase tracking-tight">Pilih Folder Lokal</p>
                    <p className="text-[10px] text-zinc-500 font-mono mt-1">Detect subfolders as sheets</p>
                  </div>
                </button>

                {packages.length > 0 && (
                  <button 
                    onClick={() => { setPackages([]); if(fileInputRef.current) fileInputRef.current.value = ''; }}
                    className="w-full py-2 text-[10px] font-mono text-zinc-600 hover:text-red-500 transition-colors uppercase tracking-widest flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-3 h-3" /> Reset Selection
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Specs Panel */}
          <div className="hardware-card p-6 border-dashed border-zinc-800">
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-4">
              <Settings className="w-3 h-3" /> Output Configuration
            </div>
            <div className="space-y-3">
              {[
                ['Format', '31 x 47 cm'],
                ['Resolution', '350 DPI'],
                ['Photo Size', '6 x 9 cm'],
                ['Grid', '5 x 5 (25 Photos)'],
                ['Gap Samping', '0.25 cm'],
                ['Gap Bawah', '0.25 cm'],
                ['Layout', 'Bottom Aligned'],
                ['Border', '0.2 mm (Hitam)'],
              ].map(([label, val]) => (
                <div key={label} className="flex justify-between items-center border-b border-zinc-900 pb-2">
                  <span className="text-[10px] text-zinc-600 font-mono uppercase">{label}</span>
                  <span className="text-xs font-bold text-zinc-300">{val}</span>
                </div>
              ))}
            </div>
          </div>
        </aside>

        {/* Right Content: Queue & Progress */}
        <main className="lg:col-span-8 space-y-6">
          <div className="hardware-card flex flex-col h-[600px]">
            <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-black/20">
              <div className="flex items-center gap-3">
                <Activity className="w-4 h-4 text-yellow-500 animate-pulse-accent" />
                <span className="text-xs font-mono uppercase tracking-widest">Processing Queue</span>
              </div>
              <div className="px-2 py-1 bg-zinc-900 rounded text-[10px] font-mono text-zinc-500">
                {packages.length} Packages Detected
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 custom-scrollbar space-y-2">
              {packages.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {packages.map((pkg, idx) => (
                    <motion.div 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      key={idx}
                      className="p-3 rounded bg-black/40 border border-zinc-900 flex items-center justify-between group hover:border-zinc-700 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 rounded bg-zinc-900 flex items-center justify-center text-zinc-600 group-hover:text-yellow-500 transition-colors">
                          <FileImage className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-xs font-bold truncate uppercase tracking-tight">{pkg.name}</p>
                          <p className="text-[9px] text-zinc-600 font-mono uppercase">{pkg.files.length} IMG • SHEET {pkg.sheetIndex}</p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button 
                          onClick={() => showPreview(pkg)}
                          className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-cyan-500 transition-colors"
                          title="Preview Layout"
                        >
                          <Eye className="w-3.5 h-3.5" />
                        </button>

                        {pkg.files.length <= 25 && (
                          <button 
                            onClick={() => handleDuplicate(idx)}
                            className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-yellow-500 transition-colors"
                            title="Duplicate Sheet"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <button 
                          onClick={() => handleDeletePackage(idx)}
                          className="p-1.5 hover:bg-zinc-800 rounded text-zinc-500 hover:text-red-500 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-zinc-700 space-y-4">
                  <div className="w-16 h-16 border-2 border-dashed border-zinc-800 rounded-full flex items-center justify-center">
                    <Info className="w-6 h-6 opacity-20" />
                  </div>
                  <div className="text-center">
                    <p className="text-xs font-mono uppercase tracking-widest">Waiting for input...</p>
                    <p className="text-[10px] mt-2 max-w-xs opacity-50">Select a folder to begin automated batch processing.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="p-6 bg-black/40 border-t border-zinc-800 space-y-4">

              {/* Format Selector: PNG vs PDF */}
              <div className="space-y-2">
                <label className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                  <FileDown className="w-3 h-3" /> Export Format
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(['png', 'pdf'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      onClick={() => setExportFormat(fmt)}
                      disabled={isProcessing}
                      className={`py-2.5 rounded text-xs font-mono font-bold uppercase tracking-widest border transition-all ${
                        exportFormat === fmt
                          ? 'bg-yellow-500 border-yellow-500 text-black'
                          : 'bg-black/30 border-zinc-800 text-zinc-500 hover:border-zinc-600 hover:text-zinc-300'
                      }`}
                    >
                      {fmt === 'png' ? '📄 PNG' : '📦 PDF (1 File)'}
                    </button>
                  ))}
                </div>
                <p className="text-[9px] font-mono text-zinc-700">
                  {exportFormat === 'png'
                    ? 'Setiap sheet didownload sebagai file PNG terpisah'
                    : 'Semua sheet digabung menjadi 1 file PDF multi-halaman'}
                </p>
              </div>

              <button 
                onClick={startBatch}
                disabled={isProcessing || packages.length === 0}
                className="w-full group relative bg-yellow-500 hover:bg-yellow-400 disabled:bg-zinc-900 disabled:text-zinc-700 text-black font-black py-4 rounded uppercase tracking-tighter transition-all flex items-center justify-center gap-3 overflow-hidden"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Processing Batch...
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 fill-current" />
                    Execute — {exportFormat.toUpperCase()}
                  </>
                )}
                <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform" />
              </button>
            </div>
          </div>

          {/* Terminal Log */}
          <AnimatePresence>
            {(isProcessing || progress.log.length > 0) && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="hardware-card overflow-hidden"
              >
                <div className="p-3 border-b border-zinc-800 bg-black/40 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                    <Activity className={`w-3 h-3 ${isProcessing ? 'animate-pulse text-yellow-500' : ''}`} />
                    System Log
                  </div>
                  <div className="text-[10px] font-mono text-zinc-600">
                    {progress.current} / {progress.total} COMPLETE
                  </div>
                </div>
                <div className="p-1">
                  <div className="w-full bg-zinc-900 h-1 overflow-hidden">
                    <motion.div 
                      className="bg-yellow-500 h-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="p-4 h-40 overflow-y-auto font-mono text-[10px] space-y-1 custom-scrollbar bg-black/60">
                  {progress.log.map((entry, i) => (
                    <div key={i} className={`flex gap-2 ${entry.includes('[ERROR]') ? 'text-red-500' : entry.includes('[SUCCESS]') ? 'text-green-500' : 'text-zinc-500'}`}>
                      <span className="opacity-30">[{new Date().toLocaleTimeString()}]</span>
                      <span>{entry}</span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Preview Modal */}
      <AnimatePresence>
        {previewPackage && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm"
          >
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-2xl max-w-2xl w-full"
            >
              <div className="p-4 border-b border-zinc-800 flex items-center justify-between bg-black/40">
                <div>
                  <h3 className="text-sm font-bold uppercase tracking-tight">{previewPackage.name}</h3>
                  <p className="text-[10px] text-zinc-500 font-mono uppercase">Previewing Layout • Sheet {previewPackage.sheetIndex}/{previewPackage.totalSheets}</p>
                </div>
                <button 
                  onClick={closePreview}
                  className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-500 hover:text-white"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-6 flex items-center justify-center bg-[#0a0a0b] aspect-[31/47] max-h-[70vh] overflow-hidden">
                {isPreviewLoading ? (
                  <div className="flex flex-col items-center gap-4 text-zinc-600">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p className="text-[10px] font-mono uppercase tracking-widest">Generating Digital Proof...</p>
                  </div>
                ) : previewUrl ? (
                  <img src={previewUrl} alt="Collage Preview" className="max-w-full max-h-full object-contain shadow-2xl border border-zinc-800" />
                ) : null}
              </div>

              <div className="p-4 border-t border-zinc-800 bg-black/40 flex justify-end">
                <button 
                  onClick={closePreview}
                  className="px-6 py-2 bg-zinc-800 hover:bg-zinc-700 text-xs font-bold uppercase rounded transition-colors"
                >
                  Close
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
