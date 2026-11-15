# AI HQ

Dashboard untuk mengelola "karyawan AI": tambah karyawan (agen OpenAI atau Claude), beri tugas, pantau hasil, token, dan estimasi biaya. Tanpa dependensi npm, hanya Node 18+.

## Deploy ke Render

1. Buat repo GitHub baru, lalu push folder ini:
   ```bash
   git init && git add . && git commit -m "AI HQ"
   git branch -M main
   git remote add origin https://github.com/USERNAME/ai-hq.git
   git push -u origin main
   ```
2. Di Render: **New → Blueprint** (atau **Web Service**) lalu pilih repo tadi. `render.yaml` sudah mengatur semuanya.
3. Isi Environment:
   - `ADMIN_PASSWORD` (wajib, password login dashboard)
   - `ANTHROPIC_API_KEY` dan/atau `OPENAI_API_KEY`
4. Deploy, lalu buka URL Render dan login.

Tanpa `ADMIN_PASSWORD`, API sengaja terkunci supaya orang lain tidak bisa memakai kunci API Anda.

## Catatan penting

- **Penyimpanan**: data disimpan di `data/state.json`. Di plan gratis Render, disk bersifat sementara, jadi data hilang saat redeploy. Untuk data permanen, pakai plan berbayar + Disk (lihat komentar di `render.yaml`) dan set `DATA_DIR=/var/data`.
- **Plan gratis** akan tidur saat tidak dipakai; tugas yang sedang berjalan bisa terputus dan ditandai gagal.
- **Harga/biaya**: isi harga per 1 juta token di form karyawan sesuai halaman harga provider. Estimasi biaya dihitung dari angka itu.
- **Nama model** bisa diubah bebas di form karyawan.

## Uji lokal

```bash
cp .env.example .env   # lalu isi nilainya
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Struktur

- `server.js` — API, login, penyimpanan, adapter OpenAI/Anthropic
- `public/index.html` — tampilan dashboard
- `render.yaml` — konfigurasi Render

## Pengembangan lanjutan

Setiap tugas saat ini satu giliran (sekali kirim, sekali jawab). Untuk agen yang memakai tool/riwayat percakapan, tambahkan di `callProvider()` pada `server.js`.
