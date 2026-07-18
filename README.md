<div align="center">

# 🖨️ AutoCollage A3+ (Sistem Kolase Foto Otomatis)

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org)

**Mengubah ribuan foto pelanggan menjadi lembaran PDF siap cetak (Ukuran A3+) secara instan dan otomatis!**
*Sangat cocok untuk bisnis cetak foto Polaroid, Gantungan Kunci, atau Stiker dengan pesanan massal dari TikTok Shop/Shopee.*

---

</div>

## 💡 Apa Itu Aplikasi Ini? (Untuk Orang Awam)
Jika Anda memiliki bisnis cetak foto, memindahkan dan menyusun foto pelanggan satu per satu ke dalam ukuran A3 sangatlah memakan waktu. 

Aplikasi ini adalah **Asisten Pintar** Anda. Aplikasi ini punya dua fungsi:
1. **Mode Manual (Aplikasi Web):** Anda cukup *drag & drop* (geser) folder berisi foto pelanggan ke layar, dan sistem akan langsung menatanya menjadi 25 kotak rapi (layout 5x5) per lembar A3+, lengkap dengan garis potong dan deteksi wajah agar tidak terpotong.
2. **Mode Robot Otomatis 24/7 (Worker):** Ini adalah jantung utamanya! Robot ini akan berjalan sendiri memantau **Google Drive** Anda. Jika ada pesanan baru masuk dari *WhatsApp Bot*, robot ini akan otomatis mencocokkannya dengan data pesanan di **Google Sheets**, mendownload fotonya, menjadikannya PDF, meng-uploadnya kembali ke Drive untuk dicetak, lalu menceklis statusnya di Sheets menjadi "SELESAI". Anda tinggal rebahan!

---

## 🚀 Status Pengembangan Saat Ini (Current State)
Saat ini sistem **sudah selesai 100% dan stabil (Production Ready)** dengan mengusung versi 2.1 (Arsitektur Multi-Toko).
- **Frontend** (Aplikasi Web) sudah memiliki antarmuka yang modern (menggunakan React + Vite + Tailwind 4) dan bisa mendeteksi wajah secara pintar menggunakan *AI Hybrid* (Lokal maupun OpenAI).
- **Backend Worker** sudah tangguh dan memiliki *Dashboard Web* mini (berjalan di port 4000) untuk memantau mesin secara *real-time*. 
- **Database Lokal** (SQLite) sudah tertanam untuk mencegah mesin mencetak dua kali meski server *restart/mati lampu*.

---

## 🏗️ Bagaimana Cara Kerja Mesin Robotnya? (Alur Sistem)

1. **Memantau Toko (Orchestrator):** Mesin akan memindai Google Drive dari banyak toko (Misal: Toko Ventura, Giftyours) yang sudah disetel di `.env`. 
2. **Verifikasi Pesanan:** Jika menemukan folder foto (misal: "JX12345_25 Pcs"), mesin akan mengecek **Google Sheets** di baris resi `JX12345`.
3. **Menunggu Lengkap (Stale Check):** Jika pelanggan baru kirim 20 foto padahal pesanannya 25 Pcs, mesin akan menunda proses cetak (menunggu pelanggan melengkapi). Namun, jika sudah berhari-hari dibiarkan *(stale)*, mesin akan otomatis menduplikat 5 foto acak agar kertas tidak mubazir kosong.
4. **Desain & Cetak (PDF Engine):** Mesin mengunduh foto, memoles tingkat kecerahan (+5%), kontras (+10%), saturasi (+20%), dan menyusunnya di kanvas berukuran A3+ (31x47cm, ketajaman tinggi 350 DPI).
5. **Upload & Konfirmasi:** PDF hasil cetak diunggah kembali ke Drive, dan kolom `Status` di Sheets otomatis diubah menjadi `SELESAI` serta ditandai `DONE` oleh bot.

---

## ⚠️ CATATAN PENTING UNTUK DEVELOPER (Bugs, Limitasi, & Tech Debt)

Untuk *developer* atau pemrogram yang akan melanjutkan sistem ini, mohon baca bagian ini dengan sangat teliti. Ini adalah hal-hal yang rawan *error* di *production*:

### 1. Kaku pada Kolom Google Sheets (Hardcoded Columns)
*File: `worker/services/sheetsService.ts` (Baris 188-192)*
- Sistem membaca kolom secara **hardcoded** menggunakan index (Kolom A = Tanggal, Kolom B = Resi, Kolom G = Variasi, Kolom H = QTY, Kolom J = Status Transaksi).
- **BAHAYA:** Jika admin toko **menyisipkan (insert)** atau **menggeser** kolom-kolom ini di Google Sheets, seluruh sistem otomatis akan hancur dan gagal membaca data. Anda harus mengedukasi admin toko untuk *tidak pernah merombak* urutan kolom A sampai J. (Kolom setelah J seperti "DIKERJAKAN BOT" sudah dideteksi secara otomatis/dinamis).

### 2. Isu Caching Google Sheets (Stale Cache)
*File: `worker/services/sheetsService.ts` (Baris 29)*
- Agar tidak terkena *Rate Limit* (Google membatasi tarikan data bertubi-tubi), mesin ini menyimpan (*cache*) data sheets selama **2 menit** (`CACHE_TTL_MS = 120_000`). 
- **EFEK SAMPING:** Jika ada admin manusia yang mengubah data di Sheets secara manual, robot baru akan "sadar" terhadap perubahan tersebut 2 menit kemudian.

### 3. Akurasi Deteksi Wajah AI
*File: `src/utils/aiService.ts`*
- **Mode Lokal (`face-api.js`):** Sangat cepat dan gratis, tapi **kurang cerdas**. AI lokal sulit mendeteksi wajah jika posisinya miring ekstrim, fotonya gelap, atau wajahnya sangat kecil (beramai-ramai dari jauh).
- **Mode Premium (`OpenAI GPT-4o-mini`):** Sangat pintar, tapi **berbayar** (butuh `OPENAI_API_KEY`) dan lebih lambat karena foto harus dikirim ke server OpenAI (terikat *limit internet/API*).

### 4. Ancaman RAM Penuh (Memory Leak / OOM)
*File: `worker/engine/pdfEngine.ts`*
- *Rendering* file PDF berukuran A3+ dengan resolusi tinggi (350 DPI) sangat menguras memori (RAM). Jika Anda menyetel `MAX_CONCURRENCY` di atas 5 (menjalankan 5 proses rendering secara bersamaan), server VPS berkapasitas RAM 2GB bisa dipastikan akan mati lemas (*Out of Memory / Crash*).
- Sangat disarankan untuk membatasi `MAX_CONCURRENCY=3` jika server VPS Anda tidak memiliki RAM besar.

### 5. Pelindung Anti-Duplikat Berlapis
*File: `worker/core/orchestrator.ts`*
- Karena proses cetak melibatkan biaya kertas dan tinta asli, mesin ini punya **6 Lapis Pelindung** agar 1 Resi tidak dicetak 2x. Termasuk `worker.db` (SQLite) yang mengingat selamanya.
- **TIPS DEV:** Jika tim produksi komplain "Kok pesanan ini gak mau diproses robot?", cek *Dashboard Bot* di port 4000, lalu gunakan fitur **Hapus Data Resi** dari database agar mesin bisa memproses ulang pesanan tersebut.

---

## 🛠️ Panduan Instalasi (Untuk Admin/Operator)

### Syarat Wajib:
- Node.js versi 18 ke atas.
- *Google Cloud OAuth Client ID* (File `credentials.json`).

### Langkah-langkah:
1. **Clone dan Install**
   Buka terminal / Command Prompt:
   ```bash
   git clone https://github.com/612202300099-crypto/auto-collage-tools.git
   cd auto-collage-tools
   npm install
   cp .env.example .env
   ```

2. **Isi Konfigurasi (`.env`)**
   Buka file `.env`. Anda WAJIB mengisi:
   - `DRIVE_ROOT_FOLDER_ID="ID-FOLDER-DRIVE-UTAMA"`
   - `SHOPS='[{"name":"Ventura","spreadsheetId":"ID-SHEETS-NYA"}]'` *(Format penulisan harus berupa JSON Array agar bisa banyak toko)*

3. **Login ke Google (Hanya 1x Seumur Hidup)**
   ```bash
   npm run worker:auth
   ```
   *Terminal akan memunculkan link. Buka di Chrome, login akun Google, berikan izin, lalu copy kode rahasianya kembali ke terminal.*

---

## 🚀 Cara Menjalankan

### A. Untuk Mode Manual (Buka Web Frontend)
Cocok jika admin ingin menata foto secara mandiri (*drag and drop*).
```bash
npm run dev
```
Buka browser dan ketik: `http://localhost:5173`.

### B. Untuk Mode Robot Otomatis
Ini yang akan berjalan nonstop di server.
```bash
# Menyalakan robot dan menahan layar agar tidak tertutup otomatis (Auto Run)
npm run worker:auto
```
Anda bisa memantau pergerakan mesin, kecepatan proses, dan tombol kendali manual lewat **Dashboard Robot** dengan membuka browser dan masuk ke: `http://localhost:4000`.

---
<div align="center">
<i>Sistem asisten produksi andalan bisnis Polaroid masa kini.</i>
</div>
