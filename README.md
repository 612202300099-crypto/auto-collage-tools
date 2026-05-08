<div align="center">

# 🖨️ AutoCollage A3+

### Automated Polaroid Photo Collage Generator

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Private-red)](#)

**Generate print-ready A3+ polaroid collage sheets from local folders or ZIP files.**
**Batch process TikTok photo orders with AI face detection & Google Drive automation.**

---

[Features](#-features) · [Quick Start](#-quick-start) · [Architecture](#-architecture) · [Worker Setup](#-worker-automation-setup) · [Configuration](#-configuration)

</div>

---

## ✨ Features

### 🎨 Manual Collage Generator (Frontend)

| Feature | Description |
|---------|-------------|
| **📁 Folder Upload** | Select a local folder — auto-groups photos by subfolder |
| **📦 ZIP Upload** | Upload a `.zip` file — auto-extracts & groups by internal folders |
| **🖱️ Drag & Drop** | Drop folders or ZIP files directly into the app |
| **🤖 AI Face Detection** | Smart crop that centers faces in each polaroid frame |
| **📐 5×5 Grid Layout** | 25 polaroid photos per A3+ sheet (31×47cm, 350 DPI) |
| **🎯 Crop Marks** | Print-ready cut lines for professional trimming |
| **🏷️ Batch Color Tags** | Unique color identifier per batch to prevent mix-ups |
| **📄 PDF & PNG Export** | Multi-page PDF or individual PNG per sheet |
| **👁️ Live Preview** | Preview any sheet before exporting |

### 🤖 AI Engine Options

| Engine | Cost | Speed | Description |
|--------|------|-------|-------------|
| **OFF** | Free | — | No face detection, center-crop only |
| **STANDARD** | Free | Fast | Local GPU via face-api.js (SSD MobileNet) |
| **PREMIUM** | Paid | Smart | OpenAI GPT-4o-mini vision API |

### ⚙️ Worker Automation (Backend)

| Feature | Description |
|---------|-------------|
| **📂 Google Drive Scan** | Auto-scans Drive folders for new photo orders |
| **📊 Sheets Validation** | Cross-validates orders against Google Spreadsheet |
| **🖨️ Auto PDF Generation** | Server-side collage generation with Sharp image enhancement |
| **☁️ Auto Upload** | Uploads finished PDFs back to Google Drive |
| **✅ Auto Mark Done** | Marks processed orders in spreadsheet Column K |
| **🔄 Two-Phase Processing** | Phase 1 (DD-MM-YYYY) + Phase 2 (YYYY-MM-DD migration) |
| **📊 Dashboard** | Real-time web dashboard with stats, logs & controls |
| **🛡️ Anti-Duplicate** | Multi-layer protection (Drive check, lock, sheet status) |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** v18 or higher
- **npm** v9 or higher

### Frontend (Manual Collage)

```bash
# 1. Clone the repository
git clone https://github.com/612202300099-crypto/auto-collage-tools.git
cd auto-collage-tools

# 2. Install dependencies
npm install

# 3. Create environment file
cp .env.example .env

# 4. Start development server
npm run dev
```

Open **http://localhost:5173** — ready to use! No API keys needed for basic usage.

> **Optional:** For Premium AI face detection, add your `OPENAI_API_KEY` to `.env` and deploy the `/api/detect-face` endpoint on Vercel.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (React + Vite)                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────┐  ┌───────────┐ │
│  │ App.tsx   │→│collageGen.ts │→│ aiService  │→│ pdfExport │ │
│  │ (UI)     │  │ (Canvas)     │  │ (Face AI)  │  │ (jsPDF)   │ │
│  └──────────┘  └──────────────┘  └─────┬─────┘  └───────────┘ │
│       ↑                                │                        │
│  ┌──────────┐                    ┌─────┴─────┐                 │
│  │ zipExtr. │                    │ Local GPU │                 │
│  │ (fflate) │                    │ face-api  │                 │
│  └──────────┘                    └───────────┘                 │
├─────────────────────────────────────────────────────────────────┤
│                   Vercel Serverless API                         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  /api/detect-face  →  OpenAI GPT-4o-mini (Premium AI)     │ │
│  └────────────────────────────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│                   Worker Backend (Node.js)                      │
│  ┌────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Express │→│Orchestrator│→│PDF Engine│→│ Google Drive  │  │
│  │Dashboard│  │ (Scan Loop)│  │ (Canvas) │  │ Google Sheets │  │
│  └────────┘  └────────────┘  └──────────┘  └───────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📁 Folder Structure

```
auto-collage-tools/
│
├── src/                          # Frontend (React)
│   ├── App.tsx                   # Main UI component
│   ├── main.tsx                  # React entry point
│   ├── index.css                 # Global styles + Tailwind
│   └── utils/
│       ├── collageGenerator.ts   # Canvas-based collage builder
│       ├── aiService.ts          # Hybrid AI face detection
│       ├── pdfExporter.ts        # PDF export with jsPDF
│       ├── zipExtractor.ts       # ZIP extraction with fflate
│       ├── colorUtils.ts         # Batch color generation
│       └── yieldToMain.ts        # Main thread yielding utility
│
├── api/                          # Vercel Serverless Functions
│   └── detect-face.ts            # OpenAI GPT-4o-mini face detection
│
├── worker/                       # Automation Backend
│   ├── index.ts                  # Entry point
│   ├── server.ts                 # Express API server
│   ├── auth.ts                   # OAuth 2.0 token generator
│   ├── config.ts                 # Environment configuration
│   ├── types.ts                  # Shared TypeScript types
│   ├── core/
│   │   ├── orchestrator.ts       # Main automation loop
│   │   ├── stateManager.ts       # Worker state management
│   │   ├── workerPool.ts         # Concurrent task execution
│   │   └── colorUtils.ts         # Server-side color utils
│   ├── engine/
│   │   ├── collageEngine.ts      # Server-side canvas (node-canvas)
│   │   └── pdfEngine.ts          # Server-side PDF generation
│   ├── services/
│   │   ├── googleAuth.ts         # Google OAuth 2.0 client
│   │   ├── driveService.ts       # Google Drive operations
│   │   └── sheetsService.ts      # Google Sheets operations
│   ├── utils/
│   │   ├── folderParser.ts       # Folder name parsing & date utils
│   │   └── logger.ts             # Structured logging
│   └── dashboard/
│       └── index.html            # Worker monitoring dashboard
│
├── public/models/                # Face detection ML models
├── .env.example                  # Environment variable template
├── vercel.json                   # Vercel deployment config
├── vite.config.ts                # Vite build config
├── tsconfig.json                 # TypeScript config
└── package.json                  # Dependencies & scripts
```

---

## ⚙️ Worker Automation Setup

The worker is a standalone Node.js process that automates the entire collage pipeline via Google Drive & Sheets.

### 1. Google Cloud Setup

```bash
# Create a project at https://console.cloud.google.com
# Enable these APIs:
#   - Google Drive API
#   - Google Sheets API
# Create OAuth 2.0 Client ID (Desktop Application)
# Download the credentials JSON file
```

### 2. Place Credentials

```bash
mkdir credentials
# Save the downloaded JSON as:
cp ~/Downloads/client_secret_*.json credentials/credentials.json
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Add these variables to your `.env`:

```env
# Google Drive root folder containing date folders
DRIVE_ROOT_FOLDER_ID="your-drive-folder-id"

# Google Spreadsheet ID (from the URL)
SPREADSHEET_ID="your-spreadsheet-id"

# Sheet names
SHEET_NAME="FOTO POLAROID"
EKSPORT_SHEET_NAME="EKSPORT"

# Worker settings
POLL_INTERVAL_MINUTES=5
MAX_CONCURRENCY=5
WORKER_PORT=4000

# Optional: Secondary Drive folder for backup copies
# SECONDARY_DRIVE_FOLDER_ID=""

# Optional: Filter to specific date (DD-MM-YYYY or ALL)
# TARGET_DATE_FILTER="ALL"
```

### 4. Authenticate

```bash
npm run worker:auth
# Opens a URL → Login with Google → Paste the code back
# Token saved to credentials/token.json
```

### 5. Run the Worker

```bash
# Start with dashboard (manual control)
npm run worker

# Start with auto-processing
npm run worker:auto

# Dry run (no uploads/writes)
npm run worker:dry
```

Open **http://localhost:4000** for the monitoring dashboard.

---

## 📜 Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start frontend dev server (port 5173) |
| `npm run build` | Build frontend for production |
| `npm run preview` | Preview production build locally |
| `npm run lint` | TypeScript type checking |
| `npm run worker` | Start worker with dashboard |
| `npm run worker:auto` | Start worker + auto-begin processing |
| `npm run worker:dry` | Dry run mode (no mutations) |
| `npm run worker:auth` | Generate Google OAuth token |

---

## 🔧 Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | No | — | Gemini AI API key (AI Studio) |
| `OPENAI_API_KEY` | No | — | OpenAI key for Premium face detection |
| `GOOGLE_CLIENT_ID` | No | — | OAuth client ID (for Vercel deployment) |
| `GOOGLE_CLIENT_SECRET` | No | — | OAuth client secret (for Vercel deployment) |
| `DRIVE_ROOT_FOLDER_ID` | Worker | — | Google Drive root folder ID |
| `SPREADSHEET_ID` | Worker | — | Google Spreadsheet ID |
| `SHEET_NAME` | Worker | `FOTO POLAROID` | Primary sheet name |
| `EKSPORT_SHEET_NAME` | Worker | `EKSPORT` | Export sheet name |
| `POLL_INTERVAL_MINUTES` | Worker | `5` | Scan interval (1–60 min) |
| `MAX_CONCURRENCY` | Worker | `5` | Parallel jobs (1–20) |
| `WORKER_PORT` | Worker | `4000` | Dashboard port |
| `ENABLE_FACE_DETECTION` | Worker | `true` | Enable server-side face detection |
| `DRY_RUN` | Worker | `false` | No uploads/writes when true |

---

## 🛡️ Anti-Duplicate Protection

The worker uses **6 layers** of duplicate prevention:

| Layer | Check | Stage |
|-------|-------|-------|
| L1 | PDF already exists in Drive folder | Pre-process |
| L2 | In-memory lock per resi number | Pre-process |
| L3 | Column K already marked "done" | Validation |
| L4 | Order status = "DIBATALKAN" | Validation |
| L5 | Variant mismatch (folder vs sheet) | Validation |
| L6 | Image count ≠ expected variant | Validation |

---

## 🎨 Collage Specifications

| Spec | Value |
|------|-------|
| **Paper Size** | A3+ (31 × 47 cm) |
| **Resolution** | 350 DPI (4271 × 6477 px) |
| **Grid** | 5 × 5 (25 photos per sheet) |
| **Photo Size** | 6 × 9 cm per polaroid |
| **Frame** | White border with bottom padding |
| **Enhancement** | Brightness +5%, Saturation +20%, Contrast +10% |
| **Output** | PDF (multi-page) or PNG (per sheet) |

---

## 📄 Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, TypeScript 5.8, Vite 6 |
| **Styling** | Tailwind CSS 4, Lucide Icons, Framer Motion |
| **AI (Local)** | face-api.js (SSD MobileNet v1) |
| **AI (Premium)** | OpenAI GPT-4o-mini Vision |
| **PDF** | jsPDF |
| **ZIP** | fflate |
| **HEIC** | heic2any |
| **Backend** | Node.js, Express 5, tsx |
| **Canvas** | Browser Canvas API + node-canvas + Sharp |
| **Google APIs** | googleapis (Drive v3, Sheets v4) |
| **Deployment** | Vercel (frontend + API), Local (worker) |

---

<div align="center">

**Built with ❤️ for the polaroid printing business**

*AutoCollage A3+ — From photos to print-ready collages in seconds.*

</div>
