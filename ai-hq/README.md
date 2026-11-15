# AI HQ

Dashboard untuk mengelola "karyawan AI": tambah karyawan (agen OpenAI atau Claude), beri tugas, pantau hasil, token, dan estimasi biaya. Tanpa dependensi npm, hanya Node 18+.

## Deploy ke Render

1. Push project ini ke repo GitHub. Kalau project berada di dalam subfolder repo, isi **Root Directory** di Render dengan nama folder itu.
2. Di Render buat **Web Service** dari repo tadi:
   - Build Command: `npm install`
   - Start Command: `npm start`
3. Isi Environment (lihat tabel di bawah), lalu deploy.

| Key | Isi | Wajib? |
|---|---|---|
| `ADMIN_PASSWORD` | Password login dashboard | Wajib |
| `ANTHROPIC_API_KEY` | Kunci API Claude | Kalau ada karyawan Claude |
| `OPENAI_API_KEY` | Kunci API OpenAI | Kalau ada karyawan OpenAI |
| `SUPABASE_URL` | Project URL Supabase | Disarankan |
| `SUPABASE_SERVICE_KEY` | Kunci rahasia Supabase | Disarankan |

Tanpa `ADMIN_PASSWORD`, API sengaja terkunci supaya orang lain tidak bisa memakai kunci API Anda.

## Penyimpanan permanen dengan Supabase

Tanpa Supabase, data (karyawan, tugas, log) disimpan di file di server Render. Di plan gratis, file itu hilang setiap redeploy atau restart. Dengan Supabase, data tersimpan di database dan tetap ada.

1. Buat project di [supabase.com](https://supabase.com).
2. Buka **SQL Editor → New query**, tempel isi `supabase/schema.sql`, klik **Run**.
3. Ambil dua nilai dari **Project Settings → API** (atau **API Keys**):
   - **Project URL** → isi ke `SUPABASE_URL`
   - **Secret key** (atau `service_role` pada tampilan lama) → isi ke `SUPABASE_SERVICE_KEY`
4. Simpan di Environment Render dan tunggu deploy ulang.
5. Buka dashboard: di tab Ringkasan, "Penyimpanan data" harus menunjukkan **Supabase terhubung**.

Penting:
- Pakai kunci **rahasia**, bukan `anon`/`publishable`. Kunci ini hanya boleh ada di Environment Render, jangan di GitHub atau di browser.
- Tabel dilindungi RLS tanpa policy, jadi kunci publik tidak bisa membaca datanya. Hanya server ini yang bisa.
- Kalau Supabase salah konfigurasi saat start, server berhenti dengan pesan error di Logs (bukan diam-diam jalan dengan data kosong).
- Data lama di file lokal tidak dipindahkan otomatis.

## Catatan lain

- **Plan gratis Render** akan tidur saat tidak dipakai; tugas yang sedang berjalan bisa terputus dan ditandai gagal.
- **Biaya**: isi harga per 1 juta token di form karyawan sesuai halaman harga provider. Estimasi dihitung dari angka itu.
- **Nama model** bisa diubah bebas di form karyawan.

## Uji lokal

```bash
cp .env.example .env   # lalu isi nilainya
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Struktur

- `server.js`: API, login, penyimpanan (Supabase/file), adapter OpenAI/Anthropic
- `public/index.html`: tampilan dashboard
- `supabase/schema.sql`: tabel database
- `render.yaml`: konfigurasi Render (opsional)

## Pengembangan lanjutan

Setiap tugas saat ini satu giliran (sekali kirim, sekali jawab). Untuk agen yang memakai tool atau riwayat percakapan, tambahkan di `callProvider()` pada `server.js`.
